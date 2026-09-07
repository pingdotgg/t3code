import { execFile } from "node:child_process";

import type * as Electron from "electron";

const GTK_FRAME_EXTENTS_HINT = "_GTK_FRAME_EXTENTS";
const XPROP_TIMEOUT_MS = 250;

type WindowEnvironment = Readonly<
  Pick<NodeJS.ProcessEnv, "DISPLAY" | "WAYLAND_DISPLAY" | "XDG_SESSION_TYPE">
>;

export type XpropRunner = (
  callback: (error: Error | null, stdout: string) => void,
) => { readonly kill: (signal: NodeJS.Signals) => boolean };

type ResolveLinuxX11WindowFrameOptionsInput = {
  readonly options: Electron.BrowserWindowConstructorOptions;
  readonly platform: NodeJS.Platform;
  readonly env: WindowEnvironment;
  readonly ozonePlatform?: string | null;
  readonly readWmSupportedHints?: () => Promise<string | null> | string | null;
};

export function isLinuxX11Session(
  platform: NodeJS.Platform,
  env: WindowEnvironment,
  ozonePlatform?: string | null,
): boolean {
  if (platform !== "linux") {
    return false;
  }

  const forcedOzonePlatform = ozonePlatform?.trim().toLowerCase();
  if (forcedOzonePlatform === "x11") {
    return true;
  }
  if (forcedOzonePlatform === "wayland") {
    return false;
  }

  const sessionType = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (sessionType === "wayland" || env.WAYLAND_DISPLAY?.trim()) {
    return false;
  }
  if (sessionType === "x11") {
    return true;
  }

  return Boolean(env.DISPLAY?.trim());
}

export function readX11WmSupportedHints(
  env: NodeJS.ProcessEnv = process.env,
  runXprop: XpropRunner = (callback) =>
    execFile(
      "xprop",
      ["-root", "_NET_SUPPORTED"],
      {
        encoding: "utf8",
        env,
      },
      (error, stdout) => callback(error, typeof stdout === "string" ? stdout : ""),
    ),
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve(value);
    };

    try {
      const child = runXprop((error, stdout) => {
        finish(error === null ? stdout : null);
      });
      if (settled) {
        return;
      }
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The hard deadline is authoritative even if the child already exited.
        }
        finish(null);
      }, XPROP_TIMEOUT_MS);
    } catch {
      finish(null);
    }
  });
}

function hasGtkFrameExtentsHint(supportedHints: string): boolean {
  return supportedHints.split(/[\s,=]+/).includes(GTK_FRAME_EXTENTS_HINT);
}

export async function resolveLinuxX11WindowFrameOptions(
  input: ResolveLinuxX11WindowFrameOptionsInput,
): Promise<Electron.BrowserWindowConstructorOptions> {
  const { options } = input;
  const usesHiddenTitleBar =
    options.frame !== true &&
    options.titleBarStyle === "hidden" &&
    options.titleBarOverlay !== undefined &&
    options.titleBarOverlay !== false;

  if (
    !usesHiddenTitleBar ||
    !isLinuxX11Session(input.platform, input.env, input.ozonePlatform)
  ) {
    return options;
  }

  let supportedHints: string | null;
  try {
    supportedHints = await (input.readWmSupportedHints ?? (() => readX11WmSupportedHints()))();
  } catch {
    return options;
  }
  if (supportedHints === null || hasGtkFrameExtentsHint(supportedHints)) {
    return options;
  }

  const nativeFrameOptions = { ...options, frame: true };
  delete nativeFrameOptions.titleBarStyle;
  delete nativeFrameOptions.titleBarOverlay;
  return nativeFrameOptions;
}
