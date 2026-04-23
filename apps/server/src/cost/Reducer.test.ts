import { describe, expect, it } from "vitest";

import {
  deriveTurnDeltas,
  isTurnNoOp,
  processTurn,
  sanitizePersistedFile,
} from "./Reducer.ts";
import type { CumulativeUsageSnapshot, PersistedCostFile, RecordUsageInput } from "./types.ts";
import { localMonthKey, zeroCumulativeUsage } from "./types.ts";

const SONNET = "claude-sonnet-4-6";

describe("deriveTurnDeltas", () => {
  it("prefers explicit lastXxx fields", () => {
    const { deltas, nextCumulative } = deriveTurnDeltas(
      {
        inputTokens: 1_000,
        cachedInputTokens: 5_000,
        cacheCreationInputTokens: 500,
        outputTokens: 200,
        lastInputTokens: 800,
        lastCachedInputTokens: 3_000,
        lastCacheCreationInputTokens: 100,
        lastOutputTokens: 50,
      },
      {
        inputTokens: 200,
        cachedInputTokens: 2_000,
        cacheCreationInputTokens: 400,
        outputTokens: 150,
        reasoningOutputTokens: 0,
      },
    );
    expect(deltas.inputTokens).toBe(800);
    expect(deltas.cachedInputTokens).toBe(3_000);
    expect(deltas.cacheCreationInputTokens).toBe(100);
    expect(deltas.outputTokens).toBe(50);
    // Cumulative reported in payload is used verbatim.
    expect(nextCumulative.inputTokens).toBe(1_000);
    expect(nextCumulative.cachedInputTokens).toBe(5_000);
  });

  it("subtracts cumulative snapshot when no lastXxx present", () => {
    const prior: CumulativeUsageSnapshot = {
      inputTokens: 100,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 0,
      outputTokens: 40,
      reasoningOutputTokens: 0,
    };
    const { deltas, nextCumulative } = deriveTurnDeltas(
      {
        inputTokens: 250,
        cachedInputTokens: 300,
        outputTokens: 100,
      },
      prior,
    );
    expect(deltas.inputTokens).toBe(150);
    expect(deltas.cachedInputTokens).toBe(250);
    expect(deltas.cacheCreationInputTokens).toBe(0);
    expect(deltas.outputTokens).toBe(60);
    expect(nextCumulative.inputTokens).toBe(250);
  });

  it("clamps negative deltas to zero", () => {
    const prior: CumulativeUsageSnapshot = {
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 200,
      reasoningOutputTokens: 0,
    };
    const { deltas } = deriveTurnDeltas(
      { inputTokens: 300, outputTokens: 150 },
      prior,
    );
    expect(deltas.inputTokens).toBe(0);
    expect(deltas.outputTokens).toBe(0);
  });

  it("rolls lastXxx onto prior cumulative when cumulative is absent", () => {
    const { nextCumulative } = deriveTurnDeltas(
      { lastInputTokens: 400, lastOutputTokens: 200 },
      zeroCumulativeUsage(),
    );
    expect(nextCumulative.inputTokens).toBe(400);
    expect(nextCumulative.outputTokens).toBe(200);
  });
});

describe("processTurn", () => {
  const at = new Date(2026, 3, 21, 10, 0, 0); // local April 2026
  const monthKey = localMonthKey(at);

  const baseInput: RecordUsageInput = {
    threadId: "thread-1",
    model: SONNET,
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 5_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500,
      lastInputTokens: 1_000,
      lastCachedInputTokens: 5_000,
      lastOutputTokens: 500,
    },
    at,
  };

  it("records a new turn across all three buckets", () => {
    const res = processTurn({ input: baseInput, session: undefined, month: undefined, allTime: undefined });
    expect(res.applied).toBe(true);
    expect(res.monthKey).toBe(monthKey);
    // 1000*$3 + 5000*$0.3 + 500*$15 = $3 + $1.5 + $7.5 = $12 per 1M → /1M = $0.012
    // 1k*3/1M + 5k*0.3/1M + 500*15/1M = 0.003 + 0.0015 + 0.0075 = $0.012
    expect(res.costUsd).toBeCloseTo(0.012, 6);
    expect(res.session.bucket.totalUsd).toBeCloseTo(0.012, 6);
    expect(res.session.bucket.turnCount).toBe(1);
    expect(res.session.bucket.byModel[SONNET]!.inputTokens).toBe(1_000);
    expect(res.session.lastCumulative?.inputTokens).toBe(1_000);
    expect(res.month.bucket.turnCount).toBe(1);
    expect(res.allTime.bucket.turnCount).toBe(1);
  });

  it("accumulates a second turn", () => {
    const turn1 = processTurn({
      input: baseInput,
      session: undefined,
      month: undefined,
      allTime: undefined,
    });
    const turn2Input: RecordUsageInput = {
      ...baseInput,
      usage: {
        inputTokens: 1_500,
        cachedInputTokens: 6_000,
        outputTokens: 700,
        lastInputTokens: 500,
        lastCachedInputTokens: 1_000,
        lastOutputTokens: 200,
      },
    };
    const res = processTurn({
      input: turn2Input,
      session: turn1.session,
      month: turn1.month,
      allTime: turn1.allTime,
    });
    expect(res.applied).toBe(true);
    expect(res.session.bucket.turnCount).toBe(2);
    // 500*3 + 1000*0.3 + 200*15 = 1500+300+3000 = 4800 / 1M = $0.0048
    expect(res.costUsd).toBeCloseTo(0.0048, 6);
    expect(res.session.bucket.totalUsd).toBeCloseTo(0.012 + 0.0048, 6);
  });

  it("is a no-op when no tokens flow (zero deltas)", () => {
    const emptyInput: RecordUsageInput = {
      threadId: "thread-1",
      model: SONNET,
      usage: { inputTokens: 0, outputTokens: 0 },
      at,
    };
    const res = processTurn({
      input: emptyInput,
      session: undefined,
      month: undefined,
      allTime: undefined,
    });
    expect(res.applied).toBe(false);
    expect(res.session.bucket.turnCount).toBe(0);
    expect(res.costUsd).toBe(0);
  });

  it("buckets by local month", () => {
    const marchInput: RecordUsageInput = {
      ...baseInput,
      at: new Date(2026, 2, 31, 23, 0, 0), // last day of March local
    };
    const turn1 = processTurn({
      input: marchInput,
      session: undefined,
      month: undefined,
      allTime: undefined,
    });
    expect(turn1.monthKey).toBe("2026-03");
    const aprilInput: RecordUsageInput = {
      ...baseInput,
      at: new Date(2026, 3, 1, 1, 0, 0),
      usage: {
        ...baseInput.usage,
        inputTokens: 2_000,
        cachedInputTokens: 10_000,
        outputTokens: 1_000,
        lastInputTokens: 1_000,
        lastCachedInputTokens: 5_000,
        lastOutputTokens: 500,
      },
    };
    const turn2 = processTurn({
      input: aprilInput,
      session: turn1.session,
      // April file is empty — new month means a new month bucket, not last month's.
      month: undefined,
      allTime: turn1.allTime,
    });
    expect(turn2.monthKey).toBe("2026-04");
    expect(turn2.month.bucket.turnCount).toBe(1);
    expect(turn2.allTime.bucket.turnCount).toBe(2);
    expect(turn2.session.bucket.turnCount).toBe(2);
  });

  it("zero-cost unknown model still records token usage", () => {
    const input: RecordUsageInput = {
      threadId: "t1",
      model: "some-unknown-model",
      usage: {
        lastInputTokens: 1_000,
        lastOutputTokens: 500,
      },
      at,
    };
    const res = processTurn({ input, session: undefined, month: undefined, allTime: undefined });
    expect(res.applied).toBe(true);
    expect(res.costUsd).toBe(0);
    expect(res.session.bucket.byModel["some-unknown-model"]!.inputTokens).toBe(1_000);
    expect(res.session.bucket.byModel["some-unknown-model"]!.outputTokens).toBe(500);
    expect(res.session.bucket.byModel["some-unknown-model"]!.totalUsd).toBe(0);
  });
});

describe("isTurnNoOp", () => {
  it("detects zero across all tiers", () => {
    expect(
      isTurnNoOp({
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      }),
    ).toBe(true);
  });
  it("detects non-zero in any tier", () => {
    expect(
      isTurnNoOp({
        inputTokens: 0,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      }),
    ).toBe(false);
  });
});

describe("sanitizePersistedFile", () => {
  it("returns an empty bucket when raw is garbage", () => {
    const file = sanitizePersistedFile(null, "session", "thread-1");
    expect(file.bucket.turnCount).toBe(0);
    expect(file.kind).toBe("session");
    expect(file.key).toBe("thread-1");
  });

  it("coerces invalid numeric fields to zero", () => {
    const file = sanitizePersistedFile(
      {
        version: 1,
        kind: "session",
        key: "t1",
        bucket: {
          totalUsd: "bad" as unknown as number,
          turnCount: -5,
          byModel: {
            [SONNET]: {
              inputTokens: 100,
              outputTokens: "bad" as unknown as number,
            },
          },
          updatedAt: "2026-04-21",
        },
        lastCumulative: {
          inputTokens: 100,
          outputTokens: 50,
        },
      },
      "session",
      "t1",
    );
    expect(file.bucket.totalUsd).toBe(0);
    expect(file.bucket.turnCount).toBe(0);
    expect(file.bucket.byModel[SONNET]!.outputTokens).toBe(0);
    expect(file.lastCumulative?.inputTokens).toBe(100);
  });

  it("drops lastCumulative for non-session files", () => {
    const file = sanitizePersistedFile(
      {
        version: 1,
        kind: "month",
        key: "2026-04",
        bucket: { totalUsd: 0, turnCount: 0, byModel: {}, updatedAt: "" },
        lastCumulative: { inputTokens: 1 },
      } as unknown as PersistedCostFile,
      "month",
      "2026-04",
    );
    expect(file.lastCumulative).toBeUndefined();
  });
});
