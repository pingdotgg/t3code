// @effect-diagnostics nodeBuiltinImport:off -- Isolated installation/config fixtures; no user's desktop state.
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
  HyprlandCaptureSetup,
  captureHyprlandWindow,
  hyprlandCaptureExecutable,
  hyprlandCaptureShortcut,
  isHyprlandCaptureSession,
} from "./HyprlandSnapShot.ts";

let directory: string;
let paths: { bundle: string; dataHome: string };
let setup: HyprlandCaptureSetup;
let denial: boolean;
let metadata: typeof window | null;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const window = {
  title: "Notes",
  appName: "editor",
  appIdentifier: "editor",
  processId: 123,
  bounds: { x: -1920, y: 20, width: 800, height: 600 },
  clientBounds: { x: -1920, y: 20, width: 800, height: 600 },
};
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hypr-test-"));
  paths = {
    bundle: NodePath.join(directory, "bundle"),
    dataHome: NodePath.join(directory, "user data"),
  };
  await NodeFSP.writeFile(paths.bundle, "bundled executable");
  setup = new HyprlandCaptureSetup(paths);
  denial = false;
  metadata = window;
  startEffects.mockReset().mockResolvedValue(undefined);
  execute
    .mockReset()
    .mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args[0] === "capture") {
          if (denial) callback(new Error("Denied"), "", "Check screen-sharing permission.");
          else
            void NodeFSP.writeFile(NodePath.join(args[1]!, "capture.png"), png).then(() =>
              callback(null, JSON.stringify({ window: metadata }), ""),
            );
        } else callback(null, '{"feedbackAvailable":true}', "");
      },
    );
});
afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("does not select Hyprland from a stale socket environment or sandbox", () => {
  expect(isHyprlandCaptureSession({ XDG_CURRENT_DESKTOP: "Hyprland" })).toBe(true);
  expect(
    isHyprlandCaptureSession({ XDG_CURRENT_DESKTOP: "KDE", HYPRLAND_INSTANCE_SIGNATURE: "old" }),
  ).toBe(false);
  expect(isHyprlandCaptureSession({ XDG_CURRENT_DESKTOP: "Hyprland", FLATPAK_ID: "app" })).toBe(
    false,
  );
  expect(isHyprlandCaptureSession({ XDG_CURRENT_DESKTOP: "Hyprland", SNAP: "app" })).toBe(false);
});
it("discovery neither installs a helper nor requests a screenshot", async () => {
  expect((await setup.state()).status).toBe("not-installed");
  expect(execute).not.toHaveBeenCalled();
  await expect(NodeFSP.stat(paths.dataHome)).rejects.toMatchObject({ code: "ENOENT" });
});
it("installs offline at a stable executable path and probes only capabilities", async () => {
  await setup.perform("install-hyprland-helper");
  expect((await NodeFSP.stat(hyprlandCaptureExecutable(paths))).mode & 0o777).toBe(0o755);
  expect(await setup.state()).toMatchObject({ status: "ready", feedbackAvailable: true });
  expect(execute.mock.calls.map(([file, args]) => [file, args])).toEqual([
    [hyprlandCaptureExecutable(paths), ["check"]],
  ]);
});
it("updates explicitly and removes only its helper", async () => {
  await setup.perform("install-hyprland-helper");
  const unrelated = NodePath.join(paths.dataHome, "keep.txt");
  await NodeFSP.writeFile(unrelated, "keep");
  await NodeFSP.writeFile(paths.bundle, "update");
  expect((await setup.state()).status).toBe("update-required");
  await setup.perform("install-hyprland-helper");
  expect((await setup.state()).status).toBe("ready");
  await setup.perform("remove-hyprland-helper");
  expect((await setup.state()).status).toBe("not-installed");
  expect(await NodeFSP.readFile(unrelated, "utf8")).toBe("keep");
});
it("does not overwrite a linked executable", async () => {
  const executable = hyprlandCaptureExecutable(paths);
  await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
  await NodeFSP.symlink(paths.bundle, executable);
  await expect(setup.perform("install-hyprland-helper")).rejects.toThrow("not a link");
  expect(await NodeFSP.readFile(paths.bundle, "utf8")).toBe("bundled executable");
});
it.each([true, false])("uses the active config syntax and user bindings (Lua: %s)", async (lua) => {
  const config = NodePath.join(directory, "hypr");
  await NodeFSP.mkdir(config);
  await NodeFSP.writeFile(
    NodePath.join(config, lua ? "hyprland.lua" : "hyprland.conf"),
    "custom config",
  );
  await NodeFSP.writeFile(
    NodePath.join(config, lua ? "bindings.lua" : "bindings.conf"),
    "custom bindings",
  );
  const result = await hyprlandCaptureShortcut("com.t3tools.T3Code", directory);
  expect(result.shortcutConfigPath).toBe(
    NodePath.join(config, lua ? "bindings.lua" : "bindings.conf"),
  );
  expect(result.shortcutBinding).toBe(
    lua
      ? 'hl.bind("CTRL + SHIFT + 2", hl.dsp.global("com.t3tools.T3Code:capture-window"))'
      : "bind = CTRL SHIFT, 2, global, com.t3tools.T3Code:capture-window",
  );
  expect(await NodeFSP.readFile(result.shortcutConfigPath, "utf8")).toBe("custom bindings");
});
it("captures exact-window metadata for accessibility and focuses only through the installed helper", async () => {
  await setup.perform("install-hyprland-helper");
  const result = await captureHyprlandWindow(paths);
  expect(result.png).toEqual(png);
  expect(result.window).toEqual(window);
  await result.feedback?.activate("T3 destination");
  expect(execute.mock.calls.find(([, args]) => args[0] === "activate")?.slice(0, 2)).toEqual([
    hyprlandCaptureExecutable(paths),
    ["activate", String(process.pid), "T3 destination"],
  ]);
  const captureDirectory = execute.mock.calls.find(([, args]) => args[0] === "capture")![1][1];
  await expect(NodeFSP.stat(captureDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  result.feedback?.close();
});
it("does not guess accessibility metadata when the captured window changed", async () => {
  await setup.perform("install-hyprland-helper");
  metadata = null;
  const result = await captureHyprlandWindow(paths, { flash: true, animate: true });
  expect(result.window).toBeUndefined();
  expect(startEffects).not.toHaveBeenCalled();
  result.feedback?.close();
});
it("surfaces a capture denial without a picker fallback and removes temporary output", async () => {
  await setup.perform("install-hyprland-helper");
  denial = true;
  await expect(captureHyprlandWindow(paths)).rejects.toThrow("screen-sharing permission");
  const path = execute.mock.calls.find(([, args]) => args[0] === "capture")![1][1];
  await expect(NodeFSP.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("keeps capture working when an overlay cannot start", async () => {
  await setup.perform("install-hyprland-helper");
  startEffects.mockRejectedValue(new Error("No layer shell"));
  const result = await captureHyprlandWindow(paths, { flash: true, animate: true });
  expect(result.png).toEqual(png);
  expect(result.feedback?.animationStarted).toBe(false);
  result.feedback?.close();
});
