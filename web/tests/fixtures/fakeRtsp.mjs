// Поддельная RTSP-камера «Hikvision» для тестов: поток /Streaming/Channels/102, вход admin / 12345, Digest.
import { createHash } from "node:crypto";
import net from "node:net";

const md5 = (s) => createHash("md5").update(s).digest("hex");

export async function fakeCamera() {
  const stats = { wrong: 0 };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      if (!buf.includes("\r\n\r\n")) return;
      const req = buf;
      buf = "";
      const uri = /^\w+ (\S+)/.exec(req)?.[1] ?? "";
      const cseq = /CSeq: (\d+)/.exec(req)?.[1] ?? "1";
      const auth = /Authorization: (.+)\r\n/.exec(req)?.[1];
      const reply = (code, extra = "", body = "") =>
        sock.write(`RTSP/1.0 ${code}\r\nCSeq: ${cseq}\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      const challenge = 'WWW-Authenticate: Digest realm="cam", nonce="abc"\r\n';
      if (!auth) return reply("401 Unauthorized", challenge);
      const v = (k) => new RegExp(`${k}="([^"]*)"`).exec(auth)?.[1] ?? "";
      const ok = v("username") === "admin" && v("response") === md5(`${md5(`admin:cam:12345`)}:abc:${md5(`DESCRIBE:${v("uri")}`)}`);
      if (!ok) {
        stats.wrong++;
        return reply("401 Unauthorized", challenge);
      }
      if (!uri.endsWith("/Streaming/Channels/102")) return reply("404 Not Found");
      reply("200 OK", "Content-Type: application/sdp\r\n", "v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, stats, close: () => server.close() };
}
