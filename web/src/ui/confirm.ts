// Свои окна подтверждения и ввода в стиле приложения (вместо системных confirm / prompt / alert браузера).

export interface AskOptions {
  title: string;
  text?: string;
  ok?: string;
  cancel?: string;
  /** Опасное действие (остановить, удалить) — кнопка красная. */
  danger?: boolean;
}

function build(o: AskOptions, input?: HTMLInputElement): { dialog: HTMLDialogElement; okBtn: HTMLButtonElement; cancelBtn: HTMLButtonElement | null } {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog ask-dialog";
  const form = document.createElement("form");
  form.className = "dialog-inner";
  form.method = "dialog";
  const h = document.createElement("h2");
  h.textContent = o.title;
  form.append(h);
  if (o.text) {
    const p = document.createElement("p");
    p.className = "ask-text";
    p.textContent = o.text;
    form.append(p);
  }
  if (input) form.append(input);
  const actions = document.createElement("div");
  actions.className = "ask-actions";
  const okBtn = document.createElement("button");
  okBtn.type = "submit";
  okBtn.value = "ok";
  okBtn.className = `btn ${o.danger ? "danger" : "primary"}`;
  okBtn.textContent = o.ok ?? "OK";
  let cancelBtn: HTMLButtonElement | null = null;
  if (o.cancel !== "") {
    cancelBtn = document.createElement("button");
    cancelBtn.type = "submit";
    cancelBtn.value = "cancel";
    cancelBtn.className = "btn ghost";
    cancelBtn.textContent = o.cancel ?? "Отмена";
    actions.append(cancelBtn);
  }
  actions.append(okBtn);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  return { dialog, okBtn, cancelBtn };
}

/** Подтверждение: true — «OK», false — отмена или Esc. */
export function ask(o: AskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, okBtn } = build(o);
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    dialog.showModal();
    okBtn.focus();
  });
}

/** Ввод строки: текст или null (отмена). */
export function askText(o: AskOptions & { value?: string; placeholder?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.className = "input";
    input.value = o.value ?? "";
    input.placeholder = o.placeholder ?? "";
    const { dialog } = build({ ok: "Сохранить", ...o }, input);
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? input.value : null);
      dialog.remove();
    });
    dialog.showModal();
    input.focus();
    input.select();
  });
}

/** Сообщение с одной кнопкой. */
export async function tell(title: string, text?: string): Promise<void> {
  await ask({ title, text, ok: "Понятно", cancel: "" });
}
