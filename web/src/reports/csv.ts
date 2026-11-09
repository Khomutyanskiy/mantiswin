// Выгрузка в Excel — порт CSVExport.swift: CSV с разделителем «;» и BOM, русский Excel открывает двойным щелчком.

import type { HourStat } from "../pilot/hours";
import { reportStart, type ReportSummary } from "./store";

export function makeCsv(header: string[], rows: string[][]): Blob {
  const cell = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const text = [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
  return new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
}

/** Скачать файл (в приложении для Windows — в «Загрузки»). */
export function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 10_000);
}

/** Число для Excel: запятая как разделитель дробной части. */
export const csvNum = (v: number, digits = 1) => v.toFixed(digits).replace(".", ",");

const pad = (n: number) => String(n).padStart(2, "0");
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

/** Статистика по часам (общая или одной камеры) за период. */
export function hoursCsv(rows: { date: Date; stat: HourStat }[]): Blob {
  return makeCsv(
    ["Дата", "День недели", "Час", "Людей", "Притормозили", "Посмотрели", "Прошли мимо", "Вошли", "Наблюдали, мин"],
    rows.map(({ date, stat: s }) => [
      dmy(date), WD[date.getDay()], `${pad(date.getHours())}:00`, String(s.people), String(s.slowed), String(s.looked),
      String(s.passed), String(s.entered), csvNum(s.seconds / 60),
    ]),
  );
}

/** Список отчётов. */
export function reportsCsv(list: ReportSummary[], number: (r: ReportSummary) => number, kind: (r: ReportSummary) => string): Blob {
  return makeCsv(
    ["№", "Тип", "Название", "Начало", "Длительность, мин", "Людей", "Притормозили", "Посмотрели", "Прошли мимо", "Вошли",
      "Оценка витрины", "Камеры", "Видео", "Двойник"],
    list.map((r) => {
      const d = new Date(reportStart(r));
      return [
        String(number(r)), kind(r), r.title, `${dmy(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, csvNum(r.duration / 60),
        String(r.people), String(r.slowed), String(r.looked), String(r.passed), r.entered !== undefined ? String(r.entered) : "",
        r.score !== undefined ? String(r.score) : "", (r.cameras ?? []).map((c) => c.name).join(", "),
        r.videoFolder ? "да" : "", r.twinID ? "да" : "",
      ];
    }),
  );
}
