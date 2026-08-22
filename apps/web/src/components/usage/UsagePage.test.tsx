import { USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
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
        : initial === "model"
          ? "time"
          : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
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
vi.mock("./usageProviders", () => ({
  PROVIDER_ORDER: ["codex", "claude"],
  PROVIDER_PRESENTATION: {
    codex: { color: "white", label: "Codex", mark: "span" },
    claude: { color: "orange", label: "Claude Code", mark: "span" },
  },
}));

import { UsagePage } from "./UsagePage";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

function renderPendingSkeleton(
  providersInScope: readonly UsageProviderKind[],
  isProviderScopePending = false,
  failedProvidersInScope: readonly UsageProviderKind[] = [],
) {
  testState.useUsage.mockReturnValue({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: [
      {
        environmentId: "local",
        label: "Local",
        isPending: true,
        isProviderScopePending,
        error: null,
        summary: null,
        providersInScope,
      },
      ...(failedProvidersInScope.length === 0
        ? []
        : [
            {
              environmentId: "failed",
              label: "Failed",
              isPending: false,
              isProviderScopePending: false,
              error: "This environment could not report usage.",
              summary: null,
              providersInScope: failedProvidersInScope,
            },
          ]),
    ],
    isPending: true,
    isPartial: false,
    refresh: vi.fn(),
  });
  return renderToStaticMarkup(<UsagePage />);
}

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

describe("UsagePage loading skeleton", () => {
  it("matches provider rows to the known environment scope", () => {
    const markup = renderPendingSkeleton(["claude"]);

    expect(markup).toContain("background-color:orange");
    expect(markup).not.toContain("background-color:white");
  });

  it("reserves both provider rows before environment scope arrives", () => {
    const markup = renderPendingSkeleton([], true);

    expect(markup).toContain("background-color:white");
    expect(markup).toContain("background-color:orange");
  });

  it("renders no provider rows when the known scope is empty", () => {
    const markup = renderPendingSkeleton([]);

    expect(markup).not.toContain("background-color:white");
    expect(markup).not.toContain("background-color:orange");
  });

  it("ignores provider scope from failed environments", () => {
    const markup = renderPendingSkeleton(["claude"], false, ["codex"]);

    expect(markup).toContain("background-color:orange");
    expect(markup).not.toContain("background-color:white");
  });
});
