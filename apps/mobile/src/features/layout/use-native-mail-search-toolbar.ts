import { useNativeLayoutMetrics } from "./native-layout-metrics";
import { NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED } from "./native-mail-search-toolbar";

/** The custom horizontal search field yields to UIKit when bars move to a side. */
export function useNativeMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return (
    NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED && (metrics === null || metrics.verticalBarEdge === "none")
  );
}
