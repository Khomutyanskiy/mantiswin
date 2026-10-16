fn main() {
    // Команды приложения, доступные странице Mantis (она открыта с http://localhost — см. capabilities/default.json)
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["app_info", "keep_awake", "set_autostart", "pilot_state", "quit_app"]),
    ))
    .expect("tauri-build");
}
