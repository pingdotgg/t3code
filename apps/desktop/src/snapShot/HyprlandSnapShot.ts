// @effect-diagnostics nodeBuiltinImport:off -- Bundled Wayland helper installed only by explicit setup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import type { DesktopCaptureHelperState } from "@t3tools/contracts";
import type { LinuxWindowSnapshot } from "./LinuxSnapShot.ts";
import { readPortalPng } from "./linuxCaptureSession.ts";
import { startNativeCaptureFeedback } from "./NativeCaptureFeedback.ts";
import { HYPRLAND_CAPTURE_ACTION } from "./linuxCaptureSession.ts";
export { isHyprlandCaptureSession } from "./linuxCaptureSession.ts";

export const HYPRLAND_CAPTURE_EXECUTABLE = "t3-hyprland-snap-shot";
export type HyprlandCapturePaths = { readonly bundle: string; readonly dataHome: string };
export function hyprlandCaptureExecutable(paths: HyprlandCapturePaths) {
  return NodePath.join(paths.dataHome, "t3code", "hyprland-capture", HYPRLAND_CAPTURE_EXECUTABLE);
}

function hyprlandCaptureBinding(appId: string, lua: boolean): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(appId)) throw new Error("Invalid capture application ID.");
  const action = `${appId}:${HYPRLAND_CAPTURE_ACTION}`;
  return lua
    ? `hl.bind("CTRL + SHIFT + 2", hl.dsp.global("${action}"))`
    : `bind = CTRL SHIFT, 2, global, ${action}`;
}

/** Omarchy owns its defaults; instructions always point at a user-owned config. */
export async function hyprlandCaptureShortcut(
  appId: string,
  configHome = process.env.XDG_CONFIG_HOME || NodePath.join(NodeOS.homedir(), ".config"),
) {
  const directory = NodePath.join(configHome, "hypr");
  const exists = async (name: string) =>
    NodeFSP.access(NodePath.join(directory, name)).then(
      () => true,
      () => false,
    );
  const lua = await exists("hyprland.lua");
  const bindings = lua ? "bindings.lua" : "bindings.conf";
  const config = (await exists(bindings)) ? bindings : lua ? "hyprland.lua" : "hyprland.conf";
  return {
    shortcutBinding: hyprlandCaptureBinding(appId, lua),
    shortcutConfigPath: NodePath.join(directory, config),
  };
}

function run(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      executable,
      args,
      { timeout: 20_000, maxBuffer: 128 * 1024, encoding: "utf8", ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              stderr.trim() ||
                "Hyprland capture did not respond. Check capture setup and try again.",
            ),
          );
        else resolve(stdout);
      },
    );
  });
}
async function regularFile(path: string): Promise<Buffer | undefined> {
  const stat = await NodeFSP.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The capture helper must be a regular file, not a link.");
  return NodeFSP.readFile(path);
}
const decodeCapabilities = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ feedbackAvailable: Schema.Boolean })),
);

export class HyprlandCaptureSetup {
  private readonly paths: HyprlandCapturePaths;
  constructor(paths: HyprlandCapturePaths) {
    this.paths = paths;
  }
  async state(): Promise<DesktopCaptureHelperState> {
    try {
      const installed = await regularFile(hyprlandCaptureExecutable(this.paths));
      if (!installed)
        return {
          status: "not-installed",
          message: "Install the bundled helper to capture the window you're using.",
        };
      const bundle = await regularFile(this.paths.bundle);
      if (!bundle)
        throw new Error(
          "The Hyprland capture helper is missing from this build. Update or reinstall T3 Code.",
        );
      if (!installed.equals(bundle))
        return {
          status: "update-required",
          message: "Update the bundled capture helper to continue.",
        };
      return {
        status: "ready",
        message:
          "Helper ready. Hyprland may ask for screen-sharing permission on your first capture.",
        ...decodeCapabilities(await run(hyprlandCaptureExecutable(this.paths), ["check"])),
      };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Couldn't check Hyprland capture access.",
      };
    }
  }
  async perform(action: "install-hyprland-helper" | "remove-hyprland-helper") {
    const executable = hyprlandCaptureExecutable(this.paths);
    const directory = NodePath.dirname(executable);
    const stat = await NodeFSP.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("The capture helper directory must not be a link.");
    await regularFile(executable);
    if (action === "remove-hyprland-helper") {
      await NodeFSP.rm(executable, { force: true });
      return;
    }
    const bundle = await regularFile(this.paths.bundle);
    if (!bundle) throw new Error("The Hyprland capture helper is missing from this build.");
    await NodeFSP.mkdir(directory, { recursive: true });
    const staging = await NodeFSP.mkdtemp(NodePath.join(directory, ".install-"));
    try {
      const staged = NodePath.join(staging, HYPRLAND_CAPTURE_EXECUTABLE);
      await NodeFSP.writeFile(staged, bundle, { mode: 0o755, flag: "wx" });
      await NodeFSP.rename(staged, executable);
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true });
    }
  }
}

const Dimension = Schema.Int.check(Schema.isGreaterThan(0));
const Bounds = Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Dimension, height: Dimension });
const decodeCapture = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      window: Schema.NullOr(
        Schema.Struct({
          title: Schema.String,
          appName: Schema.String,
          appIdentifier: Schema.String,
          processId: Dimension,
          bounds: Bounds,
          clientBounds: Bounds,
        }),
      ),
    }),
  ),
);

export async function captureHyprlandWindow(
  paths: HyprlandCapturePaths,
  options?: { readonly flash: boolean; readonly animate: boolean },
): Promise<LinuxWindowSnapshot> {
  const state = await new HyprlandCaptureSetup(paths).state();
  if (state.status !== "ready")
    throw new Error(`${state.message} Open Settings → SnapShots to continue setup.`);
  const executable = hyprlandCaptureExecutable(paths);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hyprland-capture-"));
  const cleanup = () => NodeFSP.rm(directory, { recursive: true, force: true });
  let retained = false;
  try {
    const result = decodeCapture(await run(executable, ["capture", directory]));
    const png = await readPortalPng(
      NodeURL.pathToFileURL(NodePath.join(directory, "capture.png")).href,
    );
    const effects =
      state.feedbackAvailable && result.window && options && (options.flash || options.animate)
        ? await startNativeCaptureFeedback(executable, directory, {
            bounds: result.window.bounds,
            pid: process.pid,
            ...options,
          }).catch(() => undefined)
        : undefined;
    if (effects) {
      retained = true;
      void effects.closed.then(cleanup).catch(() => undefined);
    }
    const activation = new AbortController();
    let targetTitle = "";
    return {
      png,
      ...(result.window ? { window: result.window } : {}),
      feedback: {
        animationStarted: effects?.animationStarted ?? false,
        activate: async (title) => {
          targetTitle = title;
          await run(executable, ["activate", String(process.pid), title], activation.signal);
        },
        animateTo: async (frame) => {
          await effects?.animateTo(targetTitle, frame);
        },
        complete: async () => {
          await effects?.complete();
          activation.abort();
          await cleanup();
        },
        close: () => {
          effects?.close();
          activation.abort();
        },
      },
    };
  } finally {
    if (!retained) await cleanup();
  }
}
