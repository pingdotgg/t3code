import { ProjectId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  usageThreadTable: vi.fn((_props: unknown) => null),
  metric: "cost" as "cost" | "tokens",
  breakdown: "time" as "model" | "project" | "thread" | "time",
  projectFilter: undefined as string | null | undefined,
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
        : initial === "cost"
          ? testState.metric
          : initial === "model"
            ? testState.breakdown
            : initial === undefined
              ? testState.projectFilter
              : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
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
vi.mock("./UsageThreadTable", () => ({ UsageThreadTable: testState.usageThreadTable }));
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
    cacheWriteTokens: 40,
    cacheWriteUsd: 2.5,
    records: 1,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    costUsd: 5,
    totalTokens: 1_000,
    cacheWriteTokens: 0,
    cacheWriteUsd: 0,
    records: 1,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    costUsd: 1,
    totalTokens: 1_000,
    cacheWriteTokens: 0,
    cacheWriteUsd: 0,
    records: 1,
    costShare: 1 / 16,
  },
]);

const projectTotals = Object.freeze([
  {
    projectId: ProjectId.make("project-expensive"),
    projectKey: "id:project-expensive",
    project: "Expensive Project",
    costUsd: 9,
    totalTokens: 200,
    cacheWriteTokens: 60,
    cacheWriteUsd: 1.75,
    records: 2,
    costShare: 9 / 20,
  },
  {
    projectId: null,
    projectKey: null,
    project: null,
    costUsd: 7,
    totalTokens: 900,
    cacheWriteTokens: 0,
    cacheWriteUsd: 0,
    records: 1,
    costShare: 7 / 20,
  },
]);

beforeEach(() => {
  testState.metric = "cost";
  testState.breakdown = "time";
  testState.projectFilter = undefined;
  testState.usageThreadTable.mockClear();
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
      projects: projectTotals,
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

describe("UsagePage hourly breakdown", () => {
  it("keeps custom date fields available in both desktop and compact layouts", () => {
    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup.match(/aria-label="From day"/g)).toHaveLength(2);
    expect(markup.match(/aria-label="To day"/g)).toHaveLength(2);
    expect(testState.useUsage).toHaveBeenLastCalledWith(expect.anything(), undefined, false);
    expect(markup.match(/pointer-coarse:h-8\.5/g)).toHaveLength(4);
  });

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

describe("UsagePage project breakdown", () => {
  it("ranks projects by cost and labels unattributed work", () => {
    testState.breakdown = "project";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/Expensive Project.*Outside projects/);
    expect(body).toContain("$9.00");
    expect(body).toContain("$7.00");
    expect(body).toContain("45.0%");
    expect(body).toContain("35.0%");
  });

  it("ranks projects by tokens when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.breakdown = "project";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/Outside projects.*Expensive Project/);
  });

  it("shows only the selected project in the project breakdown", () => {
    testState.breakdown = "project";
    testState.projectFilter = "id:project-expensive";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toContain("Expensive Project");
    expect(body).not.toContain("Outside projects");
    expect(body).toContain("100.0%");
  });

  it("distinguishes unattributed usage from an empty window", () => {
    testState.breakdown = "project";
    const usage = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...usage,
      merged: { ...usage.merged, projects: [], records: 1 },
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("No project attribution in this window.");
    expect(markup).not.toContain("No activity in this window.");
  });

  it("keeps the empty-window message when there is no usage", () => {
    testState.breakdown = "project";
    const usage = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...usage,
      merged: { ...usage.merged, projects: [], records: 0 },
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("No activity in this window.");
    expect(markup).not.toContain("No project attribution in this window.");
  });
});

describe("UsagePage thread breakdown", () => {
  it("requests thread rows in the selected project scope", () => {
    testState.breakdown = "thread";
    testState.projectFilter = "id:project-expensive";

    renderToStaticMarkup(<UsagePage />);

    expect(testState.usageThreadTable).toHaveBeenCalledOnce();
    expect(testState.usageThreadTable.mock.calls[0]?.[0]).toMatchObject({
      input: {
        sinceDay: "2026-08-10",
        untilDay: "2026-08-11",
        timeZone: "UTC",
        sinceTime: "2026-08-10T12:37:00.000Z",
        untilTime: "2026-08-11T12:37:00.000Z",
        projectKey: "id:project-expensive",
      },
      providerContributions: [],
    });
    expect(testState.useUsage).toHaveBeenLastCalledWith(
      expect.anything(),
      "id:project-expensive",
      true,
    );
  });
});

describe("UsagePage model breakdown", () => {
  it("sorts models by cost when the cost metric is selected", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("shows cache-write cost per row, with a dash for write-free providers", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    // Claude row carries its cache-write dollars; codex rows never bill writes.
    expect(body).toContain("$2.50");
    expect(body).toMatch(/token-heavy-model.*>-</);
  });

  it("does not present an incomplete cache-write estimate as zero", () => {
    testState.breakdown = "model";
    const usage = testState.useUsage();
    testState.useUsage.mockReturnValue({
      ...usage,
      merged: {
        ...usage.merged,
        models: [{ ...modelTotals[0], cacheWriteUsd: null }],
        costQuality: { ...usage.merged.costQuality, cacheWriteUsd: null },
      },
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup.match(/Unavailable/g)).toHaveLength(2);
    expect(markup).not.toContain("NaN%");
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
    ]);
  });
});
