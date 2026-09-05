import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { threadContextReachedLimit } from "./contextLimit.ts";

function contextActivity(
  usedTokens: number,
  options: { readonly id?: string; readonly sequence?: number; readonly turnId?: string } = {},
): OrchestrationThreadActivity {
  return {
    id: options.id ?? `usage-${usedTokens}`,
    createdAt: "2026-08-31T00:00:00.000Z",
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens, maxTokens: 400_000 },
    turnId: options.turnId ?? null,
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
  } as OrchestrationThreadActivity;
}

describe("threadContextReachedLimit", () => {
  it("does not apply a limit before server configuration loads", () => {
    expect(threadContextReachedLimit([contextActivity(300_000)], undefined)).toBe(false);
  });

  it("uses the configured limit", () => {
    expect(threadContextReachedLimit([contextActivity(100_000)], 100_000)).toBe(true);
    expect(threadContextReachedLimit([contextActivity(99_999)], 100_000)).toBe(false);
  });

  it("uses lifecycle order when persisted activities arrive out of order", () => {
    const latest = contextActivity(120_000, { id: "latest", sequence: 20 });
    const stale = contextActivity(300_000, { id: "stale", sequence: 10 });
    const latestOverLimit = contextActivity(300_000, {
      id: "latest-over-limit",
      sequence: 30,
    });

    expect(threadContextReachedLimit([latest, stale], 250_000)).toBe(false);
    expect(threadContextReachedLimit([stale, latest], 250_000)).toBe(false);
    expect(threadContextReachedLimit([latestOverLimit, latest], 250_000)).toBe(true);
  });

  it("allows sending after a later compaction lowers context usage", () => {
    const beforeCompaction = contextActivity(300_000, {
      id: "before-compaction",
      sequence: 10,
      turnId: "turn-before-compaction",
    });
    const afterCompaction = contextActivity(20_000, {
      id: "after-compaction",
      sequence: 30,
      turnId: "turn-after-compaction",
    });

    expect(threadContextReachedLimit([afterCompaction, beforeCompaction], 250_000)).toBe(false);
  });
});
