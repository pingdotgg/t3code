// @effect-diagnostics nodeBuiltinImport:off -- Private Unix sockets exercise the real compositor transport.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
    }),
  },
}));
import { captureNiriWindow, checkNiriCaptureSupport, niriSocketPath } from "./NiriSnapShot.ts";
import { captureLinuxWindow, getLinuxCaptureSupport } from "./LinuxSnapShot.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const window = {
  id: 42,
  title: "Editor",
  app_id: "org.example.Editor",
  pid: 123,
  layout: { window_size: [800, 600] },
};
type Request =
  | string
  | { Action: { ScreenshotWindow?: { id: number; path: string }; FocusWindow?: { id: number } } };
let directory: string;
let socketPath: string;
let server: NodeNet.Server;
let sockets: Set<NodeNet.Socket>;
let events: NodeNet.Socket[];
let calls: Request[];
let handler: (request: Request, socket: NodeNet.Socket) => Promise<void>;
let focused: typeof window | null;
let windows: (typeof window)[];
let capturePath: string | undefined;
let version: string;
const send = (socket: NodeNet.Socket, value: unknown) => socket.write(`${JSON.stringify(value)}\n`);

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-niri-test-"));
  socketPath = NodePath.join(directory, "ipc");
  sockets = new Set();
  events = [];
  calls = [];
  focused = window;
  windows = [window];
  capturePath = undefined;
  version = "26.04 (v26.04)";
  handler = async (request, socket) => {
    if (request === "EventStream") {
      events.push(socket);
      send(socket, { Ok: "Handled" });
      send(socket, { WindowsChanged: { windows } });
    } else if (request === "Version") send(socket, { Ok: { Version: version } });
    else if (request === "FocusedWindow") send(socket, { Ok: { FocusedWindow: focused } });
    else if (request === "Windows") send(socket, { Ok: { Windows: windows } });
    else if (typeof request !== "string" && request.Action.ScreenshotWindow) {
      const screenshot = request.Action.ScreenshotWindow;
      capturePath = screenshot.path;
      // Focus may change between discovery and capture. The request must keep the original ID.
      focused = { ...window, id: 99, title: "Another app" };
      await NodeFSP.writeFile(screenshot.path, png);
      for (const event of events) {
        send(event, { ScreenshotCaptured: { path: "/another-app.png" } });
        send(event, { ScreenshotCaptured: { path: screenshot.path } });
      }
      // The event may beat the command reply.
      send(socket, { Ok: "Handled" });
    } else send(socket, { Ok: "Handled" });
  };
  server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let pending = "";
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const request = JSON.parse(pending.slice(0, end)) as Request;
        pending = pending.slice(end + 1);
        calls.push(request);
        void handler(request, socket).catch((error: unknown) =>
          socket.destroy(error instanceof Error ? error : undefined),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  vi.stubEnv("NIRI_SOCKET", socketPath);
  vi.stubEnv("XDG_CURRENT_DESKTOP", "niri");
  vi.stubEnv("FLATPAK_ID", "");
  vi.stubEnv("SNAP", "");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("selects the native adapter without needing a portal or GNOME extension", async () => {
  expect(await getLinuxCaptureSupport("com.t3tools.T3Code")).toEqual({
    linuxBackend: "niri",
    linuxFeedbackAvailable: false,
  });
  const snapshot = await captureLinuxWindow("com.t3tools.T3Code");
  expect(snapshot?.png).toEqual(png);
  expect(snapshot?.window).toMatchObject({
    processId: 123,
    title: "Editor",
    accessibilityBoundsReliable: false,
  });
  expect(calls).toContainEqual({
    Action: {
      ScreenshotWindow: { id: 42, path: capturePath, write_to_disk: true, show_pointer: false },
    },
  });
  expect(snapshot?.feedback?.animationStarted).toBe(false);
  expect(await NodeFSP.stat(NodePath.dirname(capturePath!)).catch(() => undefined)).toBeUndefined();
});

it("does not activate T3 until requested, then matches PID and title", async () => {
  const snapshot = await captureNiriWindow(socketPath);
  expect(calls.some((call) => typeof call !== "string" && call.Action.FocusWindow)).toBe(false);
  windows = [
    { ...window, id: 1, pid: 999, title: "T3 Code" },
    { ...window, id: 2, pid: process.pid, title: "Other T3" },
    { ...window, id: 3, pid: process.pid, title: "T3 Code" },
  ];
  await snapshot.feedback!.activate("T3 Code");
  expect(calls).toContainEqual({ Action: { FocusWindow: { id: 3 } } });
});

it("waits for the restored T3 window to map instead of polling", async () => {
  const snapshot = await captureNiriWindow(socketPath);
  const original = handler;
  handler = async (request, socket) => {
    await original(request, socket);
    if (request === "EventStream")
      send(socket, {
        WindowOpenedOrChanged: { window: { ...window, id: 4, pid: process.pid, title: "T3 Code" } },
      });
  };
  await snapshot.feedback!.activate("T3 Code");
  expect(calls).toContainEqual({ Action: { FocusWindow: { id: 4 } } });
});

it("rejects ambiguous activation targets", async () => {
  const snapshot = await captureNiriWindow(socketPath);
  windows = [1, 2].map((id) => ({ ...window, id, pid: process.pid, title: "T3 Code" }));
  await expect(snapshot.feedback!.activate("T3 Code")).rejects.toThrow("More than one");
});

it("cancels pending activation when capture feedback is closed", async () => {
  const snapshot = await captureNiriWindow(socketPath);
  const started = Promise.withResolvers<void>();
  const original = handler;
  handler = async (request, socket) => {
    await original(request, socket);
    if (request === "EventStream") started.resolve();
  };
  const activation = expect(snapshot.feedback!.activate("T3 Code")).rejects.toThrow("cancelled");
  await started.promise;
  snapshot.feedback!.close();
  await activation;
  expect(calls.some((call) => typeof call !== "string" && call.Action.FocusWindow)).toBe(false);
});

it("does not attach accessibility identity if the captured window changed", async () => {
  windows = [{ ...window, title: "Different document" }];
  const snapshot = await captureNiriWindow(socketPath);
  expect(snapshot.png).toEqual(png);
  expect(snapshot.window).toBeUndefined();
});

it("fails without a focused window rather than taking the screen", async () => {
  focused = null;
  await expect(captureNiriWindow(socketPath)).rejects.toThrow("no focused window");
  expect(capturePath).toBeUndefined();
});

it("rejects compositor errors and cleans up its temporary image", async () => {
  const original = handler;
  handler = async (request, socket) => {
    if (typeof request !== "string" && request.Action.ScreenshotWindow) {
      capturePath = request.Action.ScreenshotWindow.path;
      send(socket, { Err: "window disappeared" });
    } else await original(request, socket);
  };
  await expect(captureLinuxWindow("com.t3tools.T3Code")).rejects.toThrow("window disappeared");
  expect(await NodeFSP.stat(NodePath.dirname(capturePath!)).catch(() => undefined)).toBeUndefined();
});

it.each(["24.11", "25.05", "unknown"])("rejects unsupported Niri version %s", async (value) => {
  version = value;
  await expect(checkNiriCaptureSupport(socketPath)).rejects.toThrow("25.11 or newer");
});

it.each(["25.11", "26.04", "niri 26.04 (abc)"])("accepts Niri version %s", async (value) => {
  version = value;
  await checkNiriCaptureSupport(socketPath);
});

it.each(["garbage\n", "x".repeat(4 * 1024 * 1024 + 1)])(
  "bounds malformed compositor replies",
  async (reply) => {
    handler = async (_request, socket) => {
      socket.write(reply);
    };
    await expect(checkNiriCaptureSupport(socketPath)).rejects.toThrow(/invalid|oversized/);
  },
);

it("fails promptly when Niri disconnects", async () => {
  handler = async (_request, socket) => {
    socket.end();
  };
  await expect(checkNiriCaptureSupport(socketPath)).rejects.toThrow("disconnected");
});

it("bounds requests even when the compositor never answers", async () => {
  vi.useFakeTimers();
  const received = Promise.withResolvers<void>();
  handler = async () => received.resolve();
  const result = expect(checkNiriCaptureSupport(socketPath)).rejects.toThrow("timed out");
  await received.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
});

it("does not use stale, relative, or sandboxed Niri sockets", () => {
  expect(niriSocketPath()).toBe(socketPath);
  expect(niriSocketPath({ XDG_CURRENT_DESKTOP: "GNOME", NIRI_SOCKET: socketPath })).toBeUndefined();
  expect(niriSocketPath({ XDG_CURRENT_DESKTOP: "niri", NIRI_SOCKET: "relative" })).toBeUndefined();
  expect(
    niriSocketPath({ XDG_CURRENT_DESKTOP: "niri", NIRI_SOCKET: socketPath, FLATPAK_ID: "app" }),
  ).toBeUndefined();
});
