// Mantis для Windows: окно (WebView2) + встроенный агент.
//
// Агент — та же программа, что «Mantis Агент» из web/agent (Bun): отдаёт страницу Mantis с нейросетью,
// мост IP-камер (поиск ONVIF, RTSP → кадры через ffmpeg) на http://localhost. Приложение запускает его
// скрытым, ждёт строку «MANTIS_READY port=N» и открывает страницу в своём окне с ?desktop=windows —
// тогда вкладка «Пилот» работает с несколькими камерами, как на Mac.
//
// Что делает само приложение:
//   • камера разрешается странице без вопросов (WebView2 PermissionRequested);
//   • компьютер и экран не засыпают, пока идёт пилот;
//   • автозапуск при входе в Windows; один экземпляр; значок в трее;
//   • окно с идущим пилотом при закрытии прячется в трей, подсчёт продолжается;
//   • уведомления Windows (камера пропала, расписание, толпа) и значок в трее с состоянием мониторинга
//     и пунктами «Запустить / Остановить мониторинг», «Отчёт последнего запуска» (как строка меню на Mac).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

/// Порт страницы. Постоянный: от адреса зависят настройки камер и вход в аккаунт (хранятся по адресу страницы).
const BASE_PORT: u16 = 8797;

struct AppState {
    agent: Mutex<Option<Child>>,
    pilot_running: AtomicBool,
    keep_awake: Arc<AtomicBool>,
    /// Не гасить и экран (настройка «Не гасить экран во время мониторинга»).
    keep_display: Arc<AtomicBool>,
    quitting: AtomicBool,
}

/// Состояние для значка в трее — присылает страница раз в пару секунд (только при изменении).
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TrayStatus {
    running: bool,
    title: String,
    #[serde(default)]
    lines: Vec<String>,
    #[serde(default)]
    people: i64,
    #[serde(default)]
    can_start: bool,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    hostname: String,
    autostart: bool,
}

// ---------------------------------------------------------------- команды для страницы

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        hostname: std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
fn keep_awake(state: State<'_, AppState>, on: bool, display: Option<bool>) {
    state.keep_display.store(display.unwrap_or(true), Ordering::SeqCst);
    state.keep_awake.store(on, Ordering::SeqCst);
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
fn tray_status(app: AppHandle, status: TrayStatus) -> Result<(), String> {
    update_tray(&app, &status).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn pilot_state(state: State<'_, AppState>, running: bool) {
    state.pilot_running.store(running, Ordering::SeqCst);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    request_quit(&app);
}

// ---------------------------------------------------------------- агент

fn agent_path() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) { "mantis-agent.exe" } else { "mantis-agent" };
    let p = dir.join(name);
    p.exists().then_some(p)
}

fn splash_error(app: &AppHandle, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.mantisSplashError && window.mantisSplashError({})", serde_json_string(msg));
        let _ = w.eval(&js);
    }
}

/// Строка для JS без serde_json: кавычки и переводы строк экранируются.
fn serde_json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn start_agent(app: &AppHandle) {
    let Some(path) = agent_path() else {
        splash_error(app, "Не найден mantis-agent.exe рядом с программой. Переустановите Mantis.");
        return;
    };
    let mut cmd = Command::new(&path);
    cmd.arg("--no-browser")
        .env("MANTIS_SHELL", "windows")
        .env("MANTIS_PORT", BASE_PORT.to_string())
        .env("MANTIS_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            splash_error(app, &format!("Не запустился встроенный агент: {e}"));
            return;
        }
    };
    let stdout = child.stdout.take();
    *app.state::<AppState>().agent.lock().unwrap() = Some(child);

    let ready = Arc::new(AtomicBool::new(false));
    // Читаем вывод агента: ждём адрес страницы, дальше просто вычитываем (иначе агент встанет на записи в журнал)
    if let Some(out) = stdout {
        let app = app.clone();
        let ready = ready.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if ready.load(Ordering::SeqCst) {
                    continue;
                }
                if let Some(port) = line.trim().strip_prefix("MANTIS_READY port=").and_then(|p| p.trim().parse::<u16>().ok()) {
                    ready.store(true, Ordering::SeqCst);
                    open_page(&app, port);
                }
            }
            if !ready.load(Ordering::SeqCst) && !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                splash_error(&app, "Встроенный агент завершился. Журнал: %LOCALAPPDATA%\\Mantis Agent\\agent.log");
            }
        });
    }
    // Сторож: агент не ответил за минуту
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        if !ready.load(Ordering::SeqCst) {
            splash_error(&app2, "Агент не ответил за минуту. Журнал: %LOCALAPPDATA%\\Mantis Agent\\agent.log");
        }
    });
}

fn open_page(app: &AppHandle, port: u16) {
    let Some(w) = app.get_webview_window("main") else { return };
    match Url::parse(&format!("http://localhost:{port}/?desktop=windows")) {
        Ok(url) => {
            if let Err(e) = w.navigate(url) {
                splash_error(app, &format!("Не открылась страница: {e}"));
            }
        }
        Err(e) => splash_error(app, &format!("Неверный адрес страницы: {e}")),
    }
}

fn stop_agent(app: &AppHandle) {
    if let Some(mut child) = app.state::<AppState>().agent.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ---------------------------------------------------------------- выход, окно, трей

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Выход: страница досчитывает и сохраняет итоги (пилот продолжится при следующем запуске), затем закрываемся.
fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("window.__mantisQuit && window.__mantisQuit()");
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        stop_agent(&app);
        app.exit(0);
    });
}

/// Пока идёт мониторинг, Windows не уводит компьютер в сон (сброс таймера бездействия раз в 30 с);
/// экран не гаснет, только если так выбрано в настройках.
fn keep_awake_loop(flag: Arc<AtomicBool>, display: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        if flag.load(Ordering::SeqCst) {
            let _with_display = display.load(Ordering::SeqCst);
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
                SetThreadExecutionState(if _with_display { ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED } else { ES_SYSTEM_REQUIRED });
            }
        }
        std::thread::sleep(Duration::from_secs(30));
    });
}

/// Камеру странице — без запроса: приложение только для этого и нужно, а вопрос WebView2 после перезапуска
/// остановил бы пилот у витрины, где рядом никого нет.
#[cfg(windows)]
fn allow_camera(window: &WebviewWindow) {
    let _ = window.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        };
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

#[cfg(not(windows))]
fn allow_camera(_window: &WebviewWindow) {}

/// Меню значка: состояние мониторинга, строки (люди на плане, камеры, расписание), запуск / остановка, отчёт.
fn tray_menu(app: &AppHandle, s: &TrayStatus) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    if !s.title.is_empty() {
        menu.append(&MenuItem::with_id(app, "title", &s.title, false, None::<&str>)?)?;
        for (i, line) in s.lines.iter().enumerate() {
            menu.append(&MenuItem::with_id(app, format!("line{i}"), line, false, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        if s.running {
            menu.append(&MenuItem::with_id(app, "stop", "Остановить мониторинг", true, None::<&str>)?)?;
        } else {
            menu.append(&MenuItem::with_id(app, "start", "Запустить мониторинг", s.can_start, None::<&str>)?)?;
        }
        menu.append(&MenuItem::with_id(app, "report", "Отчёт последнего запуска", true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "open", "Открыть Mantis", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?)?;
    Ok(menu)
}

fn update_tray(app: &AppHandle, s: &TrayStatus) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("main") else { return Ok(()) };
    tray.set_menu(Some(tray_menu(app, s)?))?;
    let mut tip = if s.running {
        format!("Mantis — мониторинг идёт · сейчас {} чел.", s.people)
    } else {
        "Mantis — мониторинг остановлен".to_string()
    };
    if let Some(first) = s.lines.first() {
        tip.push('\n');
        tip.push_str(first);
    }
    // у подсказки значка Windows предел — 127 символов
    let tip: String = tip.chars().take(120).collect();
    tray.set_tooltip(Some(tip))?;
    Ok(())
}

/// Команда из меню значка — странице (window.__mantisTray).
fn tray_command(app: &AppHandle, cmd: &str) {
    if cmd == "report" {
        show_main(app);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.__mantisTray && window.__mantisTray({})", serde_json_string(cmd)));
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, &TrayStatus::default())?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Mantis — подсчёт посетителей")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quit" => request_quit(app),
            cmd @ ("start" | "stop" | "report") => tray_command(app, cmd),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    let keep = Arc::new(AtomicBool::new(false));
    let keep_display = Arc::new(AtomicBool::new(true));
    keep_awake_loop(keep.clone(), keep_display.clone());

    let app = tauri::Builder::default()
        // второй запуск (ярлык, автозапуск) — просто показать уже открытое окно
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(AppState {
            agent: Mutex::new(None),
            pilot_running: AtomicBool::new(false),
            keep_awake: keep,
            keep_display,
            quitting: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![app_info, keep_awake, set_autostart, pilot_state, quit_app, notify, tray_status])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                allow_camera(&w);
            }
            build_tray(app.handle())?;
            start_agent(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                if state.pilot_running.load(Ordering::SeqCst) {
                    // идёт пилот — окно в трей, подсчёт продолжается
                    let _ = window.hide();
                } else {
                    request_quit(app);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Mantis: не удалось запустить приложение");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_agent(app);
        }
    });
}
