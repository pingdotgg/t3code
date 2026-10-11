import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { androidWidgetRefreshDeadlines } from "./androidSubscriptionUsageSnapshot";

let tapUrl: string | undefined;
let listening = false;

export async function publishSubscriptionUsage(snapshot: SubscriptionUsageSnapshot) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const [{ default: widget }, { addUserInteractionListener }] = await Promise.all([
    import("./SubscriptionUsage"),
    import("expo-widgets"),
  ]);
  tapUrl = snapshot.url;
  if (!listening) {
    // Cached layouts from older versions still deliver taps through JS.
    listening = true;
    addUserInteractionListener((event) => {
      if (event.source === "SubscriptionUsage" && tapUrl) void Linking.openURL(tapUrl);
    });
  }
  widget.updateSnapshot(snapshot);
  requireOptionalNativeModule<{ schedule: (name: string, deadlines: number[]) => void }>(
    "T3WidgetExpiry",
  )?.schedule("SubscriptionUsage", androidWidgetRefreshDeadlines(snapshot, Date.now()));
}
