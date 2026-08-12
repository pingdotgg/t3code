import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpSchema from "effect-acp/schema";

import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import { isAcpUsageGreaterOrNew, usageFromUsageUpdate } from "./DevinAdapter.ts";

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
