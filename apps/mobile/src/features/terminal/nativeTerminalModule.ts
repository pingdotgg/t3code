import type { ComponentType, Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

import { NativeViewResolutionError } from "../../native/nativeViewResolutionError";

const NATIVE_TERMINAL_MODULE_NAME = "T3TerminalSurface";
export const NATIVE_TERMINAL_STREAMING_REVISION = 1;
export const NATIVE_TERMINAL_REPLAY_STREAMING_REVISION = 2;

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
  readonly ref?: Ref<NativeTerminalSurfaceHandle>;
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

export interface NativeTerminalSurfaceHandle {
  readonly write?: (data: string) => Promise<void>;
  readonly writeReplay?: (data: string) => Promise<void>;
  readonly reset?: (data: string) => Promise<void>;
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

/** Revision 2 adds replay-safe append commands to the revision 1 streaming API. */
export function getNativeTerminalStreamingRevision(): number | null {
  try {
    if (typeof requireOptionalNativeModule !== "function") {
      return null;
    }
    const module = requireOptionalNativeModule<{ readonly streamingRevision?: number }>(
      NATIVE_TERMINAL_MODULE_NAME,
    );
    return module?.streamingRevision ?? null;
  } catch {
    return null;
  }
}

export function hasNativeTerminalSurface() {
  return resolveNativeTerminalSurfaceView() !== null;
}

/** Whether the installed native binary can render a streamed extended replay. */
export function supportsNativeReplayStreaming(): boolean {
  return (getNativeTerminalStreamingRevision() ?? 0) >= NATIVE_TERMINAL_REPLAY_STREAMING_REVISION;
}
