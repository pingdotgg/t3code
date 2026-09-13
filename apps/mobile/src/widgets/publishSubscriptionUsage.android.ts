import { requireOptionalNativeModule } from "expo";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

export function publishSubscriptionUsage(snapshot: SubscriptionUsageSnapshot) {
  requireOptionalNativeModule<{ updateSnapshot: (snapshot: string) => void }>(
    "T3SubscriptionWidget",
  )?.updateSnapshot(JSON.stringify(snapshot));
}
