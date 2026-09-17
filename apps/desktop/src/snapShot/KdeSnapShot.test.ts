// @effect-diagnostics nodeBuiltinImport:off -- Isolated helper installation fixtures, never the user's data directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const execute = vi.hoisted(() => vi.fn());
const startEffects = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
vi.mock("./NativeCaptureFeedback.ts", () => ({ startNativeCaptureFeedback: startEffects }));
vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }) }),
  },
}));
import {
  KdeCaptureSetup,
  captureKdeWindow,
  isKdeCaptureSession,
  kdeCaptureDesktopEntry,
  kdeCapturePaths,
} from "./KdeSnapShot.ts";

let directory: string;
let paths: { bundle: string; dataHome: string };
let setup: KdeCaptureSetup;
let denial = false;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const window = {
  title: "Document",
  appName: "Kate",
  appIdentifier: "org.kde.kate",
  processId: 123,
  bounds: { x: 20, y: 10, width: 800, height: 600 },
  clientBounds: { x: 20, y: 39, width: 800, height: 571 },
};

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-kde-test-"));
  paths = {
    bundle: NodePath.join(directory, "bundled-helper"),
    dataHome: NodePath.join(directory, "user data"),
  };
  await NodeFSP.writeFile(paths.bundle, "bundled executable");
  setup = new KdeCaptureSetup(paths);
  denial = false;
  startEffects.mockReset();
  startEffects.mockResolvedValue(undefined);
  execute.mockReset();
  execute.mockImplementation(
    (
      executable: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (args[0] === "capture") {
        void NodeFSP.writeFile(NodePath.join(args[1]!, "capture.png"), png).then(() =>
          callback(null, JSON.stringify({ window }), ""),
        );
      } else if (args[0] === "check" && denial)
        callback(new Error("Denied"), "", "org.kde.KWin.ScreenShot2.Error.NoAuthorized");
      else
        callback(
          null,
          executable === "kbuildsycoca6" ? "" : '{"ready":true,"feedbackAvailable":true}',
          "",
        );
    },
  );
});
afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("detects KDE only outside a sandbox", () => {
  expect(isKdeCaptureSession({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(true);
  expect(isKdeCaptureSession({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe(false);
  expect(isKdeCaptureSession({ XDG_CURRENT_DESKTOP: "KDE", FLATPAK_ID: "app" })).toBe(false);
  expect(isKdeCaptureSession({ XDG_CURRENT_DESKTOP: "KDE", SNAP: "/snap/app" })).toBe(false);
});

it("does not install or request screenshots during initial discovery", async () => {
  expect((await setup.state()).status).toBe("not-installed");
  expect(execute).not.toHaveBeenCalled();
  await expect(NodeFSP.stat(paths.dataHome)).rejects.toMatchObject({ code: "ENOENT" });
});

it("installs offline at a stable path and verifies permissions using the installed identity", async () => {
  await setup.perform("install-kde-helper");
  const { executable, desktop } = kdeCapturePaths(paths);
  expect(await NodeFSP.readFile(executable, "utf8")).toBe("bundled executable");
  expect((await NodeFSP.stat(executable)).mode & 0o777).toBe(0o755);
  expect(await NodeFSP.readFile(desktop, "utf8")).toBe(kdeCaptureDesktopEntry(executable));
  expect(kdeCaptureDesktopEntry(executable)).toContain(`Exec="${executable}" check`);
  expect((await setup.state()).status).toBe("ready");
  expect((await setup.state()).feedbackAvailable).toBe(true);
  expect(execute.mock.calls.map(([file, args]) => [file, args])).toEqual([
    ["kbuildsycoca6", ["--noincremental"]],
    [
      "systemd-run",
      [
        "--user",
        "--quiet",
        "--wait",
        "--collect",
        "--pipe",
        "--service-type=exec",
        "kbuildsycoca6",
        "--noincremental",
      ],
    ],
    [executable, ["check"]],
    [executable, ["check"]],
  ]);
});

it("does not mistake installed files for KDE authorization, or fall back to a picker on denial", async () => {
  await setup.perform("install-kde-helper");
  denial = true;
  expect(await setup.state()).toMatchObject({
    status: "error",
    message: expect.stringContaining("Reinstall"),
  });
  await expect(captureKdeWindow(paths)).rejects.toThrow("Settings → SnapShots");
  expect(execute.mock.calls.some(([, args]) => args[0] === "capture")).toBe(false);
});

it("detects a bundled update, updates explicitly, and removes only capture's registration", async () => {
  await setup.perform("install-kde-helper");
  const unrelated = NodePath.join(paths.dataHome, "applications", "another-app.desktop");
  await NodeFSP.writeFile(unrelated, "keep me");
  await NodeFSP.writeFile(paths.bundle, "updated helper");
  expect((await setup.state()).status).toBe("update-required");
  await setup.perform("install-kde-helper");
  expect((await setup.state()).status).toBe("ready");
  await setup.perform("remove-kde-helper");
  expect((await setup.state()).status).toBe("not-installed");
  expect(await NodeFSP.readFile(unrelated, "utf8")).toBe("keep me");
});

it("repairs the old semicolon permission entry without replacing unrelated registrations", async () => {
  await setup.perform("install-kde-helper");
  const { desktop } = kdeCapturePaths(paths);
  const installed = await NodeFSP.readFile(desktop, "utf8");
  const permission = "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2";
  expect(installed.split("\n")).toContain(permission);
  await NodeFSP.writeFile(desktop, installed.replace(`${permission}\n`, `${permission};\n`));
  execute.mockClear();
  expect((await setup.state()).status).toBe("update-required");
  expect(execute).not.toHaveBeenCalled();
  await setup.perform("install-kde-helper");
  expect((await setup.state()).status).toBe("ready");
  expect((await NodeFSP.readFile(desktop, "utf8")).split("\n")).toContain(permission);
  expect(await NodeFSP.readdir(NodePath.dirname(desktop))).toEqual([NodePath.basename(desktop)]);
});

it("still verifies capture access when a systemd user manager is unavailable", async () => {
  const executeNormally = execute.getMockImplementation()!;
  execute.mockImplementation((file, args, options, callback) => {
    if (file === "systemd-run") callback(new Error("ENOENT"), "", "");
    else executeNormally(file, args, options, callback);
  });
  await setup.perform("install-kde-helper");
  expect((await setup.state()).status).toBe("ready");
  denial = true;
  expect((await setup.state()).status).toBe("error");
});

it("does not report a successful install when the registry cannot be refreshed", async () => {
  execute.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error("Failed"), "", "Failed to rebuild registry"),
  );
  await expect(setup.perform("install-kde-helper")).rejects.toThrow("KDE couldn't register");
});

it("refuses symlink destinations and unrelated desktop entries", async () => {
  const { desktop, executable } = kdeCapturePaths(paths);
  await NodeFSP.mkdir(NodePath.dirname(desktop), { recursive: true });
  await NodeFSP.writeFile(desktop, "[Desktop Entry]\nName=Unrelated");
  await expect(setup.perform("install-kde-helper")).rejects.toThrow("Another desktop entry");
  await NodeFSP.unlink(desktop);
  await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
  await NodeFSP.symlink(paths.bundle, executable);
  await expect(setup.perform("install-kde-helper")).rejects.toThrow("regular files");
  expect(await NodeFSP.readFile(paths.bundle, "utf8")).toBe("bundled executable");
});

it("captures with verified identity, cleans private files, and activates only the owning T3 PID/title", async () => {
  await setup.perform("install-kde-helper");
  const capture = await captureKdeWindow(paths);
  expect(capture.png).toEqual(png);
  expect(capture.window).toEqual(window);
  expect(capture.feedback?.animationStarted).toBe(false);
  const [, args] = execute.mock.calls.find(([, args]) => args[0] === "capture")!;
  await expect(NodeFSP.stat(args[1])).rejects.toMatchObject({ code: "ENOENT" });
  await capture.feedback?.activate('My "Draft"');
  const [, activation] = execute.mock.calls.find(([, args]) => args[0] === "activate")!;
  expect(activation.slice(2)).toEqual([String(process.pid), 'My "Draft"']);
  await expect(NodeFSP.stat(activation[1])).rejects.toMatchObject({ code: "ENOENT" });
  capture.feedback?.close();
});

it("retains the frozen screenshot for feedback and removes it after the renderer acknowledges landing", async () => {
  await setup.perform("install-kde-helper");
  const closed = Promise.withResolvers<void>();
  const animateTo = vi.fn().mockResolvedValue(undefined);
  startEffects.mockResolvedValue({
    animationStarted: true,
    closed: closed.promise,
    animateTo,
    complete: async () => {
      closed.resolve();
    },
    close: () => closed.resolve(),
  });
  const capture = await captureKdeWindow(paths, { flash: true, animate: true });
  const [, args] = execute.mock.calls.find(([, args]) => args[0] === "capture")!;
  expect(await NodeFSP.readFile(NodePath.join(args[1], "capture.png"))).toEqual(png);
  expect(capture.feedback?.animationStarted).toBe(true);
  await capture.feedback?.activate("Draft");
  const frame = { x: 0.2, y: 0.5, width: 0.1, height: 0.2 };
  await capture.feedback?.animateTo(frame);
  expect(animateTo).toHaveBeenCalledWith("Draft", frame);
  await capture.feedback?.complete();
  await expect(NodeFSP.stat(args[1])).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a successfully captured image when optional KDE effects fail", async () => {
  await setup.perform("install-kde-helper");
  startEffects.mockRejectedValue(new Error("QML unavailable"));
  const capture = await captureKdeWindow(paths, { flash: true, animate: true });
  expect(capture.png).toEqual(png);
  expect(capture.feedback?.animationStarted).toBe(false);
  const [, args] = execute.mock.calls.find(([, args]) => args[0] === "capture")!;
  await expect(NodeFSP.stat(args[1])).rejects.toMatchObject({ code: "ENOENT" });
  capture.feedback?.close();
});
