import { useNativeLayoutMetrics } from "./native-layout-metrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";

/** The custom horizontal search field yields to UIKit when bars move to a side. */
export function useNativeMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return NATIVE_LIQUID_GLASS_SUPPORTED && (metrics === null || metrics.verticalBarEdge === "none");
}
