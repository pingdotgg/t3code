import { useNativeLayoutMetrics } from "./native-layout-metrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";

export function useNativeMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return (
    NATIVE_LIQUID_GLASS_SUPPORTED &&
    (metrics === null ||
      metrics.horizontalSizeClass === "compact" ||
      metrics.verticalBarEdge === "none")
  );
}
