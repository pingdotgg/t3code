import type { NativeApi } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";

import {
  serverCopilotReasoningProbeQueryOptions,
  serverCopilotUsageQueryOptions,
} from "./serverReactQuery";

function mockNativeApi(input: {
  getCopilotUsage?: ReturnType<typeof vi.fn>;
  probeCopilotReasoning?: ReturnType<typeof vi.fn>;
}) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    server: {
      getCopilotUsage: input.getCopilotUsage ?? vi.fn(),
      probeCopilotReasoning: input.probeCopilotReasoning ?? vi.fn(),
    },
  } as unknown as NativeApi);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("serverCopilotUsageQueryOptions", () => {
  it("returns an unavailable payload when the rpc rejects", async () => {
    const getCopilotUsage = vi.fn().mockRejectedValue(new Error("Transport disposed"));
    mockNativeApi({ getCopilotUsage });

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(serverCopilotUsageQueryOptions());

    expect(result).toMatchObject({
      status: "unavailable",
      message: "GitHub Copilot quota request failed: Transport disposed",
    });
  });

  it("stops loading after the client-side timeout", async () => {
    vi.useFakeTimers();

    const getCopilotUsage = vi.fn(() => new Promise(() => {}));
    mockNativeApi({ getCopilotUsage });

    const queryClient = new QueryClient();
    const resultPromise = queryClient.fetchQuery(serverCopilotUsageQueryOptions());

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toMatchObject({
      status: "unavailable",
      message: "GitHub Copilot quota request timed out.",
    });
  });

  it("disables retries so the menu does not stay in a loading loop", () => {
    const options = serverCopilotUsageQueryOptions();

    expect(options.retry).toBe(false);
  });
});

describe("serverCopilotReasoningProbeQueryOptions", () => {
  it("probes reasoning options for the selected model", async () => {
    const probeCopilotReasoning = vi.fn().mockResolvedValue({
      status: "supported",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      model: "gpt-5",
      options: ["medium", "high", "xhigh"],
      currentValue: "high",
    });
    mockNativeApi({ probeCopilotReasoning });

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      serverCopilotReasoningProbeQueryOptions({ model: "gpt-5" }),
    );

    expect(probeCopilotReasoning).toHaveBeenCalledWith({ model: "gpt-5" });
    expect(result).toMatchObject({
      status: "supported",
      options: ["medium", "high", "xhigh"],
    });
  });
});