// @effect-diagnostics nodeBuiltinImport:off -- The Discord IPC transport is a Node socket boundary owned by the desktop main process.
// @effect-diagnostics globalTimers:off -- Connect and handshake deadlines run at the socket callback boundary outside any Effect fiber.
// @effect-diagnostics preferSchemaOverJson:off -- Frame bodies are opaque Discord wire JSON; validating them against a schema would reject fields we do not model.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export const DISCORD_IPC_OP_HANDSHAKE = 0;
export const DISCORD_IPC_OP_FRAME = 1;
export const DISCORD_IPC_OP_CLOSE = 2;
export const DISCORD_IPC_OP_PING = 3;
export const DISCORD_IPC_OP_PONG = 4;

/** Discord exposes 0…9; the client usually claims 0 but a second instance shifts. */
const DISCORD_IPC_SOCKET_COUNT = 10;
const DISCORD_IPC_PROTOCOL_VERSION = 1;
// A single frame is a few hundred bytes; anything larger is a malformed length.
const DISCORD_IPC_MAX_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

export interface DiscordIpcSocket {
  write(chunk: Buffer): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
}

export type DiscordSocketConnector = (path: string) => DiscordIpcSocket;

export interface DiscordIpcFrame {
  readonly op: number;
  readonly data: unknown;
}

/** Encodes one Discord IPC frame: opcode and length as int32 little-endian, then JSON. */
export const encodeDiscordFrame = (op: number, data: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(data), "utf8");
  const header = Buffer.allocUnsafe(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

/** Accumulates socket chunks and yields whole frames; a frame can span chunks. */
export class DiscordFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): ReadonlyArray<DiscordIpcFrame> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DiscordIpcFrame[] = [];
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > DISCORD_IPC_MAX_FRAME_BYTES) {
        // A bad length means the stream is unrecoverable; drop what we have.
        this.buffer = Buffer.alloc(0);
        return frames;
      }
      if (this.buffer.length < 8 + length) break;
      const json = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      let data: unknown = null;
      try {
        data = JSON.parse(json);
      } catch {
        data = null;
      }
      frames.push({ op, data });
    }
    return frames;
  }
}

/**
 * Candidate socket paths, most likely first. Discord only ever uses one, so the
 * caller connects to them in order until one answers.
 */
export function resolveDiscordIpcPaths(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  if (platform === "win32") {
    return Array.from({ length: DISCORD_IPC_SOCKET_COUNT }, (_unused, index) =>
      NodePath.win32.join("\\\\?\\pipe", `discord-ipc-${index}`),
    );
  }
  const bases = unixSocketBases(platform, environment);
  const paths: string[] = [];
  for (let index = 0; index < DISCORD_IPC_SOCKET_COUNT; index += 1) {
    for (const base of bases) {
      paths.push(NodePath.join(base, `discord-ipc-${index}`));
    }
  }
  return paths;
}

function unixSocketBases(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const runtimeDir = environment.XDG_RUNTIME_DIR;
  const candidates: Array<string | undefined> =
    platform === "linux"
      ? [
          runtimeDir,
          environment.TMPDIR,
          environment.TMP,
          environment.TEMP,
          // Flatpak and Snap relocate the socket under the runtime dir.
          runtimeDir === undefined
            ? undefined
            : NodePath.join(runtimeDir, "app/com.discordapp.Discord"),
          runtimeDir === undefined ? undefined : NodePath.join(runtimeDir, "snap.discord"),
          "/tmp",
        ]
      : [environment.TMPDIR, "/tmp"];
  const seen = new Set<string>();
  const bases: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    bases.push(candidate);
  }
  return bases;
}

export interface DiscordActivityAssets {
  readonly large_image?: string;
  readonly large_text?: string;
  readonly small_image?: string;
  readonly small_text?: string;
}

export interface DiscordActivity {
  readonly details?: string;
  readonly state?: string;
  readonly timestamps?: { readonly start?: number };
  readonly assets?: DiscordActivityAssets;
}

export interface DiscordIpcConnectOptions {
  readonly clientId: string;
  readonly platform: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly connect?: DiscordSocketConnector;
  readonly handshakeTimeoutMs?: number;
  /** Fired once when the socket closes for any reason, including our own close. */
  readonly onClose?: (error: Error | null) => void;
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const connectToPath = (
  connect: DiscordSocketConnector,
  path: string,
  timeoutMs: number,
): Promise<DiscordIpcSocket> =>
  new Promise((resolve, reject) => {
    let socket: DiscordIpcSocket;
    try {
      socket = connect(path);
    } catch (cause) {
      reject(toError(cause));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(toError(cause));
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to ${path}.`));
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

/**
 * A connected, handshaken Discord IPC session. `setActivity(activity)` writes
 * one `SET_ACTIVITY` command; `close()` ends the session.
 */
export class DiscordIpcClient {
  private readonly decoder = new DiscordFrameDecoder();
  private readonly socket: DiscordIpcSocket;
  private readonly clientId: string;
  private readonly onClose: ((error: Error | null) => void) | undefined;
  private readonly handshakeTimeoutMs: number;
  private closed = false;
  private handshakeSettled = false;
  private ready = false;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((error: Error) => void) | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    socket: DiscordIpcSocket,
    clientId: string,
    onClose: ((error: Error | null) => void) | undefined,
    handshakeTimeoutMs: number,
  ) {
    this.socket = socket;
    this.clientId = clientId;
    this.onClose = onClose;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error: Error) => this.handleClose(toError(error)));
    socket.on("close", () => this.handleClose(null));
  }

  /** Connects to the first reachable socket and completes the handshake. */
  static async connect(options: DiscordIpcConnectOptions): Promise<DiscordIpcClient> {
    const environment = options.environment ?? process.env;
    const connect =
      options.connect ?? ((path: string) => NodeNet.connect(path) as unknown as DiscordIpcSocket);
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const paths = resolveDiscordIpcPaths(options.platform, environment);

    let lastError: Error | null = null;
    for (const path of paths) {
      let socket: DiscordIpcSocket;
      try {
        socket = await connectToPath(connect, path, CONNECT_TIMEOUT_MS);
      } catch (cause) {
        lastError = toError(cause);
        continue;
      }
      const client = new DiscordIpcClient(
        socket,
        options.clientId,
        options.onClose,
        handshakeTimeoutMs,
      );
      try {
        await client.handshake();
        return client;
      } catch (cause) {
        lastError = toError(cause);
        client.close();
      }
    }
    throw lastError ?? new Error("No Discord IPC socket is available.");
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      this.handshakeTimer = setTimeout(() => {
        reject(new Error("Discord IPC handshake timed out."));
      }, this.handshakeTimeoutMs);
      this.handshakeTimer.unref?.();
      this.send(DISCORD_IPC_OP_HANDSHAKE, {
        v: DISCORD_IPC_PROTOCOL_VERSION,
        client_id: this.clientId,
      });
    });
  }

  /** Publishes an activity, or clears it when `activity` is null. */
  setActivity(activity: DiscordActivity | null): void {
    if (this.closed) return;
    this.send(DISCORD_IPC_OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity },
      nonce: NodeCrypto.randomUUID(),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      // Already gone; the destroy below still releases the handle.
    }
    try {
      this.socket.destroy();
    } catch {
      // Nothing further to release.
    }
    // Closing before READY is a failure, never a completed handshake.
    this.finishHandshake(new Error("Discord IPC client closed."));
  }

  private send(op: number, data: unknown): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeDiscordFrame(op, data));
    } catch {
      this.handleClose(new Error("Discord IPC write failed."));
    }
  }

  private handleData(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      if (frame.op === DISCORD_IPC_OP_PING) {
        this.send(DISCORD_IPC_OP_PONG, frame.data);
        continue;
      }
      if (frame.op === DISCORD_IPC_OP_CLOSE) {
        this.handleClose(new Error("Discord closed the IPC connection."));
        continue;
      }
      if (frame.op === DISCORD_IPC_OP_FRAME && isReadyDispatch(frame.data)) {
        this.finishHandshake(null);
      }
    }
  }

  private finishHandshake(error: Error | null): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.handshakeSettled) return;
    this.handshakeSettled = true;
    const resolve = this.handshakeResolve;
    const reject = this.handshakeReject;
    this.handshakeResolve = null;
    this.handshakeReject = null;
    if (error === null) {
      this.ready = true;
      resolve?.();
    } else reject?.(error);
  }

  private handleClose(error: Error | null): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.finishHandshake(error ?? new Error("Discord IPC connection closed."));
    if (!wasClosed) {
      try {
        this.socket.destroy();
      } catch {
        // The transport may already be gone.
      }
    }
    if (!wasClosed && this.ready) this.onClose?.(error);
  }
}

const isReadyDispatch = (data: unknown): boolean =>
  typeof data === "object" && data !== null && (data as { evt?: unknown }).evt === "READY";
