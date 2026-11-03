import type { ComponentType, Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

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
  readonly ref?: Ref<NativeTerminalSurfaceHandle>;
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
  readonly initialBuffer: string;
  readonly fontSize: number;
  /** `[cols, rows]` of the shared PTY, or empty before the server reports one. */
  readonly sharedGrid?: ReadonlyArray<number>;
  readonly onInput?: (event: NativeSyntheticEvent<TerminalInputEvent>) => void;
  readonly onResize?: (event: NativeSyntheticEvent<TerminalResizeEvent>) => void;
}

export interface NativeTerminalSurfaceHandle {
  readonly writeOutput: (data: string, reset: boolean) => Promise<void>;
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

export function supportsNativeTerminalOutput(): boolean {
  try {
    const module = requireOptionalNativeModule<{ readonly outputRevision?: number }>(
      NATIVE_TERMINAL_MODULE_NAME,
    );
    return (module?.outputRevision ?? 0) >= 1 && hasNativeTerminalSurface();
  } catch {
    return false;
  }
}
