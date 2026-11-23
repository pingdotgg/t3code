// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - A long-lived ffmpeg process and socket proxy that outlive single Effect calls.
/**
 * Camera for X1, X2 and H2 printers, which stream H.264 over RTSPS. ffmpeg decodes the stream into
 * JPEG frames through a local proxy that makes the TLS connection itself, so the printer is checked
 * against Bambu's authorities like MQTT is (its certificate names the serial, not the address).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

const FRAME_FRESH_MS = 10_000;
const IDLE_STOP_MS = 60_000;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export const FFMPEG_MISSING_REASON =
  "The camera on X1, X2 and H2 printers needs ffmpeg. Install it (for example `brew install ffmpeg`) and the picture will appear.";

export interface BambuStreamTarget {
  readonly address: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly tls: boolean;
  readonly accessCode: string;
  readonly ca: ReadonlyArray<string>;
}

/** Finds ffmpeg from `T3CODE_FFMPEG_PATH`, then PATH, then the usual Homebrew folders. */
export function findFfmpeg(
  env: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Called from a long-lived camera relay outside the Effect runtime.
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = env.T3CODE_FFMPEG_PATH?.trim();
  if (configured) return NodeFS.existsSync(configured) ? configured : null;
  const name = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs = [
    ...(env.PATH ?? "").split(NodePath.delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/** Splits ffmpeg's stream of back-to-back JPEGs into whole frames and the unread remainder. */
export function splitJpegFrames(buffer: Buffer): {
  readonly frames: ReadonlyArray<Buffer>;
  readonly rest: Buffer;
} {
  const frames: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const start = buffer.indexOf(JPEG_START, offset);
    if (start < 0) return { frames, rest: Buffer.alloc(0) };
    const end = buffer.indexOf(JPEG_END, start + JPEG_START.length);
    if (end < 0) return { frames, rest: buffer.subarray(start) };
    frames.push(Buffer.from(buffer.subarray(start, end + JPEG_END.length)));
    offset = end + JPEG_END.length;
  }
}

function describeProxyError(error: Error, target: BambuStreamTarget): string {
  const message = error.message;
  if (/ECONNREFUSED/.test(message)) {
    return `Nothing is streaming on ${target.host}:${target.port}. Check that LAN only liveview is on in the printer's network settings.`;
  }
  if (/certificate|self.signed|unable to verify|CERT_/i.test(message)) {
    return "The printer's camera certificate is not from a trusted Bambu authority.";
  }
  return `Could not reach the printer camera: ${message}`;
}

function describeFfmpegError(stderr: string): string {
  if (/401|Unauthorized/i.test(stderr))
    return "The printer rejected the access code for the camera.";
  if (/404|Not Found/i.test(stderr)) return "The printer has no camera stream at that address.";
  const last = stderr.trim().split("\n").at(-1)?.trim();
  return last ? `The camera stream stopped: ${last}` : "The camera stream stopped.";
}

class BambuStreamCamera {
  readonly target: BambuStreamTarget;
  readonly #ffmpegPath: string;
  #ffmpeg: NodeChildProcess.ChildProcess | null = null;
  #proxy: NodeNet.Server | null = null;
  #pending = Buffer.alloc(0);
  #latest: { readonly bytes: Uint8Array; readonly atMs: number } | null = null;
  #lastError: string | null = null;
  #relayFailed = false;
  #lastRequestMs = 0;
  #failures = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #waiters = new Set<() => void>();
  #disposed = false;

  constructor(target: BambuStreamTarget, ffmpegPath: string) {
    this.target = target;
    this.#ffmpegPath = ffmpegPath;
  }

  get idle(): boolean {
    return Date.now() - this.#lastRequestMs > IDLE_STOP_MS;
  }

  /** Returns a frame no older than a few seconds, starting the stream if needed. */
  async frame(timeoutMs: number): Promise<Uint8Array> {
    this.#lastRequestMs = Date.now();
    if (!this.#ffmpeg && !this.#restartTimer) this.#start();
    const fresh = () =>
      this.#latest && Date.now() - this.#latest.atMs < FRAME_FRESH_MS ? this.#latest.bytes : null;
    const ready = fresh();
    if (ready) return ready;
    // Between retries, report the last failure at once rather than waiting out the timeout.
    if (this.#restartTimer && this.#lastError) throw new Error(this.#lastError);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.#waiters.add(done);
    });
    const frame = fresh();
    if (frame) return frame;
    throw new Error(this.#lastError ?? "The printer camera has not sent a picture yet.");
  }

  stop(): void {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    this.#ffmpeg?.kill("SIGTERM");
    this.#ffmpeg = null;
    this.#proxy?.close();
    this.#proxy = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.stop();
    this.#wake();
  }

  #wake(): void {
    // Each waiter removes itself; deleting the current entry is safe while iterating a Set.
    for (const waiter of this.#waiters) waiter();
  }

  #start(): void {
    this.#relayFailed = false;
    const proxy = NodeNet.createServer((local) => {
      // Only ffmpeg's own connection is relayed; the proxy stops listening once it arrives.
      proxy.close();
      const remote = this.target.tls
        ? NodeTls.connect({
            host: this.target.address,
            port: this.target.port,
            ca: [...this.target.ca],
            maxVersion: "TLSv1.2",
            checkServerIdentity: () => undefined,
          })
        : NodeNet.connect({ host: this.target.address, port: this.target.port });
      remote.on("error", (error: Error) => {
        this.#relayFailed = true;
        this.#lastError = describeProxyError(error, this.target);
        local.destroy();
      });
      local.on("error", () => remote.destroy());
      local.on("close", () => remote.destroy());
      remote.on("close", () => local.destroy());
      local.pipe(remote);
      remote.pipe(local);
    });
    this.#proxy = proxy;
    proxy.on("error", (error: Error) => {
      this.#lastError = `Could not start the camera relay: ${error.message}`;
      this.#wake();
    });
    proxy.listen(0, "127.0.0.1", () => {
      const address = proxy.address();
      if (this.#disposed || this.#proxy !== proxy || !address || typeof address === "string") {
        return;
      }
      this.#spawnFfmpeg(address.port);
    });
  }

  #spawnFfmpeg(proxyPort: number): void {
    const user = encodeURIComponent("bblp");
    const code = encodeURIComponent(this.target.accessCode);
    const path = this.target.path.startsWith("/") ? this.target.path : `/${this.target.path}`;
    const child = NodeChildProcess.spawn(
      this.#ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "10000000",
        "-i",
        `rtsp://${user}:${code}@127.0.0.1:${proxyPort}${path}`,
        "-an",
        "-vf",
        "fps=1,scale='min(1280,iw)':-2",
        "-q:v",
        "5",
        "-c:v",
        "mjpeg",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.#ffmpeg = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      const { frames, rest } = splitJpegFrames(this.#pending);
      this.#pending = rest.length > MAX_PENDING_BYTES ? Buffer.alloc(0) : Buffer.from(rest);
      const frame = frames.at(-1);
      if (frame) {
        this.#latest = { bytes: new Uint8Array(frame), atMs: Date.now() };
        this.#lastError = null;
        this.#failures = 0;
        this.#wake();
      }
    });
    child.on("error", (error: Error) => {
      this.#lastError = `Could not run ffmpeg: ${error.message}`;
    });
    child.on("exit", () => {
      if (this.#ffmpeg === child) this.#ffmpeg = null;
      this.#proxy?.close();
      this.#proxy = null;
      this.#pending = Buffer.alloc(0);
      if (!this.#relayFailed && stderr.trim()) this.#lastError = describeFfmpegError(stderr);
      this.#wake();
      if (this.#disposed || this.idle) return;
      this.#failures += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#failures, 5));
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        if (!this.#disposed && !this.idle) this.#start();
      }, delay);
      this.#restartTimer.unref?.();
    });
  }
}

const cameras = new Map<string, BambuStreamCamera>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function cameraKey(target: BambuStreamTarget): string {
  const code = NodeCrypto.createHash("sha256").update(target.accessCode).digest("hex").slice(0, 16);
  return `${target.address}|${target.port}|${target.path}|${target.tls}|${code}`;
}

/** Reads a recent camera frame, keeping one ffmpeg process per printer while frames are wanted. */
export function fetchBambuStreamFrame(
  target: BambuStreamTarget,
  timeoutMs: number,
): Promise<Uint8Array> {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) return Promise.reject(new Error(FFMPEG_MISSING_REASON));
  const key = cameraKey(target);
  let camera = cameras.get(key);
  if (!camera) {
    for (const [otherKey, other] of cameras) {
      if (other.target.address === target.address) {
        other.dispose();
        cameras.delete(otherKey);
      }
    }
    camera = new BambuStreamCamera(target, ffmpegPath);
    cameras.set(key, camera);
  }
  sweeper ??= setInterval(() => {
    for (const [key, entry] of cameras) {
      if (entry.idle) {
        entry.dispose();
        cameras.delete(key);
      }
    }
    if (cameras.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 15_000);
  sweeper.unref?.();
  return camera.frame(timeoutMs);
}
