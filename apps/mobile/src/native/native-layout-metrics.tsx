import { createContext, use, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { deriveDeviceType, isDuoDevice, type DeviceType } from "../lib/device-type";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import { NativeLayoutObserver } from "./NativeLayoutObserver";

const IS_PAD = Platform.OS === "ios" && Platform.isPad;

const NativeLayoutContext = createContext<NativeLayoutMetrics | null>(null);
// Separate from the metrics so device checks skip every resize and safe-area update.
const DeviceTypeContext = createContext<DeviceType>(
  deriveDeviceType({ isPad: IS_PAD, metrics: null }),
);
// Binaries without the native no-hinge fallback never report metrics on ordinary
// iPhones running iOS 27.1 or later; consumers stop waiting at this deadline.
export const NATIVE_METRICS_TIMEOUT_MS = 1000;
const NativeLayoutMetricsDeadlineContext = createContext<number>(0);
// Column reservations come from UIKit's layout, outside the resizing navigator.
export const NativeColumnLayoutMetricsContext = createContext<NativeLayoutMetrics | null>(null);

// The latest metrics outside React, for decisions made before the first screen renders.
let latestMetrics: NativeLayoutMetrics | null = null;
const metricsWaiters = new Set<(metrics: NativeLayoutMetrics) => void>();

/** Resolves with the first native layout metrics, or null after `timeoutMs` without any. */
export function firstNativeLayoutMetrics(timeoutMs: number) {
  if (latestMetrics) return Promise.resolve(latestMetrics);
  return new Promise<NativeLayoutMetrics | null>((resolve) => {
    const settle = (metrics: NativeLayoutMetrics | null) => {
      metricsWaiters.delete(settle);
      clearTimeout(timeout);
      resolve(metrics);
    };
    const timeout = setTimeout(() => settle(null), timeoutMs);
    metricsWaiters.add(settle);
  });
}

export function currentNativeLayoutMetrics() {
  return latestMetrics;
}

export function NativeLayoutMetricsProvider(props: { readonly children: ReactNode }) {
  const [metrics, setMetrics] = useState<NativeLayoutMetrics | null>(null);
  const [metricsDeadline] = useState(() => Date.now() + NATIVE_METRICS_TIMEOUT_MS);
  const publish = (next: NativeLayoutMetrics) => {
    latestMetrics = next;
    for (const settle of metricsWaiters) settle(next);
    setMetrics(next);
  };
  const deviceType = deriveDeviceType({ isPad: IS_PAD, metrics });
  return (
    <NativeLayoutMetricsDeadlineContext value={metricsDeadline}>
      <NativeLayoutContext value={metrics}>
        <DeviceTypeContext value={deviceType}>
          <NativeLayoutObserver onChange={publish} />
          {props.children}
        </DeviceTypeContext>
      </NativeLayoutContext>
    </NativeLayoutMetricsDeadlineContext>
  );
}

export function useNativeLayoutMetrics() {
  return use(NativeLayoutContext);
}

/** Epoch ms after which a consumer still waiting for the first metrics gives up. */
export function useNativeLayoutMetricsDeadline() {
  return use(NativeLayoutMetricsDeadlineContext);
}

export function useNativeColumnLayoutMetrics() {
  return use(NativeColumnLayoutMetricsContext);
}

export function useDeviceType() {
  return use(DeviceTypeContext);
}

/**
 * Where the Duo's floating bottom controls end in this column. Its tab bar floats below the safe
 * area, and the controls beside it sit on the same line.
 */
export function useDuoBottomBarInset() {
  const deviceType = useDeviceType();
  const metrics = use(NativeColumnLayoutMetricsContext);
  // Sheets have no rail to align with and can report zero for the bar region.
  // Their controls must keep using the sheet's bottom safe area.
  const inset = metrics?.bottomBarInset;
  return isDuoDevice(deviceType) && inset !== undefined && inset > 0 ? inset : undefined;
}
