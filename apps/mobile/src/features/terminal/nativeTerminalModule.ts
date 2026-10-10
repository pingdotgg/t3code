import type { ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

import type { TerminalBufferWrite } from "./useNativeTerminalBuffer";

import { NativeViewResolutionError } from "../../native/nativeViewResolutionError";

const NATIVE_TERMINAL_MODULE_NAME = "T3TerminalSurface";

interface ExpoGlobalWithViewConfig {
  readonly expo?: {
    getViewConfig?: (moduleName: string, viewName?: string) => unknown;
  };
}

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
  readonly readOnly?: boolean;
  readonly focusRequest?: number;
  readonly captureRequest?: number;
  readonly onCapture?: (event: NativeSyntheticEvent<{ readonly text: string }>) => void;
  readonly themeConfig?: string;
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly mutedForegroundColor?: string;
  readonly terminalKey: string;
  readonly initialBuffer?: string;
  readonly bufferWrite?: TerminalBufferWrite;
  readonly onBufferApplied?: (
    event: NativeSyntheticEvent<{ readonly generation: number; readonly offset: number }>,
  ) => void;
  readonly fontSize: number;
  readonly onInput?: (event: NativeSyntheticEvent<TerminalInputEvent>) => void;
  readonly onResize?: (event: NativeSyntheticEvent<TerminalResizeEvent>) => void;
}

let cachedNativeTerminalSurfaceView: ComponentType<NativeTerminalSurfaceProps> | undefined;
let nativeTerminalSurfaceViewResolutionFailed = false;

function getExpoViewConfig(moduleName: string) {
  return (globalThis as typeof globalThis & ExpoGlobalWithViewConfig).expo?.getViewConfig?.(
    moduleName,
  );
}

export function resolveNativeTerminalSurfaceView(): ComponentType<NativeTerminalSurfaceProps> | null {
  if (cachedNativeTerminalSurfaceView) {
    return cachedNativeTerminalSurfaceView;
  }

  if (nativeTerminalSurfaceViewResolutionFailed) {
    return null;
  }

  if (getExpoViewConfig(NATIVE_TERMINAL_MODULE_NAME) == null) {
    return null;
  }

  try {
    cachedNativeTerminalSurfaceView = requireNativeView<NativeTerminalSurfaceProps>(
      NATIVE_TERMINAL_MODULE_NAME,
    );
  } catch (cause) {
    nativeTerminalSurfaceViewResolutionFailed = true;
    console.error(
      new NativeViewResolutionError({
        nativeModuleName: NATIVE_TERMINAL_MODULE_NAME,
        cause,
      }),
    );
    return null;
  }

  return cachedNativeTerminalSurfaceView ?? null;
}

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

/** Older installed binaries must continue receiving the full-buffer prop. */
export function supportsNativeTerminalBufferStream(): boolean {
  try {
    return (
      (requireOptionalNativeModule<{ readonly bufferStreamRevision?: number }>(
        NATIVE_TERMINAL_MODULE_NAME,
      )?.bufferStreamRevision ?? 0) >= 1
    );
  } catch {
    return false;
  }
}
