import type { ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

import { NativeViewResolutionError } from "../../native/nativeViewResolutionError";
import type { TerminalBufferWrite } from "./terminalBufferWrite";

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
  readonly focusRequest?: number;
  readonly themeConfig?: string;
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly mutedForegroundColor?: string;
  readonly terminalKey: string;
  readonly bufferWrite: TerminalBufferWrite;
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

function getNativeTerminalConstant(name: "hardwareKeyRevision" | "bufferStreamRevision") {
  try {
    if (typeof requireOptionalNativeModule !== "function") {
      return null;
    }
    const module = requireOptionalNativeModule<Partial<Record<typeof name, number>>>(
      NATIVE_TERMINAL_MODULE_NAME,
    );
    return module?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Revision of the native hardware-keyboard handling compiled into the installed binary,
 * or `null` when the binary predates the revision constant (or the module is missing).
 * Used in terminal debug logs to detect stale native builds.
 */
export function getNativeTerminalHardwareKeyRevision(): number | null {
  return getNativeTerminalConstant("hardwareKeyRevision");
}

/**
 * Revision of the incremental `bufferWrite` protocol the installed binary speaks,
 * or `null` when it only understands the removed full-buffer prop and needs a rebuild.
 */
export function getNativeTerminalBufferStreamRevision(): number | null {
  return getNativeTerminalConstant("bufferStreamRevision");
}

export function hasNativeTerminalSurface() {
  return resolveNativeTerminalSurfaceView() !== null;
}
