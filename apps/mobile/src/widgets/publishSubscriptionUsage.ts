import { getNativeWidgetServices } from "./NativeWidgetServices";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

export function publishSubscriptionUsage(snapshot: SubscriptionUsageSnapshot) {
  return getNativeWidgetServices().publishSubscriptionUsage(snapshot);
}
