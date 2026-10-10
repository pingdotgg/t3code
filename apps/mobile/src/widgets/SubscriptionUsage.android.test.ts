import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/jetpack-compose", () => ({
  Button: "Button",
  Column: "Column",
  LazyColumn: "LazyColumn",
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
  background: (color: string) => ({ background: color }),
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
import { DEFAULT_WIDGET_CONFIGURATION } from "./subscriptionWidgetPreferences";

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

function render(
  props: SubscriptionUsageSnapshot,
  colorScheme: "light" | "dark" = "dark",
  at = now,
) {
  vi.setSystemTime(at);
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

  it("keeps deliberately hidden quotas and configuration controls out of the widget", () => {
    const tree = render({ ...snapshot, providers: [{ ...provider, totalWindows: 5 }] });
    expect(tree).not.toContain("more quota");
    expect(tree).not.toContain("Configure in T3");
  });

  it("keeps quotas without an expiry deadline visible", () => {
    const tree = render({ ...snapshot, providers: [{ ...provider, expiresAt: 0 }] });
    expect(tree).toContain("5 hours · 60% left");
    expect(tree).not.toContain("Open T3 to refresh");
  });

  it("invites connecting when nothing has been checked", () => {
    const tree = render({ checkedAt: 0, providers: [] }, "light");
    expect(tree).toContain("Open T3 to connect and configure usage.");
    expect(tree).not.toContain("As of ");
    expect(tree).toContain('"containerColor":"light-surface"');
  });

  it("supports a different reset display on each quota and recalculates time left", () => {
    const props: SubscriptionUsageSnapshot = {
      ...snapshot,
      android: {
        widgets: {},
        defaults: {
          checkedAt: now,
          configuration: DEFAULT_WIDGET_CONFIGURATION,
          emptyMessage: "",
          groups: [
            {
              id: "codex:0",
              name: "Codex · Personal",
              detail: "",
              totalWindows: 3,
              windows: [
                {
                  id: "a",
                  label: "Session",
                  remaining: 60,
                  reset: "Next reset Sep 5, 1:30 PM",
                  resetsAt: now + 90 * 60_000,
                  resetDisplay: "reset",
                  expiresAt: now + 15 * 60_000,
                },
                {
                  id: "b",
                  label: "Weekly",
                  remaining: 50,
                  reset: "Next reset Sep 7, 3:00 PM",
                  resetsAt: now + 51 * 3_600_000,
                  resetDisplay: "both",
                  expiresAt: now + 15 * 60_000,
                },
                {
                  id: "c",
                  label: "Monthly",
                  remaining: 40,
                  reset: "Next reset Sep 5, 2:15 PM",
                  resetsAt: now + 135 * 60_000,
                  resetDisplay: "remaining",
                  expiresAt: now + 15 * 60_000,
                },
              ],
            },
          ],
        },
      },
    };
    const tree = render(props);
    expect(tree).toContain("Next reset Sep 5, 1:30 PM");
    expect(tree).toContain("Next reset Sep 7, 3:00 PM · 2d 3h left");
    expect(tree).toContain("Reset in 2h 15m");
    expect(tree).not.toContain("Next reset Sep 5, 2:15 PM");
    expect(render(props, "dark", now + 60_000)).toContain("Reset in 2h 14m");
    expect(render(props, "dark", now + 16 * 60_000)).not.toContain("Reset in");
  });

  it("does not invent a countdown when a reset time is unavailable", () => {
    const props: SubscriptionUsageSnapshot = {
      ...snapshot,
      android: {
        widgets: {},
        defaults: {
          checkedAt: now,
          configuration: DEFAULT_WIDGET_CONFIGURATION,
          emptyMessage: "",
          groups: [
            {
              id: "codex:0",
              name: "Codex · Personal",
              detail: "",
              totalWindows: 1,
              windows: [
                {
                  id: "a",
                  label: "Session",
                  remaining: 60,
                  reset: "Reset time unavailable",
                  resetsAt: null,
                  resetDisplay: "remaining",
                  expiresAt: now + 15 * 60_000,
                },
              ],
            },
          ],
        },
      },
    };
    expect(render(props)).toContain("Reset time unavailable");
    expect(render(props)).not.toContain("Reset in");
  });
});
