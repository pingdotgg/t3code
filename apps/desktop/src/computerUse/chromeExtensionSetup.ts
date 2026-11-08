// @effect-diagnostics nodeBuiltinImport:off - Chrome launch and a small state file from Electron main, outside any Effect runtime.
// @effect-diagnostics globalTimers:off - the launch-time attempt waits for the app to settle.
// @effect-diagnostics globalDate:off - attempt timestamps in a plain JSON state file.
/**
 * Puts MT Code's Chrome extension into the user's Chrome without asking them
 * to load it by hand: munim-computer-use drives chrome://extensions → Developer
 * mode → Load unpacked (see chromeExtensionDriver.ts).
 *
 * At launch this runs once, only when Chrome is installed and used, the
 * extension is in no profile, and MT Code has never seen it installed (an
 * extension that disappears after being seen was removed by the user, and
 * stays removed). Settings → Computer Use can also run it on demand.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MTCODE_CHROME_EXTENSION_ID,
  MTCODE_DESKTOP_ENV_PREFIX,
  mtcodeDesktopProfileEnv,
} from "@t3tools/shared/munimComputerUse";
import * as Electron from "electron";

import {
  resolveDesktopMcpBinaryPathSync,
  syncChromeExtensionCopySync,
} from "../computerHistory/resolveBinary.ts";
import {
  chromeSetupPageUrl,
  driveLoadUnpacked,
  startComputerUseClient,
} from "./chromeExtensionDriver.ts";
import { ensureChromeNativeHostRegistered } from "./nativeHost.ts";
import { isChromeExtensionInstalled } from "./permissions.ts";

const STATE_FILE = "chrome-extension-setup.json";
const MARKER_TITLE = "MT Code is adding its Chrome extension";
/** Launch-time attempts before MT Code stops trying on its own. */
const MAX_AUTOMATIC_ATTEMPTS = 3;
/** Let the window, backend and the user's own startup settle first. */
const LAUNCH_DELAY_MS = 20_000;
/** `MTCODE_CHROME_EXTENSION_AUTOINSTALL=0` turns the launch-time attempt off; `=1` allows it in dev. */
const AUTOINSTALL_ENV = "MTCODE_CHROME_EXTENSION_AUTOINSTALL";

export interface ChromeExtensionSetupState {
  /** MT Code has seen the extension installed at least once. */
  readonly seenInstalled?: boolean;
  readonly automaticAttempts?: number;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
  readonly installedAt?: string;
}

export type AutoInstallDecision =
  | { readonly run: true }
  | {
      readonly run: false;
      readonly reason: "installed" | "removed-by-user" | "gave-up" | "disabled";
    };

/** Whether the launch-time attempt should run, from the saved state and what is installed now. */
export function decideAutoInstall(
  state: ChromeExtensionSetupState,
  installedNow: boolean,
  env: Readonly<Record<string, string | undefined>>,
  isDevelopment: boolean,
): AutoInstallDecision {
  if (installedNow) return { run: false, reason: "installed" };
  const flag = env[AUTOINSTALL_ENV]?.trim();
  if (flag === "0" || (isDevelopment && flag !== "1")) return { run: false, reason: "disabled" };
  if (state.seenInstalled) return { run: false, reason: "removed-by-user" };
  if ((state.automaticAttempts ?? 0) >= MAX_AUTOMATIC_ATTEMPTS) {
    return { run: false, reason: "gave-up" };
  }
  return { run: true };
}

function readState(stateDir: string): ChromeExtensionSetupState {
  try {
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, STATE_FILE), "utf8"),
    ) as ChromeExtensionSetupState;
  } catch {
    return {};
  }
}

function writeState(stateDir: string, state: ChromeExtensionSetupState) {
  try {
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, STATE_FILE),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Losing the state only means one more attempt later.
  }
}

/** Google Chrome's executable, when it is installed. */
export function findChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string | undefined {
  const candidates: string[] = [];
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (base)
        candidates.push(NodePath.win32.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    candidates.push(`/Applications/${app}`, NodePath.join(NodeOS.homedir(), "Applications", app));
  } else {
    for (const directory of (env.PATH ?? "").split(":").filter(Boolean)) {
      for (const name of ["google-chrome", "google-chrome-stable"]) {
        candidates.push(NodePath.posix.join(directory, name));
      }
    }
    candidates.push("/opt/google/chrome/google-chrome");
  }
  return candidates.find((candidate) => exists(candidate));
}

/** Chrome has a user data dir, i.e. someone has actually used it here. */
function chromeHasBeenUsed(): boolean {
  const home = NodeOS.homedir();
  const root =
    process.platform === "win32"
      ? NodePath.join(
          process.env.LOCALAPPDATA ?? NodePath.join(home, "AppData", "Local"),
          "Google",
          "Chrome",
          "User Data",
        )
      : process.platform === "darwin"
        ? NodePath.join(home, "Library", "Application Support", "Google", "Chrome")
        : NodePath.join(
            process.env.XDG_CONFIG_HOME ?? NodePath.join(home, ".config"),
            "google-chrome",
          );
  return NodeFS.existsSync(NodePath.join(root, "Local State"));
}

export interface ChromeExtensionInstallResult {
  readonly ok: boolean;
  readonly detail: string;
}

let running: Promise<ChromeExtensionInstallResult> | undefined;

/**
 * Load the extension into Chrome now. Opens a Chrome window, drives it, and
 * leaves the extensions page open on success so the user sees the result.
 */
export function installChromeExtensionNow(stateDir: string): Promise<ChromeExtensionInstallResult> {
  running ??= runInstall(stateDir).finally(() => {
    running = undefined;
  });
  return running;
}

async function runInstall(stateDir: string): Promise<ChromeExtensionInstallResult> {
  if (isChromeExtensionInstalled()) {
    writeState(stateDir, { ...readState(stateDir), seenInstalled: true });
    return { ok: true, detail: "The Chrome extension is already installed." };
  }
  const chrome = findChromeExecutable();
  if (!chrome) return { ok: false, detail: "Google Chrome is not installed." };
  const binary = resolveDesktopMcpBinaryPathSync();
  if (!binary)
    return { ok: false, detail: "MT Code's desktop control is missing from this install." };
  if (
    process.platform === "darwin" &&
    !Electron.systemPreferences.isTrustedAccessibilityClient(false)
  ) {
    return {
      ok: false,
      detail: "MT Code needs the Accessibility permission to set up the Chrome extension.",
    };
  }
  const extensionDir = syncChromeExtensionCopySync(stateDir);
  if (!extensionDir) return { ok: false, detail: "The bundled Chrome extension is missing." };

  // Without the native host the extension loads but cannot reach MT Code.
  await ensureChromeNativeHostRegistered();

  const helperEnv = {
    ...process.env,
    ...mtcodeDesktopProfileEnv(),
    // This helper only drives Chrome's UI; leave the browser bridge to the
    // desktop-control servers MT Code runs for agents.
    [`${MTCODE_DESKTOP_ENV_PREFIX}BROWSER`]: "0",
  };
  const client = await startComputerUseClient(binary, helperEnv);
  // The macOS open panel only hears real keyboard input (see the driver).
  const realKeys =
    process.platform === "darwin"
      ? await startComputerUseClient(binary, {
          ...helperEnv,
          [`${MTCODE_DESKTOP_ENV_PREFIX}REMOTE_CONTROL`]: "1",
        }).catch(() => undefined)
      : undefined;
  try {
    const child = NodeChildProcess.spawn(
      chrome,
      ["--new-window", chromeSetupPageUrl(MARKER_TITLE)],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.on("error", () => {});
    child.unref();

    await driveLoadUnpacked({
      client,
      platform: process.platform,
      extensionDir,
      extensionId: MTCODE_CHROME_EXTENSION_ID,
      markerTitle: MARKER_TITLE,
      ...(realKeys ? { realKeys } : {}),
      log: (line) => process.stderr.write(`[chrome-extension-setup] ${line}\n`),
    });
    writeState(stateDir, {
      ...readState(stateDir),
      seenInstalled: true,
      installedAt: new Date().toISOString(),
    });
    return { ok: true, detail: "Added the MT Code extension to Chrome." };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeState(stateDir, { ...readState(stateDir), lastError: detail });
    return { ok: false, detail: `Could not add the extension automatically: ${detail}` };
  } finally {
    client.close();
    realKeys?.close();
  }
}

function notify(title: string, body: string) {
  try {
    if (Electron.Notification.isSupported()) new Electron.Notification({ title, body }).show();
  } catch {
    // A missing notification never blocks setup.
  }
}

/**
 * The launch-time attempt: after a short delay, install the extension when
 * {@link decideAutoInstall} says so. Never throws.
 */
export function scheduleChromeExtensionAutoInstall(options: {
  readonly stateDir: string;
  readonly isDevelopment: boolean;
}): void {
  setTimeout(() => {
    void (async () => {
      try {
        const state = readState(options.stateDir);
        const installed = isChromeExtensionInstalled();
        const decision = decideAutoInstall(state, installed, process.env, options.isDevelopment);
        if (!decision.run) {
          if (installed && !state.seenInstalled) {
            writeState(options.stateDir, { ...state, seenInstalled: true });
          }
          // Keep the copy Chrome loads current with this MT Code build.
          if (installed) syncChromeExtensionCopySync(options.stateDir);
          return;
        }
        if (!findChromeExecutable() || !chromeHasBeenUsed()) return;
        if (
          process.platform === "darwin" &&
          !Electron.systemPreferences.isTrustedAccessibilityClient(false)
        ) {
          return;
        }

        writeState(options.stateDir, {
          ...state,
          automaticAttempts: (state.automaticAttempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        });
        notify(
          "Adding the MT Code Chrome extension",
          "Chrome will open for a moment while MT Code sets it up.",
        );
        const result = await installChromeExtensionNow(options.stateDir);
        notify(
          result.ok ? "Chrome extension added" : "Chrome extension not added",
          result.ok
            ? "Agents can now work in your Chrome tabs."
            : "Set it up from Settings → Computer Use.",
        );
      } catch (error) {
        process.stderr.write(`[chrome-extension-setup] skipped: ${String(error)}\n`);
      }
    })();
  }, LAUNCH_DELAY_MS).unref?.();
}
