import { describe, expect, it } from "vite-plus/test";

import {
  accumulateSubagentUsage,
  appendSubagentActivity,
  defaultSubagentRole,
  mergeSubagentUsage,
  providerSubagentRole,
} from "./SubagentObservability.ts";
import * as DateTime from "effect/DateTime";

describe("subagent observability", () => {
  it("preserves role provenance instead of using titles as roles", () => {
    expect(providerSubagentRole(" reviewer ")).toEqual({
      name: "reviewer",
      source: "provider",
    });
    expect(providerSubagentRole(undefined)).toEqual(defaultSubagentRole());
  });

  it("accumulates activation deltas into stable lifetime usage", () => {
    const first = accumulateSubagentUsage(null, null, {
      totalTokens: 100,
      inputTokens: 70,
      outputTokens: 30,
      toolUses: 2,
    });
    const firstAdvanced = accumulateSubagentUsage(
      first,
      {
        totalTokens: 100,
        inputTokens: 70,
        outputTokens: 30,
        toolUses: 2,
      },
      {
        totalTokens: 140,
        inputTokens: 95,
        outputTokens: 45,
        toolUses: 3,
      },
    );
    const resumed = accumulateSubagentUsage(firstAdvanced, null, {
      totalTokens: 80,
      inputTokens: 50,
      outputTokens: 30,
      toolUses: 1,
    });

    expect(firstAdvanced).toEqual({
      totalTokens: 140,
      inputTokens: 95,
      outputTokens: 45,
      toolUses: 3,
    });
    expect(resumed).toEqual({
      totalTokens: 220,
      inputTokens: 145,
      outputTokens: 75,
      toolUses: 4,
    });
  });

  it("bounds recent activity and deduplicates adjacent updates", () => {
    const now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");
    const activity = Array.from({ length: 8 }, (_, index) => `step ${index}`).reduce(
      (current, summary) => appendSubagentActivity(current, summary, now),
      appendSubagentActivity([], "step 0", now),
    );

    expect(activity).toHaveLength(6);
    expect(activity.map((entry) => entry.summary)).toEqual([
      "step 2",
      "step 3",
      "step 4",
      "step 5",
      "step 6",
      "step 7",
    ]);
    expect(appendSubagentActivity([], "   ", now)).toEqual([]);
  });

  it("merges cumulative provider counters without double-counting", () => {
    expect(
      mergeSubagentUsage(
        { totalTokens: 100, outputTokens: 25 },
        { totalTokens: 140, outputTokens: 20 },
      ),
    ).toEqual({ totalTokens: 140, outputTokens: 25 });
  });

  it("preserves omitted activation counters when they reappear", () => {
    const firstActivation = { totalTokens: 100, inputTokens: 70 };
    const withoutInput = mergeSubagentUsage(firstActivation, { totalTokens: 140 });
    const lifetimeWithoutInput = accumulateSubagentUsage(firstActivation, firstActivation, {
      totalTokens: 140,
    });
    const restoredInput = mergeSubagentUsage(withoutInput, {
      totalTokens: 180,
      inputTokens: 100,
    });

    expect(withoutInput).toEqual({ totalTokens: 140, inputTokens: 70 });
    expect(accumulateSubagentUsage(lifetimeWithoutInput, withoutInput, restoredInput)).toEqual({
      totalTokens: 180,
      inputTokens: 100,
    });
  });
});
