import type * as Electron from "electron";
import type { configureBeforeReady } from "./configureBeforeReady.ts";

export interface DesktopBootState {
  readonly preReadyOptions: ReturnType<typeof configureBeforeReady>;
  readonly replayLinkEvents: () => void;
  readonly detachLinkListeners: () => void;
  window: Electron.BrowserWindow | undefined;
}

// Boot and main are separate bundles; share ownership without loading main before ready.
const key = Symbol.for("@t3tools/desktop/boot");
export function desktopBootState(): DesktopBootState | undefined {
  return Reflect.get(globalThis, key) as DesktopBootState | undefined;
}
export function setDesktopBootState(state: DesktopBootState | undefined): void {
  Reflect.set(globalThis, key, state);
}
