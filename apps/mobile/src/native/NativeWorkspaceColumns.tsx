import { Platform } from "react-native";
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED = Platform.OS === "ios" && Platform.isPad;

export function useNativeWorkspaceColumnsReady() {
  return true;
}

export function useNativeWorkspaceColumnsSupported() {
  return NATIVE_WORKSPACE_COLUMNS_SUPPORTED;
}
