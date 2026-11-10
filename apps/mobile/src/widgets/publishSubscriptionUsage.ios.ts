import { requireOptionalNativeModule } from "expo";
import {
  subscriptionUsageTimeline,
  type SubscriptionUsageSnapshot,
} from "./subscriptionUsageSnapshot";

export async function publishSubscriptionUsage(snapshot: SubscriptionUsageSnapshot) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./SubscriptionUsage");
  widget.updateTimeline(subscriptionUsageTimeline(snapshot, Date.now()));
}
