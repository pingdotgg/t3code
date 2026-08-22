import {
  DEFAULT_USAGE_VIEW,
  type UsageView,
} from "@t3tools/client-runtime/state/subscription-allowance";
import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { Children, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      typeof initial === "function"
        ? {
            days: 1,
            window: {
              sinceDay: "2026-08-10",
              untilDay: "2026-08-11",
              timeZone: "UTC",
              resolution: "hour",
              sinceTime: "2026-08-10T12:37:00.000Z",
              untilTime: "2026-08-11T12:37:00.000Z",
            },
          }
        : initial === "subscription"
          ? "historical"
          : initial === "model"
            ? "time"
            : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinute: () => "2026-08-11T12:37",
}));
vi.mock("../../state/subscriptionAllowance", () => ({
  useSubscriptionAllowance: () => ({
    groups: [],
    environments: [],
    isPending: false,
    isPartial: false,
    isRefreshing: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "div",
  TooltipTrigger: "div",
}));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./usageProviders", () => ({
  PROVIDER_ORDER: ["codex", "claude"],
  PROVIDER_PRESENTATION: {
    codex: { color: "white", label: "Codex", mark: "span" },
    claude: { color: "orange", label: "Claude Code", mark: "span" },
  },
}));

import { UsagePage, UsageSkeleton, UsageViewTabs } from "./UsagePage";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
        },
      ],
    },
    environments: [],
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage defaults", () => {
  it("opens on the Subscription view", () => {
    expect(DEFAULT_USAGE_VIEW).toBe("subscription");
  });
});

describe("UsageViewTabs", () => {
  it("exposes an accessible Subscription/Historical segmented control", () => {
    const selected: UsageView[] = [];
    const output = UsageViewTabs({
      value: "subscription",
      onChange: (view) => selected.push(view),
    }) as ReactElement<{
      readonly children: ReactNode;
      readonly onValueChange: (value: readonly string[]) => void;
      readonly value: readonly string[];
      readonly variant: string;
    }>;
    const toggles = Children.toArray(output.props.children) as ReactElement<{
      readonly children: string;
      readonly value: string;
    }>[];

    expect(output.type).toBe(ToggleGroup);
    expect(output.props.variant).toBe("segmented");
    expect(output.props.value).toEqual(["subscription"]);
    expect(toggles.map((toggle) => toggle.type)).toEqual([Toggle, Toggle]);
    expect(toggles.map((toggle) => toggle.props.children)).toEqual(["Subscription", "Historical"]);
    expect(toggles.map((toggle) => toggle.props.value)).toEqual(["subscription", "historical"]);

    output.props.onValueChange(["historical"]);
    expect(selected).toEqual(["historical"]);
  });
});

describe("UsageSkeleton", () => {
  it("matches the chart resolution and metric while historical usage is loading", () => {
    const hourlyMarkup = renderToStaticMarkup(<UsageSkeleton resolution="hour" metric="cost" />);
    const dailyMarkup = renderToStaticMarkup(<UsageSkeleton resolution="day" metric="tokens" />);

    expect(hourlyMarkup).toContain("Hourly cost");
    expect(dailyMarkup).toContain("Daily processed tokens");
  });
});

describe("UsagePage hourly breakdown", () => {
  it("keeps recent activity visible first without empty hourly rows", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body).toContain("$11.00");
    expect(body).toContain("$13.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });
});
