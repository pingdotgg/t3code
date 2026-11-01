import { describe, expect, it } from "vite-plus/test";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";
import { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { formatContextWindowCompactionMessage } from "../components/chat/ContextWindowMeter.logic";
import * as DateTime from "effect/DateTime";
import {
  ContextTransferId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { shouldOfferResumeCompaction } from "../components/chat/ContextWindowMeter.logic";
import { deriveLatestContextWindowSnapshot, latestProviderTurnTokenUsage } from "./contextWindow";

const decodeTokenUsage = Schema.decodeSync(OrchestrationV2ProviderTurnTokenUsage);

const compactionEntry = (providerThreadId: string | null) =>
  ({
    item: {
      id: "compaction-1" as never,
      threadId: "thread-1" as never,
      runId: null,
      nodeId: null,
      providerThreadId: providerThreadId as never,
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
  }) satisfies { item: ThreadStructureTurnItem };

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([compactionEntry(null)]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("ignores a retired provider thread's compaction after a provider switch", () => {
    const activeProviderThread = {
      id: ProviderThreadId.make("acp-thread"),
      contextUsage: null,
      updatedAt: DateTime.makeUnsafe("2026-10-19T12:10:00.000Z"),
    };
    const retired = compactionEntry(ProviderThreadId.make("pi-thread"));
    const current = compactionEntry(ProviderThreadId.make("acp-thread"));
    expect(deriveLatestContextWindowSnapshot([retired], null, activeProviderThread)).toBeNull();
    expect(
      deriveLatestContextWindowSnapshot([current], null, activeProviderThread)?.usedTokens,
    ).toBe(2_000);
    // Items without a provider thread predate the split and stay visible.
    expect(
      deriveLatestContextWindowSnapshot([compactionEntry(null)], null, activeProviderThread)
        ?.usedTokens,
    ).toBe(2_000);
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const usage = decodeTokenUsage({
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      autoCompactThreshold: 150_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const snapshot = deriveLatestContextWindowSnapshot([], usage);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
    expect(snapshot?.autoCompactThreshold).toBe(150_000);
    expect(
      formatContextWindowCompactionMessage("Claude Sonnet 4.6", snapshot?.autoCompactThreshold),
    ).toBe("Compacts automatically at about 150,000 tokens.");
  });
});

describe("latestProviderTurnTokenUsage", () => {
  it("picks the newest report, not the last turn in snapshot order", () => {
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const usage = (usedTokens: number, updatedAt: string) => ({
      providerThreadId,
      tokenUsage: { usedTokens, updatedAt },
    });
    const latest = latestProviderTurnTokenUsage([
      usage(300_000, "2026-06-20T12:00:00.000Z"),
      { providerThreadId },
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
    expect(
      latestProviderTurnTokenUsage(
        [{ providerThreadId: ProviderThreadId.make("provider-thread"), tokenUsage }],
        forkProjection(),
      ),
    ).toEqual(tokenUsage);
  });

  it("ignores the retired provider thread's last report after a provider switch", () => {
    const retiredTurn = {
      providerThreadId: ProviderThreadId.make("pi-thread"),
      tokenUsage: decodeTokenUsage({
        usedTokens: 180_000,
        maxTokens: 200_000,
        updatedAt: "2026-10-19T11:00:00.000Z",
      }),
    };
    const providerThread = {
      id: ProviderThreadId.make("acp-thread"),
      contextUsage: { usedTokens: 12_000, maxTokens: 200_000 },
      updatedAt: DateTime.makeUnsafe("2026-10-19T12:10:00.000Z"),
    };
    const liveUsage = latestProviderTurnTokenUsage([retiredTurn], null, providerThread);
    expect(liveUsage).toBeNull();
    expect(deriveLatestContextWindowSnapshot([], liveUsage, providerThread)).toMatchObject({
      usedTokens: 12_000,
      maxTokens: 200_000,
      updatedAt: "2026-10-19T12:10:00.000Z",
    });
  });

  it("prefers the active provider thread's older report over a newer retired one", () => {
    const turns = [
      {
        providerThreadId: ProviderThreadId.make("pi-thread"),
        tokenUsage: decodeTokenUsage({
          usedTokens: 180_000,
          maxTokens: 200_000,
          updatedAt: "2026-10-19T12:10:00.000Z",
        }),
      },
      {
        providerThreadId: ProviderThreadId.make("acp-thread"),
        tokenUsage: decodeTokenUsage({
          usedTokens: 12_000,
          maxTokens: 200_000,
          updatedAt: "2026-10-19T11:00:00.000Z",
        }),
      },
    ];
    const liveUsage = latestProviderTurnTokenUsage(turns, null, {
      id: ProviderThreadId.make("acp-thread"),
      contextUsage: null,
    });
    expect(liveUsage?.usedTokens).toBe(12_000);
  });

  it.each([0, 42_000])(
    "prefers target provider-thread usage of %d tokens over inherited usage",
    (usedTokens) => {
      const providerThread = {
        id: ProviderThreadId.make("provider-thread"),
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
