// Плавающее окно: заголовок (перетаскивание), ручка размера, «развернуть» и «закрыть».
// Двигается по всему окну приложения (не только над планом). Как FloatingWindow / FloatingVideoPanel в Mantis для Mac.
// area — где окно появляется в первый раз (план).

export interface Floating {
  root: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  accessory: HTMLElement;
  setVisible(on: boolean): void;
}

export function floatingWindow(area: HTMLElement, o: { title: string; icon: string; width: number; height: number; onClose: () => void }): Floating {
  const root = document.createElement("div");
  root.className = "tw-float";
  root.hidden = true;
  const head = document.createElement("div");
  head.className = "tw-float-head";
  const icon = document.createElement("span");
  icon.className = "tw-float-icon";
  icon.textContent = o.icon;
  const title = document.createElement("b");
  title.textContent = o.title;
  const accessory = document.createElement("span");
  accessory.className = "tw-float-acc";
  const grow = document.createElement("span");
  grow.className = "grow";
  const btn = (t: string, label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tw-float-btn";
    b.textContent = t;
    b.title = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  let expanded = false;
  const expandBtn = btn("⤢", "Развернуть", () => {
    expanded = !expanded;
    expandBtn.title = expanded ? "Уменьшить" : "Развернуть";
    layout();
  });
  head.append(icon, title, grow, accessory, expandBtn, btn("✕", "Закрыть", o.onClose));
  const body = document.createElement("div");
  body.className = "tw-float-body";
  const grip = document.createElement("div");
  grip.className = "tw-float-grip";
  grip.title = "Потяните, чтобы изменить размер";
  root.append(head, body, grip);
  document.body.append(root);

  // координаты — в окне браузера; первый показ — в левом верхнем углу плана
  let x = -1, y = -1, w = o.width, h = o.height;
  /** Свободная часть окна: всё, кроме бокового меню приложения. */
  const bounds = () => {
    const left = Math.max(0, document.querySelector(".sidebar")?.getBoundingClientRect().right ?? 0);
    return { x0: left, y0: 0, x1: window.innerWidth, y1: window.innerHeight };
  };
  function layout(): void {
    const B = bounds();
    if (expanded) {
      Object.assign(root.style, { left: `${B.x0 + 8}px`, top: `${B.y0 + 8}px`, width: `${B.x1 - B.x0 - 16}px`, height: `${Math.max(150, B.y1 - B.y0 - 16)}px` });
      grip.hidden = true;
      return;
    }
    grip.hidden = false;
    if (x < 0) {
      const A = area.getBoundingClientRect();
      x = A.left + 16;
      y = A.top + 16;
    }
    const ww = Math.min(w, Math.max(200, B.x1 - B.x0 - 8)), hh = Math.min(h, Math.max(150, B.y1 - B.y0 - 8));
    x = Math.min(Math.max(B.x0, x), Math.max(B.x0, B.x1 - ww));
    y = Math.min(Math.max(B.y0, y), Math.max(B.y0, B.y1 - hh));
    Object.assign(root.style, { left: `${x}px`, top: `${y}px`, width: `${ww}px`, height: `${hh}px` });
  }
  window.addEventListener("resize", () => !root.hidden && layout());
  const drag = (elem: HTMLElement, move: (dx: number, dy: number, sx: number, sy: number, sw: number, sh: number) => void) => {
    elem.addEventListener("pointerdown", (e) => {
      if (expanded || (e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const sx = x, sy = y, sw = w, sh = h, px = e.clientX, py = e.clientY;
      elem.setPointerCapture(e.pointerId);
      const mv = (ev: PointerEvent) => {
        move(ev.clientX - px, ev.clientY - py, sx, sy, sw, sh);
        layout();
      };
      const up = () => {
        elem.removeEventListener("pointermove", mv);
        elem.removeEventListener("pointerup", up);
        elem.removeEventListener("pointercancel", up);
      };
      elem.addEventListener("pointermove", mv);
      elem.addEventListener("pointerup", up);
      elem.addEventListener("pointercancel", up);
    });
  };
  drag(head, (dx, dy, sx, sy) => {
    x = sx + dx;
    y = sy + dy;
  });
  drag(grip, (dx, dy, _sx, _sy, sw, sh) => {
    w = Math.max(240, sw + dx);
    h = Math.max(170, sh + dy);
  });
  return {
    root, body, title, accessory,
    setVisible(on) {
      root.hidden = !on;
      if (on) layout();
    },
  };
}
