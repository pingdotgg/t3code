import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { useNativeLayoutMetrics } from "./native-layout-metrics";

const nativeControls = requireOptionalNativeModule<{
  readonly supportsWorkspaceColumns?: boolean;
  readonly ViewPrototypes?: { readonly T3NativeControls_LayoutMetrics?: unknown };
}>("T3NativeControls");
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Platform.OS === "ios" && Platform.isPad && nativeControls?.supportsWorkspaceColumns === true;

export function useNativeWorkspaceColumnsReady() {
  const metrics = useNativeLayoutMetrics();
  // Choose the phone's native host before attaching any screens. Older clients
  // without the observer can immediately use the compact navigator.
  return (
    (Platform.OS === "ios" && Platform.isPad) ||
    !nativeControls?.ViewPrototypes?.T3NativeControls_LayoutMetrics ||
    metrics !== null
  );
}

export function useNativeWorkspaceColumnsSupported() {
  const metrics = useNativeLayoutMetrics();
  return (
    NATIVE_WORKSPACE_COLUMNS_SUPPORTED ||
    (nativeControls?.supportsWorkspaceColumns === true && metrics?.hasHinge === true)
  );
}
