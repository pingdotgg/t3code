import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("@expo/ui/swift-ui", () =>
  Object.fromEntries(
    ["HStack", "ProgressView", "Spacer", "Text", "VStack"].map((name) => [name, name]),
  ),
);
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    ["font", "foregroundStyle", "lineLimit", "tint", "widgetURL"].map((name) => [
      name,
      (value: unknown) => ({ [name]: value }),
    ]),
  ),
);
vi.mock("expo-widgets", () => ({ createWidget: (name: string) => ({ name }) }));
import { SubscriptionUsage } from "./SubscriptionUsage";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

const now = Date.parse("2026-09-05T12:00:00Z");
const snapshot: SubscriptionUsageSnapshot = {
  deepLink: "t3code-dev://settings/usage?tab=limits",
  totalRows: 8,
  rows: Array.from({ length: 8 }, (_, index) => ({
    label: `Provider ${index}`,
    window: "Weekly",
    usedPercent: 90,
    resetLabel: "Resets tomorrow",
    checkedAt: now,
    expiresAt: now + 600_000,
  })),
};

describe("iOS subscription widget", () => {
  it.each([
    ["systemSmall", 1],
    ["systemMedium", 2],
    ["systemLarge", 4],
  ] as const)("bounds %s content and reports omitted windows", (widgetFamily, count) => {
    const tree = JSON.stringify(
      SubscriptionUsage(snapshot, { date: new Date(now), widgetFamily, configuration: undefined }),
    );
    expect(tree).toContain(`Provider ${count - 1}`);
    expect(tree).not.toContain(`Provider ${count}`);
    expect(tree).toContain(`+${8 - count} more`);
    expect(tree).toContain(snapshot.deepLink);
  });
  it("renders gallery props without account data", () => {
    const tree = JSON.stringify(
      SubscriptionUsage({} as SubscriptionUsageSnapshot, {
        date: new Date(now),
        widgetFamily: "systemSmall",
        configuration: undefined,
      }),
    );
    expect(tree).toContain("connect an environment");
    expect(tree).not.toContain("Invalid Date");
  });
  it("replaces reset copy when the snapshot expires", () => {
    const tree = JSON.stringify(
      SubscriptionUsage(snapshot, {
        date: new Date(now + 600_000),
        widgetFamily: "systemSmall",
        configuration: undefined,
      }),
    );
    expect(tree).toContain("Open app to refresh");
    expect(tree).not.toContain("Resets tomorrow");
    expect(tree).toContain("90% used");
  });
});
