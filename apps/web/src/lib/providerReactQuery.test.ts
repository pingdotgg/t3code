import type { NativeApi } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { checkpointDiffQueryOptions, providerQueryKeys } from "./providerReactQuery";

describe("providerQueryKeys.checkpointDiff", () => {
  it("includes cacheScope so reused turn counts do not collide", () => {
    const baseInput = {
      sessionId: "session-id",
      threadRuntimeId: "thread-id",
      fromTurnCount: 1,
      toTurnCount: 2,
    } as const;

    expect(
      providerQueryKeys.checkpointDiff({
        ...baseInput,
        cacheScope: "turn:old-turn",
      }),
    ).not.toEqual(
      providerQueryKeys.checkpointDiff({
        ...baseInput,
        cacheScope: "turn:new-turn",
      }),
    );
  });
});

describe("checkpointDiffQueryOptions", () => {
  it("forwards checkpoint range to the provider API", async () => {
    const getCheckpointDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const api = {
      providers: {
        getCheckpointDiff,
      },
    } as unknown as NativeApi;

    const options = checkpointDiffQueryOptions(api, {
      sessionId: "session-id",
      threadRuntimeId: "thread-id",
      fromTurnCount: 3,
      toTurnCount: 4,
      cacheScope: "turn:abc",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getCheckpointDiff).toHaveBeenCalledWith({
      sessionId: "session-id",
      fromTurnCount: 3,
      toTurnCount: 4,
    });
  });

  it("retries checkpoint-not-ready errors longer than generic failures", () => {
    const options = checkpointDiffQueryOptions(undefined, {
      sessionId: "session-id",
      threadRuntimeId: "thread-id",
      fromTurnCount: 1,
      toTurnCount: 2,
      cacheScope: "turn:abc",
    });
    const retry = options.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") {
      throw new Error("Expected retry to be a function.");
    }

    expect(retry(1, new Error("Checkpoint turn count 2 exceeds current turn count 1."))).toBe(true);
    expect(
      retry(
        11,
        new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1."),
      ),
    ).toBe(true);
    expect(
      retry(
        12,
        new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1."),
      ),
    ).toBe(false);
    expect(retry(2, new Error("Something else failed."))).toBe(true);
    expect(retry(3, new Error("Something else failed."))).toBe(false);
  });

  it("backs off longer for checkpoint-not-ready errors", () => {
    const options = checkpointDiffQueryOptions(undefined, {
      sessionId: "session-id",
      threadRuntimeId: "thread-id",
      fromTurnCount: 1,
      toTurnCount: 2,
      cacheScope: "turn:abc",
    });
    const retryDelay = options.retryDelay;
    expect(typeof retryDelay).toBe("function");
    if (typeof retryDelay !== "function") {
      throw new Error("Expected retryDelay to be a function.");
    }

    const checkpointDelay = retryDelay(
      4,
      new Error("Checkpoint turn count 2 exceeds current turn count 1."),
    );
    const genericDelay = retryDelay(4, new Error("Network failure"));

    expect(typeof checkpointDelay).toBe("number");
    expect(typeof genericDelay).toBe("number");
    expect((checkpointDelay ?? 0) > (genericDelay ?? 0)).toBe(true);
  });
});
