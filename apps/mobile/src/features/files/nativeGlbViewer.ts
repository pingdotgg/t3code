import type { NativeSyntheticEvent, ViewProps } from "react-native";

import { createNativeViewResolver } from "../../native/resolveNativeView";

const NATIVE_GLB_VIEWER_MODULE_NAME = "T3GlbViewer";

interface GlbViewerErrorEvent {
  readonly message?: string;
}

interface GlbViewerLoadEvent {
  /** True when the model carries an animation that a tap can replay. */
  readonly hasAnimation?: boolean;
}

export interface NativeGlbViewerProps extends ViewProps {
  readonly uri: string;
  readonly backgroundColor: string;
  readonly onLoadStart?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  readonly onLoad?: (event: NativeSyntheticEvent<GlbViewerLoadEvent>) => void;
  readonly onError?: (event: NativeSyntheticEvent<GlbViewerErrorEvent>) => void;
}

export const resolveNativeGlbViewer = createNativeViewResolver<NativeGlbViewerProps>(
  NATIVE_GLB_VIEWER_MODULE_NAME,
);

/**
 * True when the installed binary can render GLB models. Only Android registers the native view, so
 * this also answers "is this platform supported" without a `Platform.OS` check at the call site.
 */
export function hasNativeGlbViewer(): boolean {
  return resolveNativeGlbViewer() !== null;
}
