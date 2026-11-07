import type { TurnTokenUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  listThreadTurnTokenUsageByRun,
  summarizeThreadTurnTokenUsage,
  threadTurnTokenUsageTotals,
} from "./threadTurnTokenUsage.ts";

function turn(usage?: TurnTokenUsage) {
  return usage === undefined ? {} : { turnTokenUsage: usage };
}

const complete = (
  overrides: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly reasoningTokens?: number;
    readonly otherUsage?: { readonly inputTokens: number; readonly outputTokens: number };
    readonly models?: readonly string[];
  } = {},
): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: overrides.inputTokens ?? 100,
  outputTokens: overrides.outputTokens ?? 20,
  hasSubagents: false,
  ...(overrides.cachedInputTokens === undefined
    ? {}
    : { cachedInputTokens: overrides.cachedInputTokens }),
  ...(overrides.cacheCreationTokens === undefined
    ? {}
    : { cacheCreationTokens: overrides.cacheCreationTokens }),
  ...(overrides.reasoningTokens === undefined
    ? {}
    : { reasoningTokens: overrides.reasoningTokens }),
  ...(overrides.otherUsage === undefined ? {} : { otherUsage: overrides.otherUsage }),
  ...(overrides.models === undefined ? {} : { models: [...overrides.models] }),
});

describe("summarizeThreadTurnTokenUsage", () => {
  it("returns unavailable when no turn reported usage", () => {
    expect(summarizeThreadTurnTokenUsage([turn(), turn()])).toEqual({
      usageStatus: "unavailable",
      inputTokens: null,
      uncachedInputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      otherInputTokens: null,
      otherOutputTokens: null,
      totalTokens: null,
      turnCount: 2,
      measuredTurnCount: 0,
    });
  });

  it("sums complete turns and keeps optional breakdowns", () => {
    expect(
      summarizeThreadTurnTokenUsage([
        turn(
          complete({
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 5,
          }),
        ),
        turn(
          complete({
            inputTokens: 50,
            cachedInputTokens: 10,
            outputTokens: 8,
            reasoningTokens: 2,
          }),
        ),
      ]),
    ).toEqual({
      usageStatus: "complete",
      inputTokens: 150,
      uncachedInputTokens: 90,
      cachedInputTokens: 50,
      cacheCreationTokens: 10,
      outputTokens: 28,
      reasoningTokens: 7,
      otherInputTokens: null,
      otherOutputTokens: null,
      totalTokens: 178,
      turnCount: 2,
      measuredTurnCount: 2,
    });
  });

  it("marks partial when some turns omit usage or are incomplete", () => {
    const summary = summarizeThreadTurnTokenUsage([
      turn(complete({ inputTokens: 10, outputTokens: 2 })),
      turn(),
      turn({
        usageScope: "main_agent",
        usageStatus: "partial",
        inputTokens: 5,
        hasSubagents: false,
      }),
    ]);
    expect(summary.usageStatus).toBe("partial");
    expect(summary.inputTokens).toBe(15);
    expect(summary.outputTokens).toBe(2);
    expect(summary.totalTokens).toBe(17);
    expect(summary.measuredTurnCount).toBe(2);
  });

  it("sums native otherUsage when present", () => {
    const summary = summarizeThreadTurnTokenUsage([
      turn(
        complete({
          otherUsage: { inputTokens: 30, outputTokens: 4 },
        }),
      ),
      turn(
        complete({
          otherUsage: { inputTokens: 10, outputTokens: 1 },
        }),
      ),
    ]);
    expect(summary.otherInputTokens).toBe(40);
    expect(summary.otherOutputTokens).toBe(5);
  });
});

describe("threadTurnTokenUsageTotals", () => {
  it("returns null when every count is missing or zero", () => {
    expect(
      threadTurnTokenUsageTotals({
        uncachedInputTokens: null,
        cachedInputTokens: null,
        cacheCreationTokens: null,
        outputTokens: null,
        reasoningTokens: null,
      }),
    ).toBeNull();
  });

  it("zeros missing fields for pricing", () => {
    expect(
      threadTurnTokenUsageTotals({
        uncachedInputTokens: 10,
        cachedInputTokens: null,
        cacheCreationTokens: 2,
        outputTokens: 4,
        reasoningTokens: null,
      }),
    ).toEqual({
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 2,
      outputTokens: 4,
      reasoningTokens: 0,
    });
  });
});

describe("listThreadTurnTokenUsageByRun", () => {
  it("groups provider turns by non-superseded attempts and prefers reported models", () => {
    const rows = listThreadTurnTokenUsageByRun({
      runs: [
        {
          id: "run-2" as never,
          ordinal: 2,
          activeAttemptId: "attempt-2" as never,
          modelSelection: { instanceId: "claude" as never, model: "fallback-model" },
        },
        {
          id: "run-1" as never,
          ordinal: 1,
          activeAttemptId: "attempt-1b" as never,
          modelSelection: { instanceId: "claude" as never, model: "fallback-model" },
        },
      ],
      attempts: [
        { id: "attempt-1a" as never, runId: "run-1" as never, status: "superseded" },
        { id: "attempt-1b" as never, runId: "run-1" as never, status: "completed" },
        { id: "attempt-2" as never, runId: "run-2" as never, status: "completed" },
      ],
      providerTurns: [
        {
          runAttemptId: "attempt-1a" as never,
          turnTokenUsage: complete({ inputTokens: 999, outputTokens: 9 }),
        },
        {
          runAttemptId: "attempt-1b" as never,
          turnTokenUsage: complete({
            inputTokens: 40,
            outputTokens: 5,
            models: ["claude-opus-4"],
          }),
        },
        {
          runAttemptId: "attempt-2" as never,
          turnTokenUsage: complete({ inputTokens: 10, outputTokens: 2 }),
        },
      ],
    });

    expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      runId: "run-1",
      model: "claude-opus-4",
      usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45, measuredTurnCount: 1 },
    });
    expect(rows[1]).toMatchObject({
      runId: "run-2",
      model: "fallback-model",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
  });
});
