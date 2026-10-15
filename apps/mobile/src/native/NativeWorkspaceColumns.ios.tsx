import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { useNativeLayoutMetrics } from "./native-layout-metrics";

const nativeControls = requireOptionalNativeModule<{
  readonly supportsWorkspaceColumns?: boolean;
  readonly ViewPrototypes?: { readonly T3NativeControls_LayoutMetrics?: unknown };
}>("T3NativeControls");
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Platform.OS === "ios" && Platform.isPad && nativeControls?.supportsWorkspaceColumns === true;

// Binaries without the native no-hinge fallback never report metrics on ordinary
// iPhones running iOS 27.1 or later. Use the compact navigator rather than staying blank.
const NATIVE_METRICS_TIMEOUT_MS = 1000;

export function useNativeWorkspaceColumnsReady() {
  const metrics = useNativeLayoutMetrics();
  const [timedOut, setTimedOut] = useState(false);
  // Choose the phone's native host before attaching any screens. Older clients
  // without the observer can immediately use the compact navigator.
  const waiting =
    !(Platform.OS === "ios" && Platform.isPad) &&
    !!nativeControls?.ViewPrototypes?.T3NativeControls_LayoutMetrics &&
    metrics === null;

  useEffect(() => {
    if (!waiting) return;
    const timeout = setTimeout(() => setTimedOut(true), NATIVE_METRICS_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [waiting]);

  return !waiting || timedOut;
}

export function useNativeWorkspaceColumnsSupported() {
  const metrics = useNativeLayoutMetrics();
  return (
    NATIVE_WORKSPACE_COLUMNS_SUPPORTED ||
    (nativeControls?.supportsWorkspaceColumns === true && metrics?.hasHinge === true)
  );
}
