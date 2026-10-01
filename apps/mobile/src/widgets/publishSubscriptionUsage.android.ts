import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

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
    // expo-widgets has no Android counterpart to widgetURL: the card is a
    // button whose tap is delivered to this process, so opening the app needs
    // a live JS runtime.
    listening = true;
    addUserInteractionListener((event) => {
      if (event.source === "SubscriptionUsage" && tapUrl) void Linking.openURL(tapUrl);
    });
  }
  widget.updateSnapshot(snapshot);
  // Android has no timeline; an alarm re-renders the stored snapshot at each
  // deadline so stale readings flip to "Open T3 to refresh" unattended.
  requireOptionalNativeModule<{ schedule: (name: string, deadlines: number[]) => void }>(
    "T3WidgetExpiry",
  )?.schedule(
    "SubscriptionUsage",
    snapshot.providers.map((provider) => provider.expiresAt).filter((at) => at > 0),
  );
}
