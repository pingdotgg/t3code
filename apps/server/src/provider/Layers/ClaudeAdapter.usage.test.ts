import { describe, expect, it } from "vitest";

import {
  buildClaudeTurnCompleteUsage,
  parseClaudeUsageBreakdown,
  type ClaudeTurnCompleteUsageResult,
} from "./ClaudeAdapter.ts";

describe("parseClaudeUsageBreakdown", () => {
  it("splits Anthropic fields into four token tiers", () => {
    const b = parseClaudeUsageBreakdown({
      input_tokens: 4,
      cache_creation_input_tokens: 2715,
      cache_read_input_tokens: 21144,
      output_tokens: 679,
    });
    expect(b).toEqual({
      inputTokens: 4,
      cachedInputTokens: 21144,
      cacheCreationInputTokens: 2715,
      outputTokens: 679,
      totalTokens: 4 + 2715 + 21144 + 679,
    });
  });

  it("prefers explicit total_tokens over the derived sum", () => {
    const b = parseClaudeUsageBreakdown({
      total_tokens: 999,
      input_tokens: 1,
      output_tokens: 2,
    });
    expect(b?.totalTokens).toBe(999);
  });

  it("derives total when only total_tokens reported", () => {
    const b = parseClaudeUsageBreakdown({ total_tokens: 42 });
    expect(b?.totalTokens).toBe(42);
    expect(b?.inputTokens).toBe(0);
  });

  it("returns undefined for empty / malformed input", () => {
    expect(parseClaudeUsageBreakdown(null)).toBeUndefined();
    expect(parseClaudeUsageBreakdown({})).toBeUndefined();
    expect(parseClaudeUsageBreakdown({ total_tokens: 0 })).toBeUndefined();
  });
});

describe("buildClaudeTurnCompleteUsage", () => {
  it("builds first-turn deltas equal to cumulative totals", () => {
    const res = buildClaudeTurnCompleteUsage({
      resultUsage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 500,
      },
      taskSnapshot: undefined,
      contextWindow: 200_000,
      priorCumulative: undefined,
    });
    const snap = res.snapshot!;
    expect(snap.inputTokens).toBe(1_000);
    expect(snap.cachedInputTokens).toBe(5_000);
    expect(snap.cacheCreationInputTokens).toBe(2_000);
    expect(snap.outputTokens).toBe(500);
    expect(snap.lastInputTokens).toBe(1_000);
    expect(snap.lastCachedInputTokens).toBe(5_000);
    expect(snap.lastCacheCreationInputTokens).toBe(2_000);
    expect(snap.lastOutputTokens).toBe(500);
    // usedTokens + lastUsedTokens are input-side only (1_000+5_000+2_000 =
    // 8_000). Output is billed (`outputTokens`) but excluded from the
    // context-window ring since it doesn't live in the prompt.
    expect(snap.usedTokens).toBe(8_000);
    expect(snap.lastUsedTokens).toBe(8_000);
    // totalProcessedTokens keeps the full cumulative billed total for
    // informational display ("tokens processed so far").
    expect(snap.totalProcessedTokens).toBe(8_500);
    expect(snap.maxTokens).toBe(200_000);
    expect(res.nextCumulative).toBeDefined();
  });

  it("computes second-turn deltas against the prior cumulative", () => {
    const turn1 = buildClaudeTurnCompleteUsage({
      resultUsage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 5_000,
        output_tokens: 500,
      },
      taskSnapshot: undefined,
      contextWindow: 200_000,
      priorCumulative: undefined,
    });
    const turn2 = buildClaudeTurnCompleteUsage({
      resultUsage: {
        // Cumulative totals have grown — turn 2 added 500 input, 1k cached,
        // 300 cache-creation, 200 output.
        input_tokens: 1_500,
        cache_read_input_tokens: 6_000,
        cache_creation_input_tokens: 300,
        output_tokens: 700,
      },
      taskSnapshot: undefined,
      contextWindow: 200_000,
      priorCumulative: turn1.nextCumulative,
    });
    const s = turn2.snapshot!;
    expect(s.inputTokens).toBe(1_500);
    expect(s.cachedInputTokens).toBe(6_000);
    expect(s.cacheCreationInputTokens).toBe(300);
    expect(s.outputTokens).toBe(700);
    expect(s.lastInputTokens).toBe(500);
    expect(s.lastCachedInputTokens).toBe(1_000);
    expect(s.lastCacheCreationInputTokens).toBe(300);
    expect(s.lastOutputTokens).toBe(200);
    // lastUsedTokens is input-side only (context consumed this turn):
    // 500 + 1_000 + 300 = 1_800.  Output (200) is tracked separately in
    // lastOutputTokens for billing but not in the context window total.
    expect(s.lastUsedTokens).toBe(1_800);
  });

  it("does not cap usedTokens to maxTokens", () => {
    const res = buildClaudeTurnCompleteUsage({
      resultUsage: { total_tokens: 535_000 },
      taskSnapshot: undefined,
      contextWindow: 200_000,
      priorCumulative: undefined,
    });
    expect(res.snapshot!.usedTokens).toBe(535_000);
    expect(res.snapshot!.maxTokens).toBe(200_000);
  });

  it("uses task snapshot usedTokens when available (current context)", () => {
    const res = buildClaudeTurnCompleteUsage({
      resultUsage: { total_tokens: 535_000 },
      taskSnapshot: {
        usedTokens: 190_000,
        lastUsedTokens: 190_000,
      },
      contextWindow: 200_000,
      priorCumulative: undefined,
    });
    expect(res.snapshot!.usedTokens).toBe(190_000);
    expect(res.snapshot!.totalProcessedTokens).toBe(535_000);
  });

  it("falls back to task snapshot when result.usage is absent", () => {
    const res: ClaudeTurnCompleteUsageResult = buildClaudeTurnCompleteUsage({
      resultUsage: undefined,
      taskSnapshot: { usedTokens: 500, lastUsedTokens: 500 },
      contextWindow: 100_000,
      priorCumulative: undefined,
    });
    expect(res.snapshot?.usedTokens).toBe(500);
    expect(res.nextCumulative).toBeUndefined();
  });

  it("prefers lastApiCallInputSide over the task snapshot for usedTokens", () => {
    // Session-cumulative result.usage reports big numbers (multiple calls
    // have run across the whole session), but only the last API call's
    // input-side count matters for the ring. The SDK's opaque
    // `task_progress.total_tokens` (via taskSnapshot.usedTokens) is less
    // trustworthy than the per-call input-side captured from
    // `SDKAssistantMessage.usage`, so the per-call value wins.
    const res = buildClaudeTurnCompleteUsage({
      resultUsage: {
        input_tokens: 10_000, // session cumulative across many calls
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 5_000,
        output_tokens: 20_000,
      },
      taskSnapshot: { usedTokens: 999_999, lastUsedTokens: 999_999 },
      contextWindow: 200_000,
      priorCumulative: undefined,
      lastApiCallInputSide: 48_000,
    });
    expect(res.snapshot!.usedTokens).toBe(48_000);
    // totalProcessedTokens still tracks billing-side cumulative for
    // informational display ("tokens processed so far").
    expect(res.snapshot!.totalProcessedTokens).toBe(185_000);
  });

  it("does NOT fall back to cumulative input-side for usedTokens", () => {
    // Previously we added `input + cached + cacheCreation` from
    // `result.usage` when no task snapshot was available.  That sum is
    // *session-cumulative* in Claude's SDK — it over-reports for any
    // multi-call turn.  With no task snapshot and no last-API-call
    // capture, we now fall back to the per-turn delta input-side
    // (first turn → equals cumulative; subsequent turns → just this
    // turn's additions).
    const res = buildClaudeTurnCompleteUsage({
      resultUsage: {
        input_tokens: 5_000,
        cache_read_input_tokens: 200_000,
        cache_creation_input_tokens: 10_000,
        output_tokens: 3_000,
      },
      taskSnapshot: undefined,
      contextWindow: 200_000,
      priorCumulative: {
        inputTokens: 4_000,
        cachedInputTokens: 180_000,
        cacheCreationInputTokens: 8_000,
        outputTokens: 2_500,
        totalTokens: 194_500,
      },
    });
    // Per-turn input-side delta = 1_000 + 20_000 + 2_000 = 23_000.
    expect(res.snapshot!.usedTokens).toBe(23_000);
    expect(res.snapshot!.lastUsedTokens).toBe(23_000);
  });

  it("clamps negative deltas to zero when cumulative goes backwards", () => {
    const prior = {
      inputTokens: 1_000,
      cachedInputTokens: 5_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500,
      totalTokens: 6_500,
    };
    // Unexpected: SDK reports lower cumulative (shouldn't happen, but guard
    // against it so cost math never goes negative).
    const res = buildClaudeTurnCompleteUsage({
      resultUsage: {
        input_tokens: 900,
        cache_read_input_tokens: 4_000,
        output_tokens: 400,
      },
      taskSnapshot: undefined,
      priorCumulative: prior,
    });
    const s = res.snapshot!;
    expect(s.lastInputTokens).toBeUndefined(); // delta was 0
    expect(s.lastCachedInputTokens).toBeUndefined();
    expect(s.lastOutputTokens).toBeUndefined();
  });
});
