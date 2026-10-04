import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerMessage } from "../../../packages/protocol/src/index.ts";
import { object, string } from "./codex.ts";
import { Runtime } from "./runtime.ts";

/** Transport only decodes requests and calls the runtime interface. */
export async function startServer(options: { directory: string; token: string; port?: number; command?: string; args?: string[]; env?: NodeJS.ProcessEnv }) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Pairing token must be 32 random bytes encoded as hex");
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}');
    } else { response.writeHead(404); response.end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols: () => "t3mobile" });
  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, "Reconnect to restore state"); return; }
    socket.send(JSON.stringify(message));
  };
  const runtime = new Runtime({ directory: options.directory, command: options.command ?? "codex", args: options.args, env: options.env,
    emit: (message) => { for (const socket of sockets.clients) send(socket, message); } });
  await runtime.load();
  server.on("upgrade", (request, socket, head) => {
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()) ?? [];
    const provided = protocols.find((p) => p.startsWith("token."))?.slice(6) ?? "";
    const a = Buffer.from(provided); const b = Buffer.from(options.token);
    // Android React Native supplies a default HTTP Origin for native WebSockets.
    // Accept that loopback origin, but reject unrelated browser origins.
    let allowedOrigin = request.headers.origin === undefined;
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        const host = new URL(`http://${request.headers.host}`);
        allowedOrigin = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
          && origin.origin === host.origin;
      } catch { allowedOrigin = false; }
    }
    if (request.url !== "/rpc" || !allowedOrigin || !protocols.includes("t3mobile") || a.length !== b.length || !timingSafeEqual(a, b)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });
  sockets.on("connection", (socket) => {
    send(socket, runtime.snapshot());
    let inFlight = 0;
    socket.on("message", async (data) => {
      let id: string | undefined;
      try {
        const request = object(JSON.parse(data.toString()));
        id = string(request.id);
        if (id.length > 100 || inFlight >= 8) throw new Error("Too many requests");
        inFlight++;
        try { send(socket, { id, result: await runtime.dispatch(request) }); }
        finally { inFlight--; }
      } catch (error) {
        if (id) send(socket, { id, error: error instanceof Error ? error.message : String(error) });
        else socket.close(1008, "Invalid request");
      }
    });
    socket.on("error", () => { socket.terminate(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(options.port ?? 8787, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot determine server port");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
