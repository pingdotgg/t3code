// @effect-diagnostics nodeBuiltinImport:off - This route bridges authenticated WebSockets to loopback TCP.
import * as NodeNet from "node:net";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

const WINDOW = 256 * 1024;
const MAX_DATA = 64 * 1024;
const MAX_STREAMS = 32;

interface ForwardStream {
  socket: NodeNet.Socket;
  connected: boolean;
  ended: boolean;
  sendCredit: number;
  receiveCredit: number;
}

// One authenticated connection carries the browser's HTTP, HTTPS and HMR sockets.
// Credits bound buffering independently of either TCP peer's reading speed.
const forward = (websocket: Socket.Socket, port: number) =>
  Effect.gen(function* () {
    const streams = new Map<number, ForwardStream>();
    const sockets = new Set<NodeNet.Socket>();
    let closed = false;
    let ws: globalThis.WebSocket | undefined;
    const send = (id: number, op: number, payload?: Uint8Array) => {
      if (closed || !ws) return;
      if (ws.bufferedAmount > MAX_STREAMS * WINDOW * 2) {
        stop();
        return;
      }
      const frame = Buffer.allocUnsafe(5 + (payload?.byteLength ?? 0));
      frame.writeUInt32BE(id);
      frame[4] = op;
      if (payload) frame.set(payload, 5);
      try {
        ws.send(frame);
      } catch {
        stop();
      }
    };
    const stop = () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      streams.clear();
      ws?.close(1002, "Invalid preview forwarding frame");
    };
    const close = (id: number, graceful = false) => {
      const stream = streams.get(id);
      if (!stream) return;
      streams.delete(id);
      if (graceful) {
        stream.socket.setTimeout(5000, () => stream.socket.destroy());
        stream.socket.destroySoon();
      } else stream.socket.destroy();
      send(id, 2);
    };
    const flush = (id: number, stream: ForwardStream) => {
      while (stream.connected && stream.sendCredit > 0 && streams.get(id) === stream) {
        const count = Math.min(stream.socket.readableLength, stream.sendCredit, MAX_DATA);
        if (count === 0) break;
        const data: Buffer | null = stream.socket.read(count);
        if (!data) break;
        stream.sendCredit -= data.length;
        send(id, 1, data);
      }
    };
    const open = (id: number) => {
      if (streams.has(id)) {
        stop();
        return;
      }
      if (sockets.size >= MAX_STREAMS) {
        send(id, 2);
        return;
      }
      const stream: ForwardStream = {
        socket: new NodeNet.Socket(),
        connected: false,
        ended: false,
        sendCredit: WINDOW,
        receiveCredit: WINDOW,
      };
      streams.set(id, stream);
      const connect = (host: string) => {
        const socket = NodeNet.createConnection({
          host,
          port,
          allowHalfOpen: true,
        });
        sockets.add(socket);
        stream.socket = socket;
        socket.setTimeout(5000, () => close(id));
        socket.once("connect", () => {
          if (streams.get(id) !== stream) return;
          stream.connected = true;
          socket.setTimeout(0);
          socket.setNoDelay(true);
          send(id, 0);
          flush(id, stream);
        });
        socket.on("readable", () => flush(id, stream));
        socket.once("error", () => {
          if (!stream.connected && host === "127.0.0.1" && streams.get(id) === stream) {
            connect("::1");
          } else close(id);
        });
        socket.once("end", () => send(id, 4));
        socket.once("close", () => {
          sockets.delete(socket);
          if (stream.socket === socket) close(id);
        });
      };
      connect("127.0.0.1");
    };
    yield* websocket
      .runRaw((data) =>
        Effect.gen(function* () {
          // Socket.runRaw supplies its native WebSocket to message handlers.
          ws ??= Option.getOrThrow(yield* Effect.serviceOption(Socket.WebSocket));
          if (closed) return;
          if (typeof data === "string" || data.byteLength < 5 || data.byteLength > MAX_DATA + 5) {
            stop();
            return;
          }
          const frame = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          const id = frame.readUInt32BE(0);
          const op = frame[4];
          const payload = frame.subarray(5);
          if (
            id === 0 ||
            op === undefined ||
            op > 4 ||
            ((op === 0 || op === 2 || op === 4) && payload.length !== 0) ||
            (op === 1 && payload.length === 0) ||
            (op === 3 && payload.length !== 4)
          ) {
            stop();
            return;
          }
          if (op === 0) {
            open(id);
            return;
          }
          const stream = streams.get(id);
          // A peer can close while data or acknowledgements are already in flight.
          if (!stream) return;
          if (op === 2) {
            close(id, true);
          } else if (op === 4) {
            if (!stream.connected || stream.ended) {
              stop();
              return;
            }
            stream.ended = true;
            stream.socket.end();
          } else if (op === 1) {
            if (!stream.connected || stream.ended || payload.length > stream.receiveCredit) {
              stop();
              return;
            }
            stream.receiveCredit -= payload.length;
            stream.socket.write(payload, (error) => {
              if (error || streams.get(id) !== stream) return;
              stream.receiveCredit += payload.length;
              const credit = Buffer.allocUnsafe(4);
              credit.writeUInt32BE(payload.length);
              send(id, 3, credit);
            });
          } else {
            const credit = payload.readUInt32BE(0);
            if (credit === 0 || credit > WINDOW - stream.sendCredit) {
              stop();
              return;
            }
            stream.sendCredit += credit;
            flush(id, stream);
          }
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            closed = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            streams.clear();
          }),
        ),
        Effect.catch(() => Effect.void),
      );
    return HttpServerResponse.empty();
  });

export const previewForwardRouteLayer = HttpRouter.add(
  "GET",
  "/api/preview/forward",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateWebSocketUpgrade(request);
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return HttpServerResponse.empty({ status: 403 });
    }
    const rawPort = new URL(request.url, "http://localhost").searchParams.get("port") ?? "";
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return HttpServerResponse.empty({ status: 400 });
    }
    return yield* forward(yield* request.upgrade, port);
  }).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
      Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
      Effect.succeed(HttpServerResponse.empty({ status: 500 })),
    ),
  ),
);
