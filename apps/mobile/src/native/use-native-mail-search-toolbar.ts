import { useNativeLayoutMetrics } from "./native-layout-metrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";

/** Folded phones keep search in the bottom toolbar; expanded Duo panes use the side bar. */
export function useNativeMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return (
    NATIVE_LIQUID_GLASS_SUPPORTED &&
    (metrics === null ||
      metrics.horizontalSizeClass === "compact" ||
      metrics.verticalBarEdge === "none")
  );
}
