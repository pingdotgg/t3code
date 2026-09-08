// @effect-diagnostics nodeBuiltinImport:off -- KDE authorizes a dedicated, installed native executable.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import type { DesktopCaptureHelperState } from "@t3tools/contracts";

import { escapeDesktopEntryExecArgument } from "../app/DesktopLinuxUrlHandler.ts";
import type { LinuxWindowSnapshot } from "./LinuxSnapShot.ts";
import { readPortalPng } from "./linuxCaptureSession.ts";
import { startNativeCaptureFeedback } from "./NativeCaptureFeedback.ts";
export { isKdeCaptureSession } from "./linuxCaptureSession.ts";

export const KDE_CAPTURE_EXECUTABLE = "t3-kde-snap-shot";
const DESKTOP_FILE = "com.t3tools.T3Code.KdeCapture.desktop";
const MARKER = "X-T3Code-Capture-Helper=true";
const decodeCapabilities = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ feedbackAvailable: Schema.optional(Schema.Boolean) })),
);
export type KdeCapturePaths = { readonly bundle: string; readonly dataHome: string };

export function kdeCapturePaths(paths: KdeCapturePaths) {
  return {
    executable: NodePath.join(paths.dataHome, "t3code", "kde-capture", KDE_CAPTURE_EXECUTABLE),
    desktop: NodePath.join(paths.dataHome, "applications", DESKTOP_FILE),
  };
}

export function kdeCaptureDesktopEntry(executable: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=T3 Code SnapShots",
    "NoDisplay=true",
    `Exec=${escapeDesktopEntryExecArgument(executable)} check`,
    // KService reads this custom property as a KConfig list, not an XDG ';' list.
    "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2",
    MARKER,
    "",
  ].join("\n");
}

function run(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      executable,
      args,
      {
        timeout: 20_000,
        maxBuffer: 128 * 1024,
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (executable === "kbuildsycoca6") {
          reject(
            new Error(
              "KDE couldn't register the capture helper. Make sure KDE's service tools (kbuildsycoca6) are installed, then reinstall the helper.",
            ),
          );
          return;
        }
        if (stderr.includes("NoAuthorized")) {
          reject(
            new Error(
              "KDE hasn't granted capture access. Reinstall the capture helper in setup, then try again.",
            ),
          );
        } else
          reject(
            new Error(
              stderr.trim() ||
                "The KDE capture helper did not respond. Reopen capture setup and check access.",
            ),
          );
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
    throw new Error(
      "Capture helper files must be regular files. Remove the conflicting link before trying again.",
    );
  return NodeFSP.readFile(path);
}

/** No install on launch: writes happen only after the user chooses Install helper. */
export class KdeCaptureSetup {
  private readonly paths: KdeCapturePaths;
  constructor(paths: KdeCapturePaths) {
    this.paths = paths;
  }

  async state(): Promise<DesktopCaptureHelperState> {
    try {
      const { executable, desktop } = kdeCapturePaths(this.paths);
      const [installed, entry] = await Promise.all([regularFile(executable), regularFile(desktop)]);
      if (!installed || !entry)
        return {
          status: "not-installed",
          message:
            "Install the bundled helper to capture the window you're using without a picker.",
        };
      const bundle = await regularFile(this.paths.bundle);
      if (!bundle)
        return {
          status: "error",
          message: "The capture helper is missing from this build. Update or reinstall T3 Code.",
        };
      if (!installed.equals(bundle) || entry.toString() !== kdeCaptureDesktopEntry(executable))
        return {
          status: "update-required",
          message: "Update the bundled capture helper to continue.",
        };
      const capabilities = decodeCapabilities(await run(executable, ["check"]));
      return {
        status: "ready",
        message: "KDE capture access is ready. Next, choose your shortcut.",
        feedbackAvailable: capabilities.feedbackAvailable ?? false,
      };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Couldn't check KDE capture access.",
      };
    }
  }

  async perform(action: "install-kde-helper" | "remove-kde-helper") {
    const { executable, desktop } = kdeCapturePaths(this.paths);
    const entry = await regularFile(desktop);
    if (entry && !entry.toString().split("\n").includes(MARKER))
      throw new Error(
        "Another desktop entry uses the capture helper's name. Rename it before continuing.",
      );
    // Never overwrite/follow a symlink, including the installation directory itself.
    const directory = NodePath.dirname(executable);
    const existing = await NodeFSP.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error("The capture helper directory is not a regular directory.");
    await regularFile(executable);
    if (action === "remove-kde-helper") {
      if (entry) await NodeFSP.unlink(desktop);
      await NodeFSP.unlink(executable).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      const bundle = await regularFile(this.paths.bundle);
      if (!bundle)
        throw new Error(
          "The capture helper is missing from this build. Update or reinstall T3 Code.",
        );
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.mkdir(NodePath.dirname(desktop), { recursive: true });
      const staging = await NodeFSP.mkdtemp(NodePath.join(directory, ".install-"));
      const stagedDesktop = `${desktop}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        const staged = NodePath.join(staging, KDE_CAPTURE_EXECUTABLE);
        await NodeFSP.writeFile(staged, bundle, { mode: 0o755 });
        await NodeFSP.rename(staged, executable);
        await NodeFSP.writeFile(stagedDesktop, kdeCaptureDesktopEntry(executable), {
          mode: 0o644,
          flag: "wx",
        });
        await NodeFSP.rename(stagedDesktop, desktop);
      } finally {
        await NodeFSP.rm(stagedDesktop, { force: true });
        await NodeFSP.rm(staging, { recursive: true, force: true });
      }
    }
    // KService must see the new desktop entry before KWin checks the executable.
    await run("kbuildsycoca6", ["--noincremental"]);
    // AppImages change XDG search paths, and KService caches are also locale-specific.
    // Refresh Plasma's cache in its session environment, not just the app's cache.
    // Non-systemd sessions use the direct refresh and atomic directory notification above.
    await run("systemd-run", [
      "--user",
      "--quiet",
      "--wait",
      "--collect",
      "--pipe",
      "--service-type=exec",
      "kbuildsycoca6",
      "--noincremental",
    ]).catch(() => undefined);
  }
}

const Dimension = Schema.Int.check(Schema.isGreaterThan(0));
const Bounds = Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Dimension, height: Dimension });
const Window = Schema.Struct({
  title: Schema.String,
  appName: Schema.String,
  appIdentifier: Schema.String,
  processId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bounds: Bounds,
  clientBounds: Bounds,
});
const decodeCapture = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ window: Schema.NullOr(Window) })),
);

export async function captureKdeWindow(
  paths: KdeCapturePaths,
  options?: { readonly flash: boolean; readonly animate: boolean },
): Promise<LinuxWindowSnapshot> {
  const state = await new KdeCaptureSetup(paths).state();
  if (state.status !== "ready")
    throw new Error(`${state.message} Open Settings → SnapShots to continue setup.`);
  const { executable } = kdeCapturePaths(paths);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-kde-capture-"));
  let retained = false;
  const cleanup = () => NodeFSP.rm(directory, { recursive: true, force: true });
  try {
    const result = decodeCapture(await run(executable, ["capture", directory]));
    const png = await readPortalPng(
      NodeURL.pathToFileURL(NodePath.join(directory, "capture.png")).href,
    );
    const feedback = new AbortController();
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
    let targetTitle = "";
    const close = () => {
      effects?.close();
      feedback.abort();
    };
    return {
      png,
      ...(result.window ? { window: result.window } : {}),
      feedback: {
        animationStarted: effects?.animationStarted ?? false,
        activate: async (title) => {
          targetTitle = title;
          const activation = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "t3-kde-activate-"),
          );
          try {
            await run(
              executable,
              ["activate", activation, String(process.pid), title],
              feedback.signal,
            );
          } finally {
            await NodeFSP.rm(activation, { recursive: true, force: true });
          }
        },
        animateTo: async (frame) => {
          await effects?.animateTo(targetTitle, frame);
        },
        complete: async () => {
          await effects?.complete();
          feedback.abort();
          await cleanup();
        },
        close,
      },
    };
  } finally {
    if (!retained) await cleanup();
  }
}
