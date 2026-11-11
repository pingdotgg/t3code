// @effect-diagnostics globalTimers:off - The socket protocol is callback-driven; its keepalive and ack timers live and die with the socket.
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";

import {
  encodeFrame,
  FrameReader,
  MessageType,
  RequestType,
  ResponseType,
  serialize,
  ValueReader,
} from "./ipc.ts";

export interface CursorServerEndpoint {
  readonly host: string;
  readonly port: number;
  readonly connectionToken: string;
  readonly headers?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly upgradePath?: string;
}

/** A failed call on the VM, carrying VS Code's error name (`EntryNotFound (FileSystemError)`, ...). */
export class RemoteCallError extends Schema.TaggedError<RemoteCallError>()("RemoteCallError", {
  message: Schema.String,
  remoteName: Schema.optional(Schema.String),
}) {}

export class ConnectionClosedError extends Schema.TaggedError<ConnectionClosedError>()(
  "ConnectionClosedError",
  { message: Schema.String },
) {}

const HANDSHAKE_TIMEOUT_MS = 20_000;
const KEEP_ALIVE_MS = 5_000;
const ACK_MS = 500;
// Management connections; extension-host and tunnel connections are 2 and 3.
const MANAGEMENT_CONNECTION = 1;

/** One authenticated management connection to a Cursor cloud VM's cursor-server. */
export class CursorServerConnection {
  private readonly frames = new FrameReader();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<number, (event: unknown) => void>();
  private readonly closeCallbacks = new Set<() => void>();
  private nextRequestId = 0;
  private outgoingId = 0;
  private lastIncomingId = 0;
  private lastAckedId = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private isClosed = false;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static open(
    endpoint: CursorServerEndpoint,
    options: { readonly commit: string; readonly authority: string },
  ): Promise<CursorServerConnection> {
    const scheme = endpoint.port === 443 ? "wss" : "ws";
    const url = new URL(
      `${scheme}://${endpoint.host}:${endpoint.port}${endpoint.upgradePath || "/"}`,
    );
    url.searchParams.set("reconnectionToken", uuidV4Unsafe());
    url.searchParams.set("reconnection", "false");
    url.searchParams.set("skipWebSocketFrames", "false");
    const headers = Object.fromEntries((endpoint.headers ?? []).map((h) => [h.key, h.value]));
    // Node's WebSocket (undici) accepts headers in its init; the DOM type does not declare it.
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    const connection = new CursorServerConnection(socket);
    return connection.handshake(endpoint.connectionToken, options);
  }

  private handshake(
    connectionToken: string,
    options: { readonly commit: string; readonly authority: string },
  ): Promise<CursorServerConnection> {
    return new Promise((resolve, reject) => {
      let phase: "auth" | "ipc" | "ready" = "auth";
      const timeout = setTimeout(() => {
        fail(new Error("Cursor Cloud machine handshake timed out"));
      }, HANDSHAKE_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        this.close();
        reject(error);
      };
      this.socket.addEventListener("open", () => {
        this.sendControl({ type: "auth", auth: connectionToken, data: uuidV4Unsafe() });
      });
      this.socket.addEventListener("error", () => {
        if (phase !== "ready") fail(new Error("Could not connect to the Cursor Cloud machine"));
      });
      this.socket.addEventListener("close", () => {
        if (phase !== "ready") fail(new Error("The Cursor Cloud machine closed the connection"));
        this.handleClose();
      });
      this.socket.addEventListener("message", (event) => {
        const data = event.data;
        if (!(data instanceof ArrayBuffer)) return;
        for (const frame of this.frames.push(new Uint8Array(data))) {
          if (frame.type === MessageType.Control && phase === "auth") {
            let message: { type?: string; data?: unknown; reason?: string };
            try {
              message = JSON.parse(new TextDecoder().decode(frame.body));
            } catch {
              fail(new Error("The Cursor Cloud machine sent an invalid handshake"));
              return;
            }
            if (message.type === "sign" && typeof message.data === "string") {
              // cursor-server accepts the challenge unsigned, as Cursor's browser client sends it.
              this.sendControl({
                type: "connectionType",
                commit: options.commit,
                signedData: message.data,
                desiredConnectionType: MANAGEMENT_CONNECTION,
              });
            } else if (message.type === "ok") {
              phase = "ipc";
              this.sendRegular(
                serialize({ remoteAuthority: options.authority, clientId: uuidV4Unsafe() }),
              );
              this.timers.push(
                setInterval(
                  () => this.sendFrame(MessageType.KeepAlive, 0, Uint8Array.of()),
                  KEEP_ALIVE_MS,
                ),
                setInterval(() => this.flushAck(), ACK_MS),
              );
            } else {
              fail(new Error(message.reason ?? "The Cursor Cloud machine rejected the connection"));
            }
          } else if (frame.type === MessageType.Regular) {
            this.lastIncomingId = frame.id;
            const reader = new ValueReader(frame.body);
            const header = reader.read();
            const body = reader.done ? undefined : reader.read();
            if (!Array.isArray(header)) continue;
            if (header[0] === ResponseType.Initialize && phase === "ipc") {
              phase = "ready";
              clearTimeout(timeout);
              resolve(this);
            } else {
              this.handleResponse(header, body);
            }
          } else if (frame.type === MessageType.Disconnect) {
            this.close();
          }
        }
      });
    });
  }

  private handleResponse(header: unknown[], body: unknown) {
    const [type, id] = header as [number, number];
    if (type === ResponseType.PromiseSuccess) {
      this.pending.get(id)?.resolve(body);
      this.pending.delete(id);
    } else if (type === ResponseType.PromiseError || type === ResponseType.PromiseErrorObj) {
      const error = (body ?? {}) as { message?: unknown; name?: unknown };
      this.pending.get(id)?.reject(
        new RemoteCallError({
          message:
            typeof error.message === "string" ? error.message : "Cursor Cloud machine call failed",
          ...(typeof error.name === "string" ? { remoteName: error.name } : {}),
        }),
      );
      this.pending.delete(id);
    } else if (type === ResponseType.EventFire) {
      this.listeners.get(id)?.(body);
    }
  }

  get closed() {
    return this.isClosed;
  }

  call(channel: string, command: string, arg?: unknown): Promise<unknown> {
    if (this.isClosed)
      return Promise.reject(new ConnectionClosedError({ message: "Connection closed" }));
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendRegular(serialize([RequestType.Promise, id, channel, command], arg));
    });
  }

  listen(channel: string, event: string, onEvent: (event: unknown) => void): () => void {
    const id = ++this.nextRequestId;
    this.listeners.set(id, onEvent);
    this.sendRegular(serialize([RequestType.EventListen, id, channel, event], undefined));
    return () => {
      if (!this.listeners.delete(id) || this.isClosed) return;
      this.sendRegular(serialize([RequestType.EventDispose, id]));
    };
  }

  onClose(callback: () => void): () => void {
    if (this.isClosed) {
      callback();
      return () => {};
    }
    this.closeCallbacks.add(callback);
    return () => this.closeCallbacks.delete(callback);
  }

  close() {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000);
    }
    this.handleClose();
  }

  private handleClose() {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const { reject } of this.pending.values()) {
      reject(new ConnectionClosedError({ message: "The Cursor Cloud machine disconnected" }));
    }
    this.pending.clear();
    this.listeners.clear();
    for (const callback of this.closeCallbacks) callback();
    this.closeCallbacks.clear();
  }

  private flushAck() {
    if (this.lastIncomingId === this.lastAckedId) return;
    this.lastAckedId = this.lastIncomingId;
    this.sendFrame(MessageType.Ack, 0, Uint8Array.of());
  }

  private sendControl(value: unknown) {
    this.sendFrame(MessageType.Control, 0, new TextEncoder().encode(JSON.stringify(value)), 0);
  }

  private sendRegular(body: Uint8Array) {
    this.lastAckedId = this.lastIncomingId;
    this.sendFrame(MessageType.Regular, ++this.outgoingId, body);
  }

  private sendFrame(type: number, id: number, body: Uint8Array, ack = this.lastIncomingId) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeFrame({ type, id, ack, body }));
  }
}
