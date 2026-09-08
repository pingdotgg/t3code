// @effect-diagnostics nodeBuiltinImport:off -- Niri exposes its compositor API through a local Unix socket.
// @effect-diagnostics globalTimers:off -- Bound native socket operations outside Effect fibers.

import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

import type { LinuxWindowSnapshot } from "./LinuxSnapShot.ts";
import { readPortalPng } from "./linuxCaptureSession.ts";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const Id = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Size = Schema.Int.check(Schema.isGreaterThan(0));
const Window = Schema.Struct({
  id: Id,
  title: Schema.NullOr(Schema.String),
  app_id: Schema.NullOr(Schema.String),
  pid: Schema.NullOr(Size),
  layout: Schema.Struct({ window_size: Schema.Tuple([Size, Size]) }),
});
const Reply = Schema.Union([
  Schema.Struct({ Ok: Schema.Unknown }),
  Schema.Struct({ Err: Schema.String }),
]);
const WindowsChanged = Schema.Struct({
  WindowsChanged: Schema.Struct({ windows: Schema.Array(Window) }),
});
const WindowChanged = Schema.Struct({
  WindowOpenedOrChanged: Schema.Struct({ window: Window }),
});
const WindowClosed = Schema.Struct({ WindowClosed: Schema.Struct({ id: Id }) });
const ScreenshotCaptured = Schema.Struct({
  ScreenshotCaptured: Schema.Struct({ path: Schema.NullOr(Schema.String) }),
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeReply = Schema.decodeUnknownSync(Reply);
const decodeFocused = Schema.decodeUnknownSync(
  Schema.Struct({ FocusedWindow: Schema.NullOr(Window) }),
);
const decodeWindows = Schema.decodeUnknownSync(Schema.Struct({ Windows: Schema.Array(Window) }));
const decodeVersion = Schema.decodeUnknownSync(Schema.Struct({ Version: Schema.String }));
const isWindowsChanged = Schema.is(WindowsChanged);
const isWindowChanged = Schema.is(WindowChanged);
const isWindowClosed = Schema.is(WindowClosed);
const isScreenshotCaptured = Schema.is(ScreenshotCaptured);

/** A session hint, never a probe of another compositor or a sandbox escape. */
export function niriSocketPath(env = process.env): string | undefined {
  if (env.FLATPAK_ID || env.SNAP) return undefined;
  if (!env.XDG_CURRENT_DESKTOP?.split(":").some((name) => name.toLowerCase() === "niri"))
    return undefined;
  return env.NIRI_SOCKET && NodePath.isAbsolute(env.NIRI_SOCKET) ? env.NIRI_SOCKET : undefined;
}

/** One bounded exchange or event subscription. All waiters end when the socket closes. */
class NiriConnection {
  private readonly socket: NodeNet.Socket;
  private readonly listeners = new Set<(value: unknown) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private failure: Error | undefined;

  constructor(path: string) {
    this.socket = NodeNet.createConnection(path);
    this.socket.setEncoding("utf8");
    let pending = "";
    this.socket.on("data", (chunk: string) => {
      pending += chunk;
      // Bound even an unterminated or malicious reply; ignore unrelated events without retaining them.
      if (Buffer.byteLength(pending) > MAX_MESSAGE_BYTES) {
        this.close(new Error("Niri returned an oversized message."));
        return;
      }
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const value = decodeJson(line);
          for (const listener of this.listeners) listener(value);
        } catch {
          this.close(new Error("Niri returned an invalid message."));
          return;
        }
      }
    });
    this.socket.on("error", (error) => this.close(error));
    this.socket.on("close", () => this.close(new Error("Niri disconnected.")));
  }

  waitFor<T>(select: (value: unknown) => T | undefined): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.failures.delete(fail);
      };
      const fail = (error: Error) => {
        finish();
        reject(error);
      };
      const listener = (value: unknown) => {
        try {
          const selected = select(value);
          if (selected !== undefined) {
            finish();
            resolve(selected);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Invalid Niri response."));
        }
      };
      const timer = setTimeout(() => fail(new Error("Niri snapshot timed out.")), TIMEOUT_MS);
      this.listeners.add(listener);
      this.failures.add(fail);
    });
  }

  send(request: unknown) {
    this.socket.write(`${JSON.stringify(request)}\n`);
  }

  close(error = new Error("Niri connection closed.")) {
    if (this.failure) return;
    this.failure = error;
    for (const fail of this.failures) fail(error);
    this.socket.destroy();
  }
}

async function request(path: string, message: unknown): Promise<unknown> {
  const connection = new NiriConnection(path);
  try {
    const reply = connection.waitFor((value) => ({ value: decodeReply(value) }));
    connection.send(message);
    const { value } = await reply;
    if ("Err" in value) throw new Error(`Niri: ${value.Err}`);
    return value.Ok;
  } finally {
    connection.close();
  }
}

export async function checkNiriCaptureSupport(path: string): Promise<void> {
  const version = decodeVersion(await request(path, "Version")).Version;
  // 25.11 introduced both caller-selected screenshot paths and completion events.
  const match = /^(?:niri )?(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 25 || (Number(match[1]) === 25 && Number(match[2]) < 11))
    throw new Error("SnapShots require Niri 25.11 or newer.");
}

async function activateNiriWindow(path: string, title: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const connection = new NiriConnection(path);
  const abort = () => connection.close(new Error("Niri activation cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  const windows = new Map<number, typeof Window.Type>();
  try {
    const target = connection.waitFor((value) => {
      if (isWindowsChanged(value)) {
        windows.clear();
        for (const window of value.WindowsChanged.windows) windows.set(window.id, window);
      } else if (isWindowChanged(value)) {
        const window = value.WindowOpenedOrChanged.window;
        windows.set(window.id, window);
      } else if (isWindowClosed(value)) {
        windows.delete(value.WindowClosed.id);
      } else return undefined;
      // Never activate another process's lookalike window, or guess between multiple T3 windows.
      const matches = [...windows.values()].filter(
        (window) => window.pid === process.pid && window.title === title,
      );
      if (matches.length > 1)
        throw new Error("More than one T3 Code window matches the capture destination.");
      return matches[0];
    });
    connection.send("EventStream");
    const window = await target;
    signal.throwIfAborted();
    await request(path, { Action: { FocusWindow: { id: window.id } } });
  } finally {
    signal.removeEventListener("abort", abort);
    connection.close();
  }
}

export async function captureNiriWindow(path: string): Promise<LinuxWindowSnapshot> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-niri-capture-"));
  const imagePath = NodePath.join(directory, "capture.png");
  const events = new NiriConnection(path);
  try {
    // An initial state event proves subscription, whereas the EventStream reply alone does not.
    const ready = events.waitFor((value) => (isWindowsChanged(value) ? true : undefined));
    events.send("EventStream");
    await ready;
    const window = decodeFocused(await request(path, "FocusedWindow")).FocusedWindow;
    if (!window) throw new Error("Niri has no focused window to capture.");
    const captured = events.waitFor((value) =>
      isScreenshotCaptured(value) && value.ScreenshotCaptured.path === imagePath ? true : undefined,
    );
    // Observe rejection even if the compositor rejects the command before we await its event.
    void captured.catch(() => undefined);
    await request(path, {
      Action: {
        ScreenshotWindow: {
          id: window.id,
          write_to_disk: true,
          show_pointer: false,
          path: imagePath,
        },
      },
    });
    await captured;
    const png = await readPortalPng(NodeURL.pathToFileURL(imagePath).href);
    const after = decodeWindows(await request(path, "Windows")).Windows.find(
      (item) => item.id === window.id,
    );
    // A changed/closed window still yields an image, but never attach text from its replacement.
    const identityUnchanged =
      after &&
      after.pid === window.pid &&
      after.title === window.title &&
      after.app_id === window.app_id &&
      after.layout.window_size.every((size, i) => size === window.layout.window_size[i]);
    const feedback = new AbortController();
    return {
      png,
      ...(identityUnchanged
        ? {
            window: {
              title: window.title ?? "",
              appName: window.app_id ?? "Application",
              appIdentifier: window.app_id ?? "",
              processId: window.pid ?? 0,
              // Niri reports logical size, not a globally comparable screen origin.
              bounds: {
                x: 0,
                y: 0,
                width: window.layout.window_size[0],
                height: window.layout.window_size[1],
              },
              accessibilityBoundsReliable: false,
            },
          }
        : {}),
      feedback: {
        animationStarted: false,
        activate: (title) => activateNiriWindow(path, title, feedback.signal),
        animateTo: async () => undefined,
        complete: async () => feedback.abort(),
        close: () => feedback.abort(),
      },
    };
  } finally {
    events.close();
    // The private directory is ours; never remove compositor/user-owned screenshot paths.
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
