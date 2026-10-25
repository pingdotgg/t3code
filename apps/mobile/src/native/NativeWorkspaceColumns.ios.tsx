import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import { useNativeLayoutMetrics } from "./native-layout-metrics";

const nativeControls = requireOptionalNativeModule<{
  readonly supportsWorkspaceColumns?: boolean;
  readonly ViewPrototypes?: { readonly T3NativeControls_LayoutMetrics?: unknown };
}>("T3NativeControls");
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Platform.OS === "ios" && Platform.isPad && nativeControls?.supportsWorkspaceColumns === true;

/** Whether a window with these metrics lays the workspace out in UIKit columns. */
export function nativeWorkspaceColumnsSupportedFor(metrics: NativeLayoutMetrics | null) {
  return (
    NATIVE_WORKSPACE_COLUMNS_SUPPORTED ||
    (nativeControls?.supportsWorkspaceColumns === true && metrics?.hasHinge === true)
  );
}

// Binaries without the native no-hinge fallback never report metrics on ordinary
// iPhones running iOS 27.1 or later. Use the compact navigator rather than staying blank.
export const NATIVE_METRICS_TIMEOUT_MS = 1000;

export function useNativeWorkspaceColumnsReady() {
  const metrics = useNativeLayoutMetrics();
  const [timedOut, setTimedOut] = useState(false);
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
  return nativeWorkspaceColumnsSupportedFor(useNativeLayoutMetrics());
}
