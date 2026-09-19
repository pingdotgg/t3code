import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type { NativeLayoutMetrics } from "../lib/reserved-regions";

interface ObserverProps extends ViewProps {
  readonly onMetricsChange?: (event: NativeSyntheticEvent<NativeLayoutMetrics>) => void;
}

// An older development client can still run the compact app while it rebuilds.
function resolveObserver() {
  try {
    const module = requireOptionalNativeModule<{
      readonly ViewPrototypes?: { readonly T3NativeControls_LayoutMetrics?: unknown };
    }>("T3NativeControls");
    if (!module?.ViewPrototypes?.T3NativeControls_LayoutMetrics) return null;
    return requireNativeView<ObserverProps>("T3NativeControls", "LayoutMetrics");
  } catch {
    return null;
  }
}
const Observer = resolveObserver();

export function NativeLayoutObserver(props: {
  readonly onChange?: (metrics: NativeLayoutMetrics) => void;
}) {
  return Observer ? (
    <Observer
      pointerEvents="none"
      onMetricsChange={props.onChange ? (event) => props.onChange?.(event.nativeEvent) : undefined}
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
    />
  ) : null;
}
