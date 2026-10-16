import { createContext, use, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { deriveDeviceType, type DeviceType } from "../lib/device-type";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";
import { NativeLayoutObserver } from "./NativeLayoutObserver";

const IS_PAD = Platform.OS === "ios" && Platform.isPad;

const NativeLayoutContext = createContext<NativeLayoutMetrics | null>(null);
// Separate from the metrics so device checks skip every resize and safe-area update.
const DeviceTypeContext = createContext<DeviceType>(
  deriveDeviceType({ isPad: IS_PAD, metrics: null }),
);
// Column reservations come from UIKit's layout, outside the resizing navigator.
export const NativeColumnLayoutMetricsContext = createContext<NativeLayoutMetrics | null>(null);

export function NativeLayoutMetricsProvider(props: { readonly children: ReactNode }) {
  const [metrics, setMetrics] = useState<NativeLayoutMetrics | null>(null);
  const deviceType = deriveDeviceType({ isPad: IS_PAD, metrics });
  return (
    <NativeLayoutContext value={metrics}>
      <DeviceTypeContext value={deviceType}>
        <NativeLayoutObserver onChange={setMetrics} />
        {props.children}
      </DeviceTypeContext>
    </NativeLayoutContext>
  );
}

export function useNativeLayoutMetrics() {
  return use(NativeLayoutContext);
}

export function useNativeColumnLayoutMetrics() {
  return use(NativeColumnLayoutMetricsContext);
}

export function useDeviceType() {
  return use(DeviceTypeContext);
}
