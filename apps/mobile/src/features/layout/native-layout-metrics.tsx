import { createContext, use, useState, type ReactNode } from "react";
import type { NativeLayoutMetrics } from "../../lib/reserved-regions";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";

const NativeLayoutContext = createContext<NativeLayoutMetrics | null>(null);
// Column reservations come from UIKit's layout, outside the resizing navigator.
export const NativeColumnLayoutMetricsContext = createContext<NativeLayoutMetrics | null>(null);

export function NativeLayoutMetricsProvider(props: { readonly children: ReactNode }) {
  const [metrics, setMetrics] = useState<NativeLayoutMetrics | null>(null);
  return (
    <NativeLayoutContext value={metrics}>
      <NativeLayoutObserver onChange={setMetrics} />
      {props.children}
    </NativeLayoutContext>
  );
}

export function useNativeLayoutMetrics() {
  return use(NativeLayoutContext);
}

export function useNativeColumnLayoutMetrics() {
  return use(NativeColumnLayoutMetricsContext);
}
