import { Platform } from "react-native";
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED = Platform.OS === "ios" && Platform.isPad;
export const NATIVE_METRICS_TIMEOUT_MS = 0;

export function nativeWorkspaceColumnsSupportedFor(_metrics: unknown) {
  return NATIVE_WORKSPACE_COLUMNS_SUPPORTED;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- Non-iOS stub of a hook; the .ios.tsx file calls hooks.
export function useNativeWorkspaceColumnsReady() {
  return true;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- Non-iOS stub of a hook; the .ios.tsx file calls hooks.
export function useNativeWorkspaceColumnsSupported() {
  return NATIVE_WORKSPACE_COLUMNS_SUPPORTED;
}
