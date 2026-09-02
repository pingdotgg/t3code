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
  ProviderMark: () => <span aria-hidden />,
  PROVIDER_PRESENTATION: {
    claude: { mark: "span" },
    codex: { mark: "span" },
    grok: { mark: "span" },
  },
}));

import { UsageThreadTable } from "./UsageThreadTable";

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

    expect(markup).toContain("after:animate-skeleton");
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
          cacheWriteUsd: 0.25,
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
