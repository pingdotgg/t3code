import type { ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView } from "expo";

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

export function hasNativeTerminalSurface() {
  return resolveNativeTerminalSurfaceView() !== null;
}
