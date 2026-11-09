// Цифровой двойник и чувствительность камеры — как TwinModel.swift / DetectionFilter.swift (macOS).
import { describe, expect, it } from "vitest";
import { FilterRuntime, defaultFilter, filterSummary, normalizeFilter, spotsToExclusions } from "../src/multi/filter";
import {
  CameraProjector, Timeline, calibrationValid, cameraMark, defaultPlan, defaultShop, freeSpan, hinverse, hmap, homographyFrom,
  insertShopCorner, newDayStats, planCols, streetEdge, walls,
} from "../src/twin/plan";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("гомография", () => {
  const src = [{ x: 0.3, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.85, y: 0.9 }, { x: 0.15, y: 0.9 }];
  const dst = [{ x: 4, y: 2.5 }, { x: 8, y: 2.5 }, { x: 8, y: 5.5 }, { x: 4, y: 5.5 }];
  it("переводит 4 точки туда, куда сказано, и обратно", () => {
    const h = homographyFrom(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const r = hmap(h, src[i]).pt;
      close(r.x, dst[i].x);
      close(r.y, dst[i].y);
    }
    const inv = hinverse(h)!;
    const back = hmap(inv, dst[2]).pt;
    close(back.x, src[2].x);
    close(back.y, src[2].y);
  });
  it("вырожденные точки — нет преобразования", () => {
    expect(homographyFrom([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], dst)).toBeNull();
  });
  it("перекрученный четырёхугольник — привязка неверна", () => {
    expect(calibrationValid({ imagePts: src, planPts: dst })).toBe(true);
    expect(calibrationValid({ imagePts: [src[0], src[2], src[1], src[3]], planPts: dst })).toBe(false);
  });
});

describe("камера на плане", () => {
  const plan = defaultPlan();
  const cal = {
    imagePts: [{ x: 0.3, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.85, y: 0.9 }, { x: 0.15, y: 0.9 }],
    planPts: [{ x: 4, y: 2.5 }, { x: 8, y: 2.5 }, { x: 8, y: 5.5 }, { x: 4, y: 5.5 }],
  };
  it("ноги человека из кадра — на план", () => {
    const p = CameraProjector.create(cal, plan)!;
    // середина низа рамки = середина нижней пары точек
    const q = p.projectBox({ x1: 400, y1: 300, x2: 600, y2: 810 }, 1000, 900)!;
    close(q.x, 6, 1e-6);
    close(q.y, 5.5, 1e-6);
  });
  it("значок камеры: место позади видимого пола, смотрит на пол", () => {
    const m = cameraMark("к", 0, cal, plan)!;
    expect(m.coverage.length).toBeGreaterThan(4);
    expect(m.position.y).toBeGreaterThan(5.5); // камера ближе к нижнему краю кадра
    expect(Math.sin(m.angle)).toBeLessThan(0); // смотрит «вверх» по плану
  });
  it("по сектору: направление по месту в кадре, расстояние по росту", () => {
    const p = CameraProjector.create({ ...cal, mode: "sector", cameraPos: { x: 6, y: 8 }, cameraAngle: -Math.PI / 2, fovDeg: 90, rangeM: 10 }, plan)!;
    // человек по центру кадра ростом в половину кадра: f = W/2 / tan(45°) = 640 → d = 640·1,7/360
    const q = p.projectBox({ x1: 600, y1: 200, x2: 680, y2: 560 }, 1280, 720)!;
    close(q.x, 6, 1e-6);
    close(8 - q.y, (640 * 1.7) / 360, 1e-6);
  });
});

describe("магазин на плане", () => {
  it("стены с проёмом двери, витрина на уличной стороне", () => {
    const plan = defaultPlan();
    plan.shop = defaultShop(plan.widthM, plan.depthM);
    const e = streetEdge(plan)!;
    expect(e).toBe(2); // нижняя сторона прямоугольника
    plan.doors = [freeSpan(plan, e, 1.2)!];
    plan.showcases = [freeSpan(plan, e, 3)!];
    expect(plan.showcases[0].t0).toBeGreaterThanOrEqual(plan.doors[0].t1); // не налезает на дверь
    expect(walls(plan)).toHaveLength(5); // 4 стороны, нижняя разрезана дверью
  });
  it("новый угол не сдвигает витрину", () => {
    const plan = defaultPlan();
    plan.shop = defaultShop(12, 8);
    plan.showcases = [{ edge: 2, t0: 0.6, t1: 0.8 }];
    insertShopCorner(plan, 2, 0.5);
    expect(plan.shop).toHaveLength(5);
    expect(plan.showcases[0].edge).toBe(3);
    close(plan.showcases[0].t0, 0.2);
    close(plan.showcases[0].t1, 0.6);
  });
});

describe("время двойника", () => {
  it("тепло, заходы и время в зонах, пик", () => {
    const plan = defaultPlan();
    plan.zones = [{ id: "z", name: "Витрина", color: 0, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }];
    const frames = [];
    for (let i = 0; i <= 10; i++) frames.push({ t: i * 0.2, p: [{ i: "a", x: 1, y: 1, s: 0 }, ...(i < 5 ? [{ i: "b", x: 5, y: 5, s: 3 }] : [])] });
    const tl = new Timeline(plan, frames);
    expect(tl.stats.people).toBe(2);
    expect(tl.stats.peak).toBe(2);
    expect(tl.stats.visits.z).toBe(1);
    close(tl.stats.dwell.z, 0.2 + 10 * 0.2, 1e-9);
    expect(tl.people(1.0)).toHaveLength(1);
    expect(tl.people(0.5).find((p) => p.id === "b")?.state).toBe("looked");
    expect(tl.occupancy(0.4).z).toBe(1);
    expect(planCols(plan)).toBe(newDayStats("d", plan).cols);
  });
});

describe("чувствительность: зоны исключения и неподвижные", () => {
  const det = (x: number, score = 0.9) => ({ box: { x1: x, y1: 100, x2: x + 60, y2: 400 }, score, keypoints: [] });
  it("старые настройки дополняются, описание как на Mac", () => {
    const f = normalizeFilter({ level: 3, minHeightPercent: 0, behavior: 1 });
    expect(f.exclusions).toEqual([]);
    expect(f.staticMinutes).toBe(3);
    expect(filterSummary({ ...f, exclusions: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]], ignoreStatic: true })).toBe("исключений: 1 · без неподвижных");
  });
  it("всё, чей центр в зоне исключения, отбрасывается с причиной", () => {
    const rt = new FilterRuntime();
    rt.diagnostics = true;
    const f = { ...defaultFilter(), exclusions: [[{ x: 0, y: 0 }, { x: 0.25, y: 0 }, { x: 0.25, y: 1 }, { x: 0, y: 1 }]] };
    const r = rt.apply([det(10), det(500), det(800, 0.2)], f, 0, 1000, 500);
    expect(r.kept).toHaveLength(1);
    expect(rt.rejected.map((x) => x.reason)).toEqual(["зона исключения", "уверенность 20%"]);
  });
  it("фигура без движения дольше порога больше не считается, её место запоминается", () => {
    const rt = new FilterRuntime();
    const f = { ...defaultFilter(), ignoreStatic: true, staticMinutes: 1 };
    const person = { trackId: 7, box: det(300).box };
    expect(rt.dropStatic([person], f, 0)).toHaveLength(1);
    expect(rt.dropStatic([person], f, 30)).toHaveLength(1);
    expect(rt.dropStatic([person], f, 61)).toHaveLength(0);
    expect(rt.staticSpots).toHaveLength(1);
    // следующая детекция на том же месте отбрасывается ещё до трекера
    const r = rt.apply([det(302)], f, 62, 1000, 500);
    expect(r.kept).toHaveLength(0);
    expect(r.rejected[0].reason).toBe("неподвижна");
    const z = spotsToExclusions(rt.staticSpots, 1000, 500);
    expect(z[0][0].x).toBeCloseTo(0.294, 3);
  });
});

describe("лучи камеры не выходят за план", () => {
  it("сектор обрезается краем плана, дуга остаётся внутри", async () => {
    const { ray, rayInside } = await import("../src/twin/plan");
    const plan = defaultPlan(); // 12 × 8
    const m = cameraMark("к", 0, { imagePts: [], planPts: [], mode: "sector", cameraPos: { x: 6, y: 7.5 }, cameraAngle: -Math.PI / 2, fovDeg: 20, rangeM: 13 }, plan)!;
    close(rayInside(m, -Math.PI / 2), 7.5);
    const top = ray(m, m.angle, m.range);
    close(top.y, 0);
    const side = ray(m, 0, 30); // вправо — до края x = 12
    close(side.x, 12);
    const short = ray(m, m.angle, 2); // короче края — как есть
    close(short.y, 5.5);
  });
});

describe("привязка по полу с нерасставленными точками", () => {
  it("не выводит людей на план, пока точки стоят по умолчанию", async () => {
    const { floorPointsUntouched, calibrationUsable, initialCalibration } = await import("../src/twin/plan");
    const c = initialCalibration(defaultPlan());
    expect(floorPointsUntouched(c)).toBe(true);
    expect(calibrationUsable(c)).toBe(false);
    c.imagePts[0] = { x: 0.31, y: 0.6 };
    expect(calibrationUsable(c)).toBe(true);
    expect(floorPointsUntouched({ ...initialCalibration(defaultPlan()), mode: "sector" })).toBe(false);
  });
});

describe("стеллажи и витрины внутри магазина", () => {
  it("прямоугольник с поворотом — препятствие, витрина — ближайшая к камере", async () => {
    const { newFixture, fixtureCorners, insideObstacle, obstacles, nearestFixture, normalizePlan } = await import("../src/twin/plan");
    const plan = normalizePlan({ widthM: 12, depthM: 8 });
    expect(plan.fixtures).toEqual([]);
    const rack = newFixture("rack", { x: 6, y: 4 }, Math.PI / 2); // 2 × 0,5, повёрнут вдоль Y
    const c = fixtureCorners(rack);
    close(Math.max(...c.map((q) => q.y)) - Math.min(...c.map((q) => q.y)), 2);
    plan.fixtures.push(rack);
    expect(insideObstacle(plan, { x: 6, y: 4.8 })).toBe(true);
    expect(insideObstacle(plan, { x: 7, y: 4 })).toBe(false);
    expect(obstacles(plan)).toHaveLength(4);
    plan.fixtures.push(newFixture("showcase", { x: 2, y: 2 }));
    const m = cameraMark("к", 0, { imagePts: [], planPts: [], mode: "sector", cameraPos: { x: 2, y: 4 }, cameraAngle: -Math.PI / 2, fovDeg: 60, rangeM: 5 }, plan)!;
    close(nearestFixture(m, plan)![1], 4 - 2 - 0.35);
  });
});
