import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpSchema from "effect-acp/schema";

import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import {
  isAcpUsageGreaterOrNew,
  makeDevinTokenUsageSnapshot,
  makeDevinTokenUsageSnapshotFromUsageUpdate,
  usageFromUsageUpdate,
} from "./DevinAdapter.ts";

function makeUsageUpdatedEvent(
  event: Partial<Extract<AcpParsedSessionEvent, { readonly _tag: "UsageUpdated" }>> & {
    readonly used: number;
  },
): Extract<AcpParsedSessionEvent, { readonly _tag: "UsageUpdated" }> {
  return {
    _tag: "UsageUpdated",
    used: event.used,
    size: event.size ?? 0,
    cost: event.cost ?? null,
    inputTokens: event.inputTokens ?? undefined,
    outputTokens: event.outputTokens ?? undefined,
    cachedReadTokens: event.cachedReadTokens ?? undefined,
    rawPayload: event.rawPayload ?? {},
  };
}

describe("usageFromUsageUpdate", () => {
  it("keeps provided input and output tokens", () => {
    const event = makeUsageUpdatedEvent({
      used: 21776,
      inputTokens: 21687,
      outputTokens: 89,
    });
    expect(usageFromUsageUpdate(event)).toEqual({
      inputTokens: 21687,
      outputTokens: 89,
      totalTokens: 21776,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
    });
  });

  it("derives input tokens from used and output when input is missing", () => {
    const event = makeUsageUpdatedEvent({
      used: 21776,
      outputTokens: 89,
    });
    expect(usageFromUsageUpdate(event)).toEqual({
      inputTokens: 21687,
      outputTokens: 89,
      totalTokens: 21776,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
    });
  });

  it("uses used as input when both breakdown fields are missing", () => {
    const event = makeUsageUpdatedEvent({
      used: 100,
    });
    expect(usageFromUsageUpdate(event)).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      totalTokens: 100,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
    });
  });

  it("does not subtract output when input is present", () => {
    const event = makeUsageUpdatedEvent({
      used: 100,
      inputTokens: 30,
      outputTokens: 20,
    });
    expect(usageFromUsageUpdate(event)).toEqual({
      inputTokens: 30,
      outputTokens: 20,
      totalTokens: 100,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
    });
  });
});

describe("isAcpUsageGreaterOrNew", () => {
  const baseUsage = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    thoughtTokens: null,
  } satisfies EffectAcpSchema.Usage;

  it("returns true when there is no current usage", () => {
    expect(isAcpUsageGreaterOrNew(undefined, baseUsage)).toBe(true);
  });

  it("returns true when total tokens increased", () => {
    expect(isAcpUsageGreaterOrNew(baseUsage, { ...baseUsage, totalTokens: 20 })).toBe(true);
  });

  it("returns false when total tokens decreased", () => {
    expect(isAcpUsageGreaterOrNew(baseUsage, { ...baseUsage, totalTokens: 10 })).toBe(false);
  });

  it("returns false when everything is identical", () => {
    expect(isAcpUsageGreaterOrNew(baseUsage, { ...baseUsage })).toBe(false);
  });

  it("returns true when total is equal but input tokens differ", () => {
    expect(isAcpUsageGreaterOrNew(baseUsage, { ...baseUsage, inputTokens: 12 })).toBe(true);
  });

  it("returns true when total is equal but output tokens differ", () => {
    expect(isAcpUsageGreaterOrNew(baseUsage, { ...baseUsage, outputTokens: 7 })).toBe(true);
  });

  it("returns true when total is equal but cached read tokens differ", () => {
    expect(
      isAcpUsageGreaterOrNew(baseUsage, {
        ...baseUsage,
        cachedReadTokens: 3,
      }),
    ).toBe(true);
  });

  it("returns true when total is equal but cached write tokens differ", () => {
    expect(
      isAcpUsageGreaterOrNew(baseUsage, {
        ...baseUsage,
        cachedWriteTokens: 2,
      }),
    ).toBe(true);
  });

  it("returns true when total is equal but thought tokens differ", () => {
    expect(
      isAcpUsageGreaterOrNew(baseUsage, {
        ...baseUsage,
        thoughtTokens: 1,
      }),
    ).toBe(true);
  });
});
describe("makeDevinTokenUsageSnapshotFromUsageUpdate", () => {
  it("uses size as maxTokens and used as usedTokens", () => {
    const event = makeUsageUpdatedEvent({
      used: 21_776,
      size: 262_000,
      inputTokens: 21_687,
      outputTokens: 89,
      cachedReadTokens: 448,
    });

    const snapshot = makeDevinTokenUsageSnapshotFromUsageUpdate(event, undefined);

    expect(snapshot).toMatchObject({
      usedTokens: 21_776,
      maxTokens: 262_000,
      totalProcessedTokens: 21_687 + 89,
      inputTokens: 21_687,
      outputTokens: 89,
      cachedInputTokens: 448,
      lastUsedTokens: 21_776,
      lastInputTokens: 21_687,
      lastOutputTokens: 89,
      lastCachedInputTokens: 448,
    });
  });

  it("accumulates totalProcessedTokens across usage updates", () => {
    const first = makeDevinTokenUsageSnapshotFromUsageUpdate(
      makeUsageUpdatedEvent({
        used: 1_000,
        size: 200_000,
        inputTokens: 990,
        outputTokens: 10,
      }),
      undefined,
    );

    const second = makeDevinTokenUsageSnapshotFromUsageUpdate(
      makeUsageUpdatedEvent({
        used: 1_500,
        size: 200_000,
        inputTokens: 480,
        outputTokens: 20,
      }),
      first,
    );

    expect(second?.usedTokens).toBe(1_500);
    expect(second?.maxTokens).toBe(200_000);
    expect(second?.totalProcessedTokens).toBe(1_500);
    expect(second?.lastUsedTokens).toBe(500);
    expect(second?.lastInputTokens).toBe(480);
    expect(second?.lastOutputTokens).toBe(20);
  });

  it("does not decrease totalProcessedTokens when context compacts", () => {
    const first = makeDevinTokenUsageSnapshotFromUsageUpdate(
      makeUsageUpdatedEvent({
        used: 10_000,
        size: 200_000,
        inputTokens: 9_990,
        outputTokens: 10,
      }),
      undefined,
    );

    const second = makeDevinTokenUsageSnapshotFromUsageUpdate(
      makeUsageUpdatedEvent({
        used: 8_000,
        size: 200_000,
        inputTokens: 1_000,
        outputTokens: 500,
      }),
      first,
    );

    expect(second?.usedTokens).toBe(8_000);
    expect(second?.totalProcessedTokens).toBe(11_500);
    expect(second?.lastUsedTokens).toBe(0);
    expect(second?.lastInputTokens).toBe(1_000);
    expect(second?.lastOutputTokens).toBe(500);
  });

  it("ignores size 0 and omits maxTokens", () => {
    const event = makeUsageUpdatedEvent({
      used: 100,
      size: 0,
    });

    const snapshot = makeDevinTokenUsageSnapshotFromUsageUpdate(event, undefined);

    expect(snapshot).not.toHaveProperty("maxTokens");
    expect(snapshot?.usedTokens).toBe(100);
    expect(snapshot?.totalProcessedTokens).toBe(100);
  });
});

describe("makeDevinTokenUsageSnapshot", () => {
  it("uses totalTokens as totalProcessedTokens and preserves previous context", () => {
    const previous = {
      usedTokens: 1_500,
      maxTokens: 200_000,
      totalProcessedTokens: 1_500,
    } as const;

    const usage = {
      inputTokens: 10_000,
      outputTokens: 500,
      totalTokens: 10_500,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
    } satisfies EffectAcpSchema.Usage;

    const snapshot = makeDevinTokenUsageSnapshot(usage, previous);

    expect(snapshot).toMatchObject({
      usedTokens: 1_500,
      totalProcessedTokens: 10_500,
      maxTokens: 200_000,
      inputTokens: 10_000,
      outputTokens: 500,
      lastUsedTokens: 9_000,
    });
  });

  it("falls back to totalTokens when there is no previous context", () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
    } satisfies EffectAcpSchema.Usage;

    const snapshot = makeDevinTokenUsageSnapshot(usage, undefined);

    expect(snapshot).toMatchObject({
      usedTokens: 1_100,
      totalProcessedTokens: 1_100,
    });
    expect(snapshot?.maxTokens).toBeUndefined();
  });
});
