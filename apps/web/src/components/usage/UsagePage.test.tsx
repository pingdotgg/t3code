import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
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
  PROVIDER_ORDER: ["codex", "claude", "mcode"],
  PROVIDER_PRESENTATION: {
    codex: { color: "white", label: "Codex", mark: "span" },
    claude: { color: "orange", label: "Claude Code", mark: "span" },
    mcode: { color: "blue", label: "MCode", mark: "span" },
  },
}));

import { UsagePage } from "./UsagePage";

const providerTotals = (codex: number, claude: number, mcode: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
    ["mcode", { costUsd: mcode, totalTokens: mcode * 1_000 }],
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
          byProvider: providerTotals(7, 6, 0),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 4, 1),
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
    expect(markup).toContain("MCode");
    expect(body).toContain("$1.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });

  it("warns when the MCode store could not be read", () => {
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        incompleteSources: [
          {
            environmentId: "env-a",
            environmentLabel: "Local",
            provider: "mcode",
            status: "failed",
            message: "1 usage file could not be read.",
          },
        ],
      },
      environments: [],
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    expect(renderToStaticMarkup(<UsagePage />)).toContain(
      "Local&#x27;s MCode usage could not be read.",
    );
  });

  it("spans the empty time table across every provider column", () => {
    testState.useUsage.mockReturnValue({
      merged: mergeUsage([], USAGE_CONTRACT_VERSION),
      environments: [],
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    expect(renderToStaticMarkup(<UsagePage />)).toMatch(
      /<td colSpan="6" class="py-6 text-center text-muted-foreground">No activity in this window\.<\/td>/,
    );
  });
});
