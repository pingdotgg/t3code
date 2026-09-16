import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/jetpack-compose", () => ({
  Button: "Button",
  Column: "Column",
  LinearProgressIndicator: "LinearProgressIndicator",
  Text: "Text",
  getMaterialColors: ({ scheme }: { scheme: string }) => ({
    surface: `${scheme}-surface`,
    onSurface: `${scheme}-onSurface`,
    onSurfaceVariant: `${scheme}-onSurfaceVariant`,
    surfaceVariant: `${scheme}-surfaceVariant`,
    primary: `${scheme}-primary`,
    error: `${scheme}-error`,
  }),
}));

vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  fillMaxSize: () => "fillMaxSize",
  fillMaxWidth: () => "fillMaxWidth",
  height: (value: number) => ({ height: value }),
  padding: (...values: number[]) => ({ padding: values }),
  paddingAll: (value: number) => ({ paddingAll: value }),
}));

vi.mock("expo-widgets", () => ({
  createWidget: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import { SubscriptionUsage } from "./SubscriptionUsage.android";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

const now = Date.parse("2026-09-05T12:00:00.000Z");
const provider = {
  name: "Codex",
  detail: "Subscription remaining",
  windows: [
    { kind: "session", label: "5 hours", remaining: 60, reset: "Next reset Sep 5, 5:00 PM" },
    { kind: "weekly", label: "Weekly", remaining: 8, reset: "Next reset Sep 9, 9:00 AM" },
  ],
  expiresAt: now + 60_000,
  totalWindows: 2,
} satisfies SubscriptionUsageSnapshot["providers"][number];
const snapshot = {
  checkedAt: now,
  url: "t3code-dev://settings/usage?tab=limits",
  providers: [provider, { ...provider, name: "Claude" }],
} satisfies SubscriptionUsageSnapshot;

function render(props: SubscriptionUsageSnapshot, colorScheme: "light" | "dark" = "dark") {
  vi.setSystemTime(now);
  return JSON.stringify(SubscriptionUsage(props, { colorScheme, configuration: undefined }));
}

describe("SubscriptionUsage Android layout", () => {
  it("renders each window with its remaining share, bar, and reset", () => {
    const tree = render(snapshot);
    expect(tree).toContain("5 hours · 60% left");
    expect(tree).toContain('"progress":0.6');
    expect(tree).toContain("Next reset Sep 5, 5:00 PM");
    expect(tree).toContain('"progress":0.08');
    expect(tree).toContain('"color":"dark-error"');
    expect(tree).toContain("As of ");
  });

  it("drops the bars and asks for a refresh once the snapshot expires", () => {
    const tree = render({
      ...snapshot,
      providers: [{ ...provider, expiresAt: now - 1 }],
    });
    expect(tree).toContain("Open T3 to refresh");
    expect(tree).not.toContain("LinearProgressIndicator");
    expect(tree).not.toContain("more in T3");
  });

  it("counts the quotas that did not fit", () => {
    const tree = render({ ...snapshot, providers: [{ ...provider, totalWindows: 5 }] });
    expect(tree).toContain("3 more in T3");
  });

  it("invites connecting when nothing has been checked", () => {
    const tree = render({ checkedAt: 0, providers: [] }, "light");
    expect(tree).toContain("Tap to connect in T3");
    expect(tree).not.toContain("As of ");
    expect(tree).toContain('"containerColor":"light-surface"');
  });
});
