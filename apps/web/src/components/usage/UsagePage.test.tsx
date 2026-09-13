import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
  metric: "cost" as "cost" | "tokens" | "limits",
  breakdown: "time" as "model" | "time",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      initial === readUsagePagePreferences
        ? { metric: testState.metric, windowDays: 30 }
        : typeof initial === "function"
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
          : initial === "cost"
            ? testState.metric
            : initial === "model"
              ? testState.breakdown
              : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useCanGoBack: () => testState.canGoBack,
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
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";
import { readUsagePagePreferences } from "./usagePagePreferences";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

const modelTotals = Object.freeze([
  {
    model: "expensive-model",
    provider: "claude" as const,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    unpricedRecords: 0,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    unpricedRecords: 0,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    unpricedRecords: 0,
    costShare: 1 / 16,
  },
  {
    model: "unpriced-model",
    provider: "codex" as const,
    costUsd: 0,
    totalTokens: 500,
    records: 2,
    unpricedRecords: 2,
    costShare: 0,
  },
]);

const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.metric = "cost";
  testState.breakdown = "time";
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
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
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage Escape navigation", () => {
  let renderer: ReactTestRenderer;
  let events: EventTarget;
  const back = vi.fn();

  beforeEach(async () => {
    events = new EventTarget();
    back.mockClear();
    testState.navigate.mockClear();
    testState.canGoBack = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      history: { back },
    });
    vi.stubGlobal("document", { activeElement: null, querySelector: () => null });
    vi.stubGlobal("HTMLElement", vi.fn());
    await act(() => {
      renderer = create(<UsagePage />);
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return Object.assign(new Event("keydown", { cancelable: true }), {
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the previous page on Escape", () => {
    events.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("returns home when there is no previous app page", async () => {
    testState.canGoBack = false;
    await act(() => renderer.update(<UsagePage />));

    events.dispatchEvent(escape());
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(back).not.toHaveBeenCalled();
  });

  it("leaves a consumed Escape to the popup, then handles the next Escape", () => {
    const consumed = escape();
    consumed.preventDefault();
    events.dispatchEvent(consumed);
    expect(back).not.toHaveBeenCalled();

    events.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
  });

  it.each([{ repeat: true }, { isComposing: true }])("ignores Escape with %j", (properties) => {
    events.dispatchEvent(escape(properties));
    expect(back).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
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

  it("keeps chronological ordering when the token metric is selected", () => {
    testState.metric = "tokens";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/\$11\.00.*\$13\.00/);
  });
});

describe("UsagePage model breakdown", () => {
  it("sorts models by cost when the cost metric is selected", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("flags a model with no known rates instead of showing it as free", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    const unpricedRow = body.split("<tr").find((row) => row.includes("unpriced-model")) ?? "";

    expect(unpricedRow).toContain("Unpriced");
    expect(unpricedRow).not.toContain("$0.00");
  });

  it("sorts models by token usage when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
    expect(modelTotals.map((model) => model.model)).toEqual([
      "expensive-model",
      "token-heavy-model",
      "token-heavy-cheaper-model",
      "unpriced-model",
    ]);
  });
});
