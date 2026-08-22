import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_USAGE_VIEW,
  subscriptionViewPhase,
  USAGE_VIEW_OPTIONS,
} from "@t3tools/client-runtime/state/subscription-allowance";

describe("mobile usage view state", () => {
  it("opens on the Subscription view", () => {
    expect(DEFAULT_USAGE_VIEW).toBe("subscription");
  });

  it("keeps the Subscription/Historical labels stable for accessible controls", () => {
    expect(USAGE_VIEW_OPTIONS).toEqual([
      { value: "subscription", label: "Subscription" },
      { value: "historical", label: "Historical" },
    ]);
  });

  it("blocks only the first empty response and keeps partial cards visible", () => {
    expect(subscriptionViewPhase({ isPending: true, isPartial: false, groupCount: 0 })).toBe(
      "loading",
    );
    expect(subscriptionViewPhase({ isPending: false, isPartial: true, groupCount: 0 })).toBe(
      "loading",
    );
    expect(subscriptionViewPhase({ isPending: false, isPartial: true, groupCount: 1 })).toBe(
      "partial",
    );
    expect(subscriptionViewPhase({ isPending: true, isPartial: false, groupCount: 1 })).toBe(
      "partial",
    );
    expect(subscriptionViewPhase({ isPending: false, isPartial: false, groupCount: 2 })).toBe(
      "ready",
    );
  });
});
