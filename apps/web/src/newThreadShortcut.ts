import { isElectron } from "./env";
import { isMacPlatform } from "./lib/utils";

export function getNewThreadShortcutHint(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): ReadonlyArray<string> | undefined {
  if (!isElectron) return undefined;
  return [isMacPlatform(platform) ? "Command" : "Ctrl", "T"];
}

export function isNewThreadShortcut(event: globalThis.KeyboardEvent): boolean {
  if (!isElectron) return false;
  if (event.defaultPrevented || event.repeat) return false;
  if (event.shiftKey || event.altKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === "t";
}
