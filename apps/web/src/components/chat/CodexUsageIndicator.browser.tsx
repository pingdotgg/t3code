import "../../index.css";

import {
  type CodexUsageSnapshot,
  type CodexUsageWindow,
  type LocalApi,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { CodexUsageIndicatorMode } from "@t3tools/contracts/settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetLocalApiForTests } from "../../localApi";
import { CodexUsageIndicator } from "./CodexUsageIndicator";

const codexInstanceId = ProviderInstanceId.make("codex");

function usageWindow(kind: CodexUsageWindow["kind"], remainingPercent: number): CodexUsageWindow {
  return {
    kind,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt: "2026-05-04T07:00:00.000Z",
    windowDurationMins: kind === "five-hour" ? 300 : 10_080,
  };
}

function usageSnapshot(input: {
  windows: readonly CodexUsageWindow[];
  rateLimitReachedType?: string | null;
}): CodexUsageSnapshot {
  return {
    providerInstanceId: codexInstanceId,
    checkedAt: "2026-05-04T02:00:00.000Z",
    windows: [...input.windows],
    rateLimitReachedType: input.rateLimitReachedType ?? null,
    source: "read",
  };
}

async function renderIndicator(mode: CodexUsageIndicatorMode, snapshot: CodexUsageSnapshot | null) {
  await __resetLocalApiForTests();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const getCodexUsage = vi.fn().mockResolvedValue(snapshot);
  window.nativeApi = {
    server: {
      getCodexUsage,
    },
  } as unknown as LocalApi;

  const mounted = await render(
    <QueryClientProvider client={queryClient}>
      <CodexUsageIndicator instanceId={codexInstanceId} mode={mode} />
    </QueryClientProvider>,
  );

  return {
    getCodexUsage,
    async cleanup() {
      await mounted.unmount();
      queryClient.clear();
    },
  };
}

afterEach(async () => {
  Reflect.deleteProperty(window, "nativeApi");
  await __resetLocalApiForTests();
  document.body.innerHTML = "";
});

describe("CodexUsageIndicator", () => {
  it("renders the five-hour window", async () => {
    const mounted = await renderIndicator(
      "five-hour",
      usageSnapshot({
        windows: [usageWindow("five-hour", 73), usageWindow("weekly", 41)],
      }),
    );

    await expect.element(page.getByText("Usage 5h 73% left")).toBeVisible();
    expect(mounted.getCodexUsage).toHaveBeenCalledWith({ instanceId: codexInstanceId });
    await mounted.cleanup();
  });

  it("renders both configured windows", async () => {
    const mounted = await renderIndicator(
      "both",
      usageSnapshot({
        windows: [usageWindow("five-hour", 73), usageWindow("weekly", 41)],
      }),
    );

    await expect.element(page.getByText("Usage 5h 73% left | Weekly 41% left")).toBeVisible();
    await mounted.cleanup();
  });

  it("renders an unavailable state when Codex usage is missing", async () => {
    const mounted = await renderIndicator("five-hour", null);

    await expect.element(page.getByText("Usage 5h --")).toBeVisible();
    await mounted.cleanup();
  });

  it("marks the indicator when a rate limit is reached", async () => {
    const mounted = await renderIndicator(
      "five-hour",
      usageSnapshot({
        windows: [usageWindow("five-hour", 0)],
        rateLimitReachedType: "primary",
      }),
    );

    await expect.element(page.getByText("Usage 5h 0% left")).toBeVisible();
    expect(document.querySelector(".text-amber-600")).not.toBeNull();
    await mounted.cleanup();
  });
});
