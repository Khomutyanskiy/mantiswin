// Автоподключение IP-камеры (как IPAutoConnect.swift): подбор пути потока и входа запросом DESCRIBE.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — мост на чистом JS
import { describe as rtspDescribe, resolveCamera } from "../bridge/autoconnect.mjs";
// @ts-expect-error — поддельная камера на чистом JS
import { fakeCamera } from "./fixtures/fakeRtsp.mjs";

let cam: { port: number; stats: { wrong: number }; close: () => void };
beforeAll(async () => {
  cam = await fakeCamera();
});
afterAll(() => cam.close());

describe("автоподключение IP-камеры", () => {
  it("DESCRIBE: 401 без пароля, 200 и кодек с верным входом", async () => {
    expect((await rtspDescribe(`rtsp://127.0.0.1:${cam.port}/Streaming/Channels/102`)).status).toBe(401);
    const r = await rtspDescribe(`rtsp://127.0.0.1:${cam.port}/Streaming/Channels/102`, "admin", "12345");
    expect(r).toEqual({ status: 200, codec: "H265" });
  });

  it("сам находит путь марки и заводской пароль, неверных попыток немного", async () => {
    cam.stats.wrong = 0;
    const r = await resolveCamera({ ip: "127.0.0.1", rtspPorts: [cam.port] }, []);
    expect(r.state).toBe("ok");
    expect(r.found).toMatchObject({ url: `rtsp://127.0.0.1:${cam.port}/Streaming/Channels/102`, user: "admin", password: "12345", how: "Hikvision" });
    expect(cam.stats.wrong).toBeLessThanOrEqual(3);
  });

  it("чужой пароль и запрет на заводские — «нужен пароль»", async () => {
    const r = await resolveCamera({ ip: "127.0.0.1", rtspPorts: [cam.port] }, [["admin", "secret"]], 0);
    expect(r.state).toBe("needsPassword");
  });
});
