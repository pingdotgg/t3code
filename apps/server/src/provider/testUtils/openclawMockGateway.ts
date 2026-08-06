/**
 * openclawMockGateway — an in-process stand-in for the OpenClaw Gateway used
 * by the OpenClaw provider tests.
 *
 * The real `openclaw` binary is not installed in CI or on contributor
 * machines, so tests drive the adapter/runtime against this scripted WebSocket
 * server. It implements just enough of the gateway protocol (v4) to exercise
 * the T3 adapter:
 *
 * - `connect` handshake → `hello-ok`
 * - `sessions.create` / `sessions.describe` / `sessions.delete`
 * - `agent` → accepted ack, streamed `agent` events (lifecycle/assistant/
 *   thinking/tool/approval), then a late completion `res`
 * - `chat.abort`, `chat.history`, `exec.approval.resolve`, `models.list`
 *
 * The server speaks RFC 6455 directly over `node:http` because the repo does
 * not depend on a WebSocket server package.
 *
 * @module provider/testUtils/openclawMockGateway
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHTTP from "node:http";
import * as NodeNet from "node:net";

export interface OpenClawMockGatewayOptions {
  /** Port to bind; defaults to an ephemeral port. */
  readonly port?: number;
  readonly token?: string;
  readonly rejectConnect?: boolean;
  readonly connectErrorCode?: string;
  readonly failSessionCreate?: boolean;
  readonly sessionNotFoundOnDescribe?: boolean;
  readonly emitThinking?: boolean;
  readonly emitToolEvents?: boolean;
  readonly emitApproval?: boolean;
  /**
   * When `emitApproval` is on, also emit the automatic `resolved` approval
   * event. Set to `false` to keep the approval pending so a test can drive
   * `exec.approval.resolve` through the adapter first.
   */
  readonly resolveApproval?: boolean;
  readonly hangAgent?: boolean;
  readonly failAgent?: boolean;
  readonly respondToHistory?: boolean;
  readonly serverVersion?: string;
  readonly modelCatalog?: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  /** Delays agent streaming by this many ms before emitting lifecycle end. */
  readonly agentDelayMs?: number;
}

export interface OpenClawMockGatewayHandle {
  readonly url: string;
  readonly port: number;
  /** Every request frame received by the mock, in order. */
  readonly requests: Array<{
    readonly id: string;
    readonly method: string;
    readonly params?: unknown;
  }>;
  readonly close: () => Promise<void>;
}

interface MockSocket {
  readonly socket: NodeNet.Socket;
  readonly send: (text: string) => void;
}

const MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key: string | undefined): string {
  return NodeCrypto.createHash("sha1")
    .update(`${key ?? ""}${MAGIC_GUID}`)
    .digest("base64");
}

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header: Array<number> = [0x81];
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(127);
    for (let i = 7; i >= 0; i -= 1) {
      header.push(Math.floor(payload.length / 2 ** (8 * i)) & 0xff);
    }
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ readonly opcode: number; readonly payload: Buffer }> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Array<{ opcode: number; payload: Buffer }> = [];
    for (;;) {
      const frame = this.tryDecode();
      if (!frame) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }

  private tryDecode(): { readonly opcode: number; readonly payload: Buffer } | null {
    const buf = this.buffer;
    if (buf.length < 2) {
      return null;
    }
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    let length = buf[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buf.length < offset + maskLength + length) {
      return null;
    }
    const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
    const payload = Buffer.from(buf.subarray(offset + maskLength, offset + maskLength + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = payload[i]! ^ mask[i % 4]!;
      }
    }
    this.buffer = buf.subarray(offset + maskLength + length);
    return { opcode, payload };
  }
}

export function startMockOpenClawGateway(
  options: OpenClawMockGatewayOptions = {},
): Promise<OpenClawMockGatewayHandle> {
  const requests: OpenClawMockGatewayHandle["requests"] = [];
  const sockets = new Set<MockSocket>();
  const server = NodeHTTP.createServer();

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        "\r\n",
      ].join("\r\n"),
    );
    const mockSocket: MockSocket = {
      socket: socket as NodeNet.Socket,
      send: (text) => {
        if (!socket.destroyed) {
          socket.write(encodeFrame(text));
        }
      },
    };
    sockets.add(mockSocket);

    const decoder = new FrameDecoder();
    let nextId = 1;
    let agentRunCounter = 0;
    let lastCreatedSessionKey: string | undefined;

    const sendResponse = (id: string, payload?: unknown) => {
      mockSocket.send(
        JSON.stringify({
          type: "res",
          id,
          ok: true,
          ...(payload !== undefined ? { payload } : {}),
        }),
      );
    };
    const sendErrorResponse = (id: string, code: string, message: string) => {
      mockSocket.send(JSON.stringify({ type: "res", id, ok: false, error: { code, message } }));
    };
    const sendEvent = (event: string, payload?: unknown) => {
      mockSocket.send(
        JSON.stringify({ type: "event", event, ...(payload !== undefined ? { payload } : {}) }),
      );
    };

    const emitAgentRun = (id: string, message: string) => {
      const runId = `mock-run-${++agentRunCounter}`;
      const sessionKey = lastCreatedSessionKey ?? "t3-mock-session";
      sendResponse(id, { runId, status: "accepted" });

      if (options.hangAgent) {
        return;
      }
      const emit = () => {
        sendEvent("agent", {
          runId,
          seq: 1,
          stream: "lifecycle",
          ts: Date.now(),
          data: { phase: "start" },
          sessionKey,
        });
        if (options.emitThinking) {
          sendEvent("agent", {
            runId,
            seq: 2,
            stream: "thinking",
            ts: Date.now(),
            data: { delta: "mock thinking" },
            sessionKey,
          });
        }
        if (options.emitToolEvents) {
          sendEvent("agent", {
            runId,
            seq: 3,
            stream: "tool",
            ts: Date.now(),
            data: {
              state: "start",
              toolName: "bash",
              toolCallId: "mock-call-1",
              args: { command: "ls" },
            },
            sessionKey,
          });
          sendEvent("agent", {
            runId,
            seq: 4,
            stream: "tool",
            ts: Date.now(),
            data: {
              state: "end",
              toolName: "bash",
              toolCallId: "mock-call-1",
              result: "file.txt",
              isError: false,
            },
            sessionKey,
          });
        }
        if (options.emitApproval) {
          sendEvent("agent", {
            runId,
            seq: 5,
            stream: "approval",
            ts: Date.now(),
            data: {
              phase: "requested",
              kind: "exec",
              approvalId: "mock-approval-1",
              title: "Approve command",
              command: "rm -rf /tmp/x",
              toolCallId: "mock-call-1",
            },
            sessionKey,
          });
          if (options.resolveApproval !== false) {
            sendEvent("agent", {
              runId,
              seq: 6,
              stream: "approval",
              ts: Date.now(),
              data: {
                phase: "resolved",
                kind: "exec",
                approvalId: "mock-approval-1",
                status: "approved",
              },
              sessionKey,
            });
          }
        }
        sendEvent("agent", {
          runId,
          seq: 7,
          stream: "assistant",
          ts: Date.now(),
          data: { delta: `hello from mock openclaw (${message})` },
          sessionKey,
        });
        if (options.failAgent) {
          sendEvent("agent", {
            runId,
            seq: 8,
            stream: "lifecycle",
            ts: Date.now(),
            data: { phase: "error", error: "mock agent failure" },
            sessionKey,
          });
          return;
        }
        sendEvent("agent", {
          runId,
          seq: 8,
          stream: "lifecycle",
          ts: Date.now(),
          data: { phase: "end" },
          sessionKey,
        });
        // Late completion response for the same request id.
        mockSocket.send(
          JSON.stringify({
            type: "res",
            id,
            ok: true,
            payload: { runId, status: "ok", summary: "done" },
          }),
        );
      };
      if (options.agentDelayMs && options.agentDelayMs > 0) {
        setTimeout(emit, options.agentDelayMs);
      } else {
        emit();
      }
    };

    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === 8) {
          socket.end();
          sockets.delete(mockSocket);
          return;
        }
        if (frame.opcode === 9) {
          mockSocket.send(
            JSON.stringify({ type: "event", event: "tick", payload: { ts: Date.now() } }),
          );
          continue;
        }
        if (frame.opcode !== 1) {
          continue;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type !== "req") {
          continue;
        }
        const id = typeof message.id === "string" ? message.id : `id-${nextId++}`;
        const method = typeof message.method === "string" ? message.method : "";
        const params =
          typeof message.params === "object" && message.params !== null
            ? (message.params as Record<string, unknown>)
            : {};
        requests.push({ id, method, params });

        switch (method) {
          case "connect": {
            if (options.rejectConnect) {
              sendErrorResponse(
                id,
                options.connectErrorCode ?? "UNAUTHORIZED",
                "mock gateway rejected the connection",
              );
              socket.end();
              sockets.delete(mockSocket);
              return;
            }
            const token = (params.auth as Record<string, unknown> | undefined)?.token;
            if (options.token && token !== options.token) {
              sendErrorResponse(id, "AUTH_TOKEN_MISMATCH", "mock token mismatch");
              socket.end();
              sockets.delete(mockSocket);
              return;
            }
            sendResponse(id, {
              type: "hello-ok",
              protocol: 4,
              server: { version: options.serverVersion ?? "2026.8.1", connId: "mock-conn" },
              features: {
                methods: [
                  "sessions.create",
                  "sessions.describe",
                  "agent",
                  "chat.abort",
                  "chat.history",
                  "models.list",
                  "exec.approval.resolve",
                ],
                events: ["agent", "tick", "shutdown"],
              },
              snapshot: { presence: [], health: { ok: true } },
              auth: {
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.approvals"],
              },
              policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
            });
            return;
          }
          case "sessions.create": {
            if (options.failSessionCreate) {
              sendErrorResponse(id, "INTERNAL", "mock session create failed");
              return;
            }
            const key = typeof params.key === "string" ? params.key : `t3-mock-${nextId++}`;
            lastCreatedSessionKey = key;
            sendResponse(id, {
              ok: true,
              key,
              sessionId: `mock-session-id-${key}`,
              entry: { key },
            });
            return;
          }
          case "sessions.describe": {
            if (options.sessionNotFoundOnDescribe) {
              sendErrorResponse(id, "NOT_FOUND", "mock session not found");
              return;
            }
            sendResponse(id, { key: params.key, sessionId: `mock-session-id-${params.key}` });
            return;
          }
          case "agent": {
            emitAgentRun(id, typeof params.message === "string" ? params.message : "");
            return;
          }
          case "chat.abort": {
            sendResponse(id, { ok: true, aborted: true });
            return;
          }
          case "chat.history": {
            if (options.respondToHistory === false) {
              sendErrorResponse(id, "NOT_FOUND", "mock history unavailable");
              return;
            }
            sendResponse(id, {
              messages: [
                { id: "mock-user-1", role: "user", content: "hello" },
                { id: "mock-msg-1", role: "assistant", content: "hello from mock openclaw" },
              ],
            });
            return;
          }
          case "exec.approval.resolve": {
            sendResponse(id, { ok: true, id: params.id, decision: params.decision });
            return;
          }
          case "models.list": {
            sendResponse(id, {
              models: options.modelCatalog ?? [
                { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
                { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
              ],
            });
            return;
          }
          default: {
            sendErrorResponse(id, "UNKNOWN_METHOD", `unknown method ${method}`);
            return;
          }
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(mockSocket);
    });
  });

  return new Promise<OpenClawMockGatewayHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("mock gateway failed to bind"));
        return;
      }
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        close: () =>
          new Promise<void>((closeResolve) => {
            for (const { socket } of sockets) {
              socket.destroy();
            }
            server.close(() => closeResolve());
          }),
      });
    });
  });
}
