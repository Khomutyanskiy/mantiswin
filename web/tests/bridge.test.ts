// Мост IP-камер: разбор ответов ONVIF, HTTP Digest, адреса с паролем, размер JPEG.

import { describe, expect, it } from "vitest";
// @ts-expect-error — модули моста на чистом JS
import { httpAuthorization, parseProbeMatch, templates, xmlAttrs, xmlFirst } from "../bridge/onvif.mjs";
// @ts-expect-error — модули моста на чистом JS
import { StreamManager, jpegSize, redact, withCredentials } from "../bridge/streams.mjs";

describe("ONVIF", () => {
  it("разбирает ProbeMatch: адрес сервиса, название, модель", () => {
    const xml = `<d:ProbeMatches><d:ProbeMatch><d:Scopes>onvif://www.onvif.org/name/HIKVISION%20DS-2CD onvif://www.onvif.org/hardware/DS-2CD2043G2-I onvif://www.onvif.org/location/</d:Scopes>
      <d:XAddrs>http://[fe80::1]/onvif/device_service http://192.168.1.64/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches>`;
    const cam = parseProbeMatch("192.168.1.64", xml);
    expect(cam.onvifURL).toBe("http://192.168.1.64/onvif/device_service");
    expect(cam.name).toBe("HIKVISION DS-2CD");
    expect(cam.hardware).toBe("DS-2CD2043G2-I");
    expect(parseProbeMatch("1.2.3.4", "<Hello/>")).toBeNull();
  });

  it("находит элементы и атрибуты без учёта префиксов", () => {
    const xml = `<trt:GetProfilesResponse><trt:Profiles token="main" fixed="true"/><trt:Profiles token="sub"/></trt:GetProfilesResponse><tt:Uri>rtsp://a/b?x=1&amp;y=2</tt:Uri>`;
    expect(xmlAttrs("token", "Profiles", xml)).toEqual(["main", "sub"]);
    expect(xmlFirst("Uri", xml)).toBe("rtsp://a/b?x=1&y=2");
  });

  it("HTTP Digest по примеру из RFC 2617", () => {
    const challenge = 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
    const h = httpAuthorization(challenge, "GET", "/dir/index.html", "Mufasa", "Circle Of Life");
    expect(h).toContain('username="Mufasa"');
    expect(h).toContain("qop=auth");
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(httpAuthorization('Basic realm="x"', "POST", "/", "admin", "1")).toBe("Basic " + btoa("admin:1"));
  });

  it("шаблоны путей для камер без ONVIF — как в iOS", () => {
    const t = templates({ ip: "192.168.1.10", rtspPorts: [554] });
    expect(t.map((x: { title: string }) => x.title)).toEqual(["Hikvision", "Dahua", "Uniview", "TP-Link VIGI / Tapo"]);
    expect(templates({ ip: "10.0.0.2", rtspPorts: [8554] })[0].url).toBe("rtsp://10.0.0.2:8554/cam");
  });
});

describe("потоки", () => {
  it("подставляет логин и пароль и скрывает пароль в логах", () => {
    const u = withCredentials("rtsp://192.168.1.64:554/Streaming/Channels/102", "admin", "p@ss:1");
    expect(u).toBe("rtsp://admin:p%40ss%3A1@192.168.1.64:554/Streaming/Channels/102");
    expect(redact(u)).toBe("rtsp://admin:***@192.168.1.64:554/Streaming/Channels/102");
    expect(withCredentials("rtsp://u:x@h/p", "admin", "y")).toBe("rtsp://u:x@h/p");
  });

  it("читает размер JPEG из заголовка SOF", () => {
    // минимальный JPEG: SOI, APP0 (длина 16), SOF0 с высотой 480 и шириной 640
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...new Array(9).fill(0)];
    const b = new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
    expect(jpegSize(b)).toEqual([640, 480]);
  });
});

describe("мост: один поток на несколько зрителей", () => {
  it("ffmpeg останавливается, только когда поток закрыли все, кто его открыл", () => {
    const m = new StreamManager();
    const a = m.open("rtsp://127.0.0.1:9/none", "", "");
    const b = m.open("rtsp://127.0.0.1:9/none", "", "");
    expect(b.id).toBe(a.id);
    m.release(a.id);
    expect(m.get(a.id)).toBeTruthy(); // пилот ещё смотрит
    m.release(a.id);
    expect(m.get(a.id)).toBeUndefined();
    m.closeAll();
  });
});
