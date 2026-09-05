import { EnvironmentId, ThreadId, UsageDay } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({ useUsageThreads: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/usage", () => ({ useUsageThreads: testState.useUsageThreads }));
vi.mock("../ui/tooltip", async () => {
  const React = await import("react");
  return {
    Tooltip: "span",
    TooltipPopup: "span",
    TooltipTrigger: ({
      render,
      children,
    }: {
      render: React.ReactElement;
      children: React.ReactNode;
    }) => React.cloneElement(render, {}, children),
  };
});
vi.mock("./usageProviders", () => ({
  PROVIDER_PRESENTATION: {
    claude: { mark: "span" },
    codex: { mark: "span" },
    grok: { mark: "span" },
  },
}));

import { UsageThreadDailyChart, UsageThreadTable } from "./UsageThreadTable";

const input = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-31"),
  timeZone: "UTC",
};

beforeEach(() => {
  testState.useUsageThreads.mockReset();
});

describe("UsageThreadTable", () => {
  it("uses the shared skeleton treatment while thread data is pending", () => {
    testState.useUsageThreads.mockReturnValue({
      rows: [],
      truncatedRows: 0,
      isPending: true,
      failedEnvironments: 0,
    });

    const markup = renderToStaticMarkup(
      <UsageThreadTable input={input} providerContributions={[]} summaryFailedEnvironments={0} />,
    );

    expect(markup.match(/motion-safe:animate-skeleton/g)).toHaveLength(4);
  });

  it("reports an unavailable breakdown when every query failed", () => {
    testState.useUsageThreads.mockReturnValue({
      rows: [],
      truncatedRows: 0,
      isPending: false,
      failedEnvironments: 0,
    });

    const markup = renderToStaticMarkup(
      <UsageThreadTable input={input} providerContributions={[]} summaryFailedEnvironments={2} />,
    );

    expect(markup).toContain("Thread activity could not be loaded");
    expect(markup).not.toContain("No activity in this window");
  });

  it("uses a keyboard-accessible disclosure button without a native title", () => {
    testState.useUsageThreads.mockReturnValue({
      rows: [
        {
          environmentId: EnvironmentId.make("environment-one"),
          key: "row-one",
          threadId: ThreadId.make("thread-one"),
          title: "Fix the flaky test",
          provider: "claude",
          totals: {
            uncachedInputTokens: 1,
            cachedInputTokens: 2,
            cacheCreationTokens: 3,
            outputTokens: 4,
            reasoningTokens: 0,
          },
          costUsd: 1,
          sessions: 1,
          agents: [
            {
              agentId: "agent-one",
              totals: {
                uncachedInputTokens: 1,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 1,
                reasoningTokens: 0,
              },
              costUsd: 0.1,
            },
          ],
          daily: [],
        },
      ],
      truncatedRows: 0,
      isPending: false,
      failedEnvironments: 0,
    });

    const markup = renderToStaticMarkup(
      <UsageThreadTable input={input} providerContributions={[]} summaryFailedEnvironments={0} />,
    );

    expect(markup).toContain('<button type="button" aria-expanded="false"');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("1 subagent");
    expect(markup).toContain('aria-label="Open thread"');
    expect(markup).not.toContain('title="Fix the flaky test"');
  });
});

describe("UsageThreadDailyChart", () => {
  it("renders continuous stacked component bands with a peak and date labels", () => {
    const markup = renderToStaticMarkup(
      <UsageThreadDailyChart
        sinceDay="2026-08-01"
        untilDay="2026-08-03"
        daily={[
          {
            day: UsageDay.make("2026-08-01"),
            cacheWriteUsd: 2,
            cacheReadUsd: 3,
            freshUsd: 1,
          },
          {
            day: UsageDay.make("2026-08-03"),
            cacheWriteUsd: 4,
            cacheReadUsd: 5,
            freshUsd: 3,
          },
        ]}
      />,
    );

    expect(markup).toContain("Peak $12.00");
    expect(markup).toContain("cache writes");
    expect(markup).toContain("cache reads");
    expect(markup).toContain("fresh input + output");
    expect(markup.match(/<path/g)).toHaveLength(3);
    expect(markup).toContain("H253.33 V96 H506.67");
    expect(markup).toContain("Aug 1");
    expect(markup).toContain("Aug 3");
  });
});
