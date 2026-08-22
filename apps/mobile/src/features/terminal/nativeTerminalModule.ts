import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireOptionalNativeModule } from "expo";

import { createNativeViewResolver } from "../../native/resolveNativeView";

const NATIVE_TERMINAL_MODULE_NAME = "T3TerminalSurface";

interface TerminalInputEvent {
  readonly data: string;
}

interface TerminalResizeEvent {
  readonly cols: number;
  readonly rows: number;
}

export interface NativeTerminalSurfaceProps extends ViewProps {
  readonly appearanceScheme?: "light" | "dark";
  readonly autoFocus?: boolean;
  readonly focusRequest?: number;
  readonly themeConfig?: string;
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly mutedForegroundColor?: string;
  readonly terminalKey: string;
  readonly initialBuffer: string;
  readonly fontSize: number;
  readonly onInput?: (event: NativeSyntheticEvent<TerminalInputEvent>) => void;
  readonly onResize?: (event: NativeSyntheticEvent<TerminalResizeEvent>) => void;
}

export const resolveNativeTerminalSurfaceView =
  createNativeViewResolver<NativeTerminalSurfaceProps>(NATIVE_TERMINAL_MODULE_NAME);

/**
 * Revision of the native hardware-keyboard handling compiled into the installed binary,
 * or `null` when the binary predates the revision constant (or the module is missing).
 * Used in terminal debug logs to detect stale native builds.
 */
export function getNativeTerminalHardwareKeyRevision(): number | null {
  try {
    if (typeof requireOptionalNativeModule !== "function") {
      return null;
    }
    const module = requireOptionalNativeModule<{ readonly hardwareKeyRevision?: number }>(
      NATIVE_TERMINAL_MODULE_NAME,
    );
    return module?.hardwareKeyRevision ?? null;
  } catch {
    return null;
  }
}

export function hasNativeTerminalSurface() {
  return resolveNativeTerminalSurfaceView() !== null;
}
