import type { FolderResult } from "../src/connection/engineState";
import { type LinuxHost, shellQuote } from "./wslEngine";

type ShellHost = Pick<LinuxHost, "shell">;

const WINDOWS_PATH = /^([A-Za-z]:[\\/]|\\\\)/;
// /mnt/c and its siblings are the Windows drives, which T3 in WSL should not own projects on.
const DRIVE_MOUNT = /^\/mnt\/[a-z](\/|$)/;
const OUTSIDE_WSL = "That folder is outside WSL. Pick one inside the Linux distro, such as /home.";

/** Turns what the user typed or picked into a folder path inside WSL, or says why it is not one. */
export async function resolveFolder(host: ShellHost, input: string): Promise<FolderResult> {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "Enter a folder path." };

  let path = text;
  if (WINDOWS_PATH.test(text)) {
    const converted = await host.shell(`wslpath -u ${shellQuote(text)}`);
    if (converted.exitCode !== 0) return { ok: false, reason: OUTSIDE_WSL };
    path = converted.stdout.trim();
  } else if (!text.startsWith("/")) {
    return { ok: false, reason: "Use an absolute WSL path, such as /home/me/project." };
  }
  if (DRIVE_MOUNT.test(path)) return { ok: false, reason: OUTSIDE_WSL };

  path = path.replace(/\/+$/, "") || "/";
  const checked = await host.shell(`test -d ${shellQuote(path)}`);
  if (checked.exitCode !== 0) return { ok: false, reason: `${path} is not a folder in WSL.` };
  return { ok: true, path };
}

/**
 * Starts the picker in the user's WSL home. `choose` shows the dialog and returns the chosen
 * folder, or null when the user cancels, which is not an error.
 */
export async function pickFolder(options: {
  readonly host: ShellHost;
  readonly platform: NodeJS.Platform;
  readonly choose: (startAt: string | undefined) => Promise<string | null>;
}): Promise<FolderResult | null> {
  // Windows reaches the distro's files at \\wsl.localhost\<distro>\home\<user>, which wslpath -w prints.
  const home = await options.host.shell(
    options.platform === "win32" ? 'wslpath -w "$HOME"' : 'printf %s "$HOME"',
  );
  const startAt = home.exitCode === 0 ? home.stdout.trim() || undefined : undefined;
  const chosen = await options.choose(startAt);
  return chosen === null ? null : resolveFolder(options.host, chosen);
}
