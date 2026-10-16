// Почасовой учёт пилота и статистика — правила те же, что в iOS (HourKey, HourlyStore, accountHour, StatsView).

import { describe, expect, it } from "vitest";
import { hourBars, money, rowsFor, showcaseScore, total, weekdayBars } from "../src/pilot/business";
import { HourlyStore, emptyHour, hourDelta, hourKey, keyDate, mergeHours, parseHour } from "../src/pilot/hours";
import { defaultProfile } from "../src/cloud/firebase";

const h = (p: Partial<ReturnType<typeof emptyHour>>) => ({ ...emptyHour(), ...p });

describe("ключ часа", () => {
  it("как в iOS: 2026-10-03-14 по местному времени", () => {
    expect(hourKey(new Date(2026, 9, 3, 14, 59))).toBe("2026-10-03-14");
    expect(hourKey(new Date(2026, 0, 5, 7))).toBe("2026-01-05-07");
    expect(keyDate("2026-10-03-14")?.getTime()).toBe(new Date(2026, 9, 3, 14).getTime());
    expect(keyDate("мусор")).toBeNull();
  });
});

describe("прирост по часам", () => {
  it("разница итогов", () => {
    expect(hourDelta(h({ people: 3, seconds: 10 }), h({ people: 5, looked: 1, seconds: 70 }))).toEqual(h({ people: 2, looked: 1, seconds: 60 }));
  });
  it("счётчики уменьшились — прироста нет", () => {
    expect(hourDelta(h({ people: 5 }), h({ people: 2 }))).toBeNull();
  });
});

describe("хранилище часов", () => {
  it("копит прирост, объединяется с облаком по максимуму и помнит, что отправить", () => {
    const s = new HourlyStore("test.hours");
    const t = new Date(2026, 9, 14, 12, 10);
    s.add(h({ people: 2, passed: 3, seconds: 60 }), t);
    s.add(h({ people: 1, seconds: 60 }), t);
    expect(s.hours["2026-10-14-12"]).toEqual(h({ people: 3, passed: 3, seconds: 120 }));
    expect(s.pending).toBe(1);
    expect(Object.keys(s.takeDirty())).toEqual(["2026-10-14-12"]);
    expect(s.pending).toBe(0);

    // в облаке тот же час больше (считал iPhone) и ещё один час
    s.merge({ "2026-10-14-12": h({ people: 10, seconds: 100 }), "2026-10-14-11": h({ people: 4 }) });
    expect(s.hours["2026-10-14-12"]).toEqual(h({ people: 10, passed: 3, seconds: 120 }));
    expect(s.hours["2026-10-14-11"]).toEqual(h({ people: 4 }));
    // отправлять нужно только объединённый час, который отличается от облака
    expect(Object.keys(s.takeDirty())).toEqual(["2026-10-14-12"]);
  });

  it("мягко читает документы", () => {
    expect(parseHour({ people: 3, extra: "x" })).toEqual(h({ people: 3 }));
    expect(mergeHours(h({ people: 1, looked: 5 }), h({ people: 2 }))).toEqual(h({ people: 2, looked: 5 }));
  });
});

describe("статистика за период", () => {
  const now = new Date(2026, 9, 14, 20);
  const hours = {
    "2026-10-12-12": h({ people: 10, looked: 2 }), // понедельник
    "2026-10-13-12": h({ people: 20, looked: 4 }), // вторник
    "2026-10-13-13": h({ people: 6 }),
    "2026-09-01-12": h({ people: 100 }), // старое — не в 7 днях
  };

  it("берёт только период и считает среднее за день по часам и дням недели", () => {
    const rows = rowsFor(hours, 7, now);
    expect(rows.length).toBe(3);
    expect(total(rows).people).toBe(36);
    const hb = hourBars(rows, "people");
    expect(hb[12].value).toBe(15); // (10 + 20) / 2 дня
    expect(hb[13].value).toBe(6);
    const wb = weekdayBars(rows, "people");
    expect(wb[0].value).toBe(10); // Пн
    expect(wb[1].value).toBe(26); // Вт
    expect(rowsFor(hours, 0, now).length).toBe(4);
  });

  it("оценка витрины и деньги как в iOS", () => {
    expect(showcaseScore(2, 1, 0, 0, 0, null)).toBeNull();
    const sc = showcaseScore(100, 30, 20, 10, 10, null)!;
    expect(sc.value).toBe(100);
    const m = money(defaultProfile(), 100, 30, null, 3600);
    expect(m.revenue).toBeCloseTo(30 * 0.03 * 3000);
    expect(m.perMonth).toBeCloseTo(m.revenue * 12 * 30);
  });
});
