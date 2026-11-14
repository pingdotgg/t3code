import type { ScopedThreadRef } from "@t3tools/contracts";
import type { GhosttyTerminalSurface } from "./ghostty/surface";

export const SCRIPT_PASTE_READY_TIMEOUT_MS = 5_000;
export const SCRIPT_PASTE_UNSUPPORTED_MESSAGE =
  "This terminal can't run multi-line scripts. Copy the script instead.";

type ScriptPasteTarget = ScopedThreadRef & { terminalId: string };
type ScriptPasteSurface = Pick<GhosttyTerminalSurface, "encodeScriptPaste" | "subscribeOutput">;

const surfaces = new Map<string, ScriptPasteSurface>();
const listeners = new Map<string, Set<() => void>>();

function targetKey(target: ScriptPasteTarget): string {
  return JSON.stringify([target.environmentId, target.threadId, target.terminalId]);
}

export function registerTerminalScriptPasteSurface(
  target: ScriptPasteTarget,
  surface: ScriptPasteSurface,
): () => void {
  const key = targetKey(target);
  const notify = () => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  surfaces.set(key, surface);
  const unsubscribe = surface.subscribeOutput(notify);
  notify();
  return () => {
    unsubscribe();
    if (surfaces.get(key) === surface) surfaces.delete(key);
  };
}

export function encodeTerminalScriptPaste(
  target: ScriptPasteTarget,
  script: string,
): Promise<string> {
  const key = targetKey(target);
  return new Promise((resolve, reject) => {
    const pending = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, pending);
    const cleanup = () => {
      clearTimeout(timeout);
      pending.delete(tryEncode);
      if (pending.size === 0) listeners.delete(key);
    };
    const tryEncode = () => {
      const data = surfaces.get(key)?.encodeScriptPaste(script);
      if (data == null) return;
      cleanup();
      resolve(data);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(SCRIPT_PASTE_UNSUPPORTED_MESSAGE));
    }, SCRIPT_PASTE_READY_TIMEOUT_MS);
    pending.add(tryEncode);
    tryEncode();
  });
}
