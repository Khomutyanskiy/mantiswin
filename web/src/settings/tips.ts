// Подсказка сверху экрана — порт ScreenTips.swift: коротко — что здесь и с чего начать.
// Крестик прячет подсказку этого экрана (запоминается в tips.hidden), «Подробнее» — открывает справку.

import { type HelpTopic, openHelp } from "../ui/help";
import { prefStr, setPref } from "./prefs";

interface Tip {
  icon: string;
  text: string;
  steps: string[];
  topic?: HelpTopic;
}

const TIPS: Record<string, Tip> = {
  cameras: { icon: "■", text: "Камеры — откуда Mantis считает людей.", steps: ["«Добавить камеру»", "«Разметка» — зона у витрины", "«Привязать» — место на плане", "«Запустить мониторинг»"], topic: "cameras" },
  plan: { icon: "▦", text: "План точки — на нём люди с камер становятся точками.", steps: ["Размеры помещения", "Магазин, витрины, входы", "Зоны, которые важно считать"], topic: "plan" },
  monitor: { icon: "◉", text: "Живой план: люди с камер в реальном времени, справа — цифры.", steps: ["«Запустить мониторинг» сверху", "Смотрите план и камеры", "«Остановить» — отчёт сохранится сам"], topic: "monitoring" },
  online: { icon: "◎", text: "Двойник точки из облака — с этого компьютера, iPhone или Mac.", steps: ["Войдите в аккаунт", "Выберите точку", "Смотрите людей на плане"], topic: "twin" },
  video: { icon: "▶", text: "Разбор записанного видео — без подключения камер.", steps: ["Выберите видео", "Отметьте зону у витрины", "Получите цифры и тепловую карту"], topic: "analysis" },
  "stats.last": { icon: "◷", text: "Итоги последнего запуска мониторинга: цифры, камеры, двойник и видео.", steps: ["Запустите и остановите мониторинг", "Смотрите итоги здесь", "«Скачать PDF» — для клиента"], topic: "stats" },
  "stats.reports": { icon: "≡", text: "Все отчёты: каждый запуск мониторинга, анализ видео и быстрый показ.", steps: ["Фильтры сверху", "«Выбрать» — удалить несколько", "«Сводка» — сложить отчёты в один"], topic: "stats" },
  records: { icon: "◇", text: "Записи цифрового двойника: как люди двигались по плану.", steps: ["С мониторинга — пишутся сами", "Демо и видео — кнопкой «Сохранить двойника»", "Выберите запись слева"], topic: "twin" },
  "stats.hours": { icon: "▮", text: "Статистика за всё время по часам и дням недели — час пик и лучший день.", steps: ["Выберите период", "Выберите показатель", "Сравните камеры"], topic: "stats" },
  demo: { icon: "✦", text: "Демо: как работает Mantis без камер — виртуальные покупатели на плане.", steps: ["Нарисуйте план", "«Запустить демо»", "Смотрите цифры и двойника"], topic: "start" },
  sites: { icon: "⌖", text: "Все ваши точки вживую — с любого устройства.", steps: ["Войдите в аккаунт", "Выберите точку", "Смотрите камеры и цифры"], topic: "stats" },
  settings: { icon: "⚙", text: "Видео, расписание мониторинга, уведомления и оформление.", steps: ["Сколько хранить видео", "Расписание по часам работы", "Уведомления о камерах"], topic: "monitoring" },
};

const hidden = (): Set<string> => new Set(prefStr("tips.hidden", "").split(",").filter(Boolean));

function setHidden(key: string, on: boolean): void {
  const h = hidden();
  if (on) h.add(key);
  else h.delete(key);
  setPref("tips.hidden", [...h].sort().join(","));
}

const bars: (() => void)[] = [];

export function resetTips(): void {
  setPref("tips.hidden", "");
  for (const r of bars) r();
}

/** Полоса подсказки в host. set(key) — показать подсказку экрана (null — убрать). */
export function mountTipBar(host: HTMLElement): { set(key: string | null): void } {
  let key: string | null = null;
  const render = () => {
    host.replaceChildren();
    const tip = key ? TIPS[key] : undefined;
    host.hidden = !tip;
    if (!tip || !key) return;
    const k = key;
    if (hidden().has(k)) {
      host.className = "tip-bar folded";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = "💡 Подсказка";
      b.addEventListener("click", () => {
        setHidden(k, false);
        render();
      });
      host.append(b);
      return;
    }
    host.className = "tip-bar";
    const ico = document.createElement("span");
    ico.className = "tip-ico";
    ico.textContent = tip.icon;
    const body = document.createElement("div");
    body.className = "tip-body";
    const t = document.createElement("b");
    t.textContent = tip.text;
    const steps = document.createElement("ol");
    for (const s of tip.steps) {
      const li = document.createElement("li");
      li.textContent = s;
      steps.append(li);
    }
    body.append(t, steps);
    host.append(ico, body);
    if (tip.topic) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "btn small ghost";
      more.textContent = "Подробнее";
      const topic = tip.topic;
      more.addEventListener("click", () => openHelp(topic));
      host.append(more);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tip-x";
    x.title = "Скрыть подсказку этого экрана";
    x.textContent = "×";
    x.addEventListener("click", () => {
      setHidden(k, true);
      render();
    });
    host.append(x);
  };
  bars.push(render);
  return {
    set(k) {
      if (k === key) return;
      key = k;
      render();
    },
  };
}
