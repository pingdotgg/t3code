import { describe, expect, it } from "vite-plus/test";
import { normalizeClaudeTurnTokenUsage } from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it("does not bill late Codex updates against the next active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "next";
    accumulateCodexTurnTokenUsage(state, "previous", update(breakdown(100, 10, 20)));
    accumulateCodexTurnTokenUsage(
      state,
      "next",
      update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
    );
    expect(completeCodexTurnTokenUsage(state, "next", true)).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
    });
    expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
  });

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });

  it.each(["failed", "interrupted", "completed"] as const)(
    "retains measured Claude steering usage as partial after %s without final usage",
    (status) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          status === "completed" ? { subtype: "success" } : undefined,
          true,
          status,
          [
            { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
            { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 },
          ],
        ),
      ).toEqual({
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: true,
        inputTokens: 147,
        cachedInputTokens: 42,
        outputTokens: 23,
      });
    },
  );

  it.each([undefined, null, {}])(
    "keeps unavailable Claude usage unavailable without measured segments (%s)",
    (usage) => {
      expect(
        normalizeClaudeTurnTokenUsage({ subtype: "success", usage }, false, "completed")
          .usageStatus,
      ).toBe("unavailable");
    },
  );

  it("retains measured thinking tokens without a final result", () => {
    expect(
      normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
        { input_tokens: 4, output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
      ]),
    ).toMatchObject({
      usageStatus: "partial",
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it.each([undefined, null])(
    "retains earlier cache counts when a steering segment reports %s",
    (cache) => {
      expect(
        normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
          { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
          { input_tokens: 5, cache_read_input_tokens: cache, output_tokens: 3 },
        ]),
      ).toMatchObject({
        usageStatus: "partial",
        inputTokens: 145,
        cachedInputTokens: 40,
        outputTokens: 23,
      });
    },
  );

  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])(
    "keeps Claude usage partial when the final %s is invalid",
    (field) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          { subtype: "success", usage: { input_tokens: 5, output_tokens: 3, [field]: -1 } },
          false,
          "completed",
          [{ input_tokens: 100, output_tokens: 20, [field]: 40 }],
        ),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 145, outputTokens: 23 });
    },
  );

  it("adds Claude steering segments to the final measured result once", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } },
        false,
        "completed",
        [{ input_tokens: 4, output_tokens: 2 }],
      ),
    ).toMatchObject({ usageStatus: "complete", inputTokens: 9, outputTokens: 5 });
  });
});
