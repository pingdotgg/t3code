import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  ContextTransferId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { shouldOfferResumeCompaction } from "../components/chat/ContextWindowMeter.logic";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  latestProviderTurnTokenUsage,
} from "./contextWindow";

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("prefers current provider usage and preserves ACP cost", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: {
        usedTokens: 2_500,
        maxTokens: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      usedTokens: 2_500,
      maxTokens: 10_000,
      remainingTokens: 7_500,
      usedPercentage: 25,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("formats compact token values", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  });

  it.each([
    [999_499, "999k"],
    [999_500, "1m"],
    [999_999, "1m"],
    [1_000_000, "1m"],
    [1_100_000, "1.1m"],
  ])("formats %d tokens as %s at the million boundary", (tokens, expected) => {
    expect(formatContextWindowTokens(tokens)).toBe(expected);
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
  });

  it("handles a report without a known context window", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.usedPercentage).toBeNull();
  });
});

describe("latestProviderTurnTokenUsage", () => {
  it("picks the newest report, not the last turn in snapshot order", () => {
    const usage = (usedTokens: number, updatedAt: string) => ({
      tokenUsage: { usedTokens, updatedAt },
    });
    const latest = latestProviderTurnTokenUsage([
      usage(300_000, "2026-06-20T12:00:00.000Z"),
      {},
      usage(90_000, "2026-06-20T09:00:00.000Z"),
    ]);
    expect(latest?.usedTokens).toBe(300_000);
  });

  const sourceUsage = {
    usedTokens: 513_000,
    maxTokens: 1_000_000,
    promptCacheTtlMs: 5 * 60_000,
    updatedAt: "2026-10-19T12:00:00.000Z",
  };
  function forkProjection() {
    const projection = makeThreadProjectionFixture();
    const sourceThreadId = ThreadId.make("parent");
    const runId = RunId.make("fork-point");
    return {
      thread: {
        ...projection.thread,
        forkedFrom: { type: "run" as const, threadId: sourceThreadId, runId },
      },
      contextTransfers: [
        {
          id: ContextTransferId.make("fork-transfer"),
          type: "fork" as const,
          sourceThreadId,
          targetThreadId: projection.thread.id,
          sourcePoint: { threadId: sourceThreadId, runId },
          basePoint: null,
          sourceProviderInstanceId: projection.thread.modelSelection.instanceId,
          sourceTokenUsage: sourceUsage,
          targetProviderInstanceId: null,
          targetRunId: null,
          status: "pending" as const,
          resolution: null,
          createdBy: "user" as const,
          error: null,
          createdAt: projection.updatedAt,
          updatedAt: projection.updatedAt,
          consumedAt: null,
        },
      ],
    };
  }

  it("keeps fork-point context and its cache expiry before the fork reports usage", () => {
    const usage = latestProviderTurnTokenUsage([], forkProjection());
    expect(usage).toEqual(sourceUsage);
    const snapshot = deriveLatestContextWindowSnapshot([], usage);
    expect(snapshot?.usedTokens).toBe(513_000);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: snapshot?.usedTokens,
        updatedAt: snapshot?.updatedAt,
        promptCacheTtlMs: usage?.promptCacheTtlMs,
        now: "2026-10-19T12:06:00.000Z",
      }),
    ).toBe(true);
  });

  it("replaces inherited usage with the fork's own report", () => {
    const tokenUsage = { usedTokens: 42_000, updatedAt: "2026-10-19T12:10:00.000Z" };
    expect(latestProviderTurnTokenUsage([{ tokenUsage }], forkProjection())).toEqual(tokenUsage);
  });

  it.each([0, 42_000])(
    "prefers target provider-thread usage of %d tokens over inherited usage",
    (usedTokens) => {
      const providerThread = {
        contextUsage: {
          usedTokens,
          maxTokens: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        },
        updatedAt: DateTime.makeUnsafe("2026-10-19T12:10:00.000Z"),
      };
      const usage = latestProviderTurnTokenUsage([], forkProjection(), providerThread);
      const snapshot = deriveLatestContextWindowSnapshot([], usage, providerThread);

      expect(snapshot).toMatchObject({
        usedTokens,
        maxTokens: 200_000,
        cost: { amount: 0.42, currency: "USD" },
        updatedAt: "2026-10-19T12:10:00.000Z",
      });
    },
  );

  it("keeps the fallback after a native fork is consumed", () => {
    const projection = forkProjection();
    const transfer = projection.contextTransfers[0]!;
    expect(
      latestProviderTurnTokenUsage([], {
        ...projection,
        contextTransfers: [
          {
            ...transfer,
            status: "consumed",
            resolution: {
              strategy: "native_fork",
              providerThreadRef: {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: "fork",
                strength: "strong",
              },
            },
          },
        ],
      }),
    ).toEqual(sourceUsage);
  });

  it("does not reuse usage for portable handoffs, different providers, or missing history", () => {
    const projection = forkProjection();
    const transfer = projection.contextTransfers[0]!;
    for (const contextTransfers of [
      [],
      [{ ...transfer, sourceTokenUsage: undefined }],
      [{ ...transfer, status: "resolved_portable" as const }],
      [{ ...transfer, sourceProviderInstanceId: ProviderInstanceId.make("other") }],
      [{ ...transfer, sourcePoint: { ...transfer.sourcePoint, runId: RunId.make("later") } }],
    ]) {
      expect(latestProviderTurnTokenUsage([], { ...projection, contextTransfers })).toBeNull();
    }
  });
});
