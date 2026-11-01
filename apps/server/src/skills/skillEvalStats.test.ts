import { describe, expect, it } from "@effect/vitest";

import {
  armOutcomeSummary,
  holmAdjust,
  observationalSummary,
  pairedTaskEffect,
  skillVerdict,
  studentTCdf,
  studentTQuantile,
  wilsonInterval,
  type JudgmentObservation,
  type PairedTaskEffect,
  type WilsonInterval,
} from "./skillEvalStats.ts";

const judgment = (
  overrides: Partial<JudgmentObservation> & Pick<JudgmentObservation, "taskId" | "orderLabel">,
): JudgmentObservation => ({
  repeatIndex: 0,
  sampleIndex: 0,
  preferred: "tie",
  treatmentScore: null,
  controlScore: null,
  ...overrides,
});

const completion = (estimate: number, low = estimate, high = estimate): WilsonInterval => ({
  estimate,
  low,
  high,
});

const effect = (
  overrides: Partial<PairedTaskEffect> & Pick<PairedTaskEffect, "mean" | "n" | "ci">,
): PairedTaskEffect => ({
  sd: 0.2,
  pValue: 0.01,
  rubricDiff: { mean: 0, sd: 0, n: overrides.n, ci: { low: 0, high: 0 } },
  positionConsistency: 1,
  positionPairCount: overrides.n,
  ...overrides,
});

const verdictEvidenceFloor = { repeats: 3, judgeSamples: 3 };

describe("Student t distribution", () => {
  it("matches known 97.5% quantiles", () => {
    const cases = [
      [1, 12.7062047364],
      [2, 4.3026527297],
      [5, 2.5705818356],
      [10, 2.228138852],
      [30, 2.0422724563],
      [1_000, 1.9623390808],
    ] as const;

    for (const [df, expected] of cases) {
      expect(studentTQuantile(0.975, df)).toBeCloseTo(expected, 6);
    }
  });

  it("is symmetric around zero", () => {
    for (const df of [1, 2, 10, 1_000]) {
      for (const value of [0, 0.25, 1, 4]) {
        expect(studentTCdf(-value, df)).toBeCloseTo(1 - studentTCdf(value, df), 12);
      }
    }
  });
});

describe("wilsonInterval", () => {
  it("matches known 95% intervals", () => {
    expect(wilsonInterval(0, 10)).toEqual({
      estimate: 0,
      low: 0,
      high: expect.closeTo(0.2775327999, 9),
    });
    expect(wilsonInterval(5, 10)).toEqual({
      estimate: 0.5,
      low: expect.closeTo(0.2365930905, 9),
      high: expect.closeTo(0.7634069095, 9),
    });
    expect(wilsonInterval(10, 10)).toEqual({
      estimate: 1,
      low: expect.closeTo(0.7224672001, 9),
      high: 1,
    });
  });

  it("returns null without trials", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("holmAdjust", () => {
  it("adjusts monotonically in ranked order and restores input order", () => {
    expect(holmAdjust([0.01, 0.04, 0.03, 0.002])).toEqual([0.03, 0.06, 0.06, 0.008]);
  });

  it("caps adjusted values at one", () => {
    expect(holmAdjust([0.9, 0.8, 0.7])).toEqual([1, 1, 1]);
  });
});

describe("pairedTaskEffect", () => {
  it("treats order disagreement as ties and clusters means by task", () => {
    const result = pairedTaskEffect([
      judgment({
        taskId: "a",
        orderLabel: "treatment-first",
        sampleIndex: 0,
        preferred: "treatment",
        treatmentScore: 0.8,
        controlScore: 0.6,
      }),
      judgment({
        taskId: "a",
        orderLabel: "control-first",
        sampleIndex: 0,
        preferred: "control",
        treatmentScore: 0.7,
        controlScore: 0.5,
      }),
      judgment({
        taskId: "a",
        orderLabel: "treatment-first",
        sampleIndex: 1,
        preferred: "treatment",
        treatmentScore: 0.9,
        controlScore: 0.7,
      }),
      judgment({
        taskId: "a",
        orderLabel: "control-first",
        sampleIndex: 1,
        preferred: "treatment",
        treatmentScore: 0.8,
        controlScore: 0.6,
      }),
      judgment({
        taskId: "b",
        orderLabel: "treatment-first",
        preferred: "control",
        treatmentScore: 0.4,
        controlScore: 0.6,
      }),
      judgment({
        taskId: "b",
        orderLabel: "control-first",
        preferred: "control",
        treatmentScore: 0.3,
        controlScore: 0.5,
      }),
    ]);

    expect(result.mean).toBeCloseTo(-0.25);
    expect(result.sd).toBeCloseTo(1.0606601718);
    expect(result.n).toBe(2);
    expect(result.rubricDiff.mean).toBeCloseTo(-0.05);
    expect(result.rubricDiff.n).toBe(2);
    expect(result.positionConsistency).toBeCloseTo(2 / 3);
    expect(result.positionPairCount).toBe(3);
  });

  it("does not report inferential statistics for fewer than two tasks", () => {
    const oneTask = pairedTaskEffect([
      judgment({ taskId: "a", orderLabel: "treatment-first", preferred: "treatment" }),
    ]);
    expect(oneTask).toMatchObject({ mean: 1, sd: null, n: 1, ci: null, pValue: null });
    expect(oneTask.rubricDiff).toEqual({ mean: null, sd: null, n: 0, ci: null });

    const unanimous = pairedTaskEffect(
      ["a", "b", "c", "d", "e"].flatMap((taskId) => [
        judgment({ taskId, orderLabel: "treatment-first", preferred: "treatment" }),
        judgment({ taskId, orderLabel: "control-first", preferred: "treatment" }),
      ]),
    );
    expect(unanimous).toMatchObject({ mean: 1, sd: 0, n: 5, ci: null });
    expect(unanimous.pValue).toBeCloseTo(0.0625, 12);

    expect(pairedTaskEffect([])).toMatchObject({
      mean: null,
      sd: null,
      n: 0,
      ci: null,
      pValue: null,
      positionConsistency: null,
      positionPairCount: 0,
    });
  });
});

describe("armOutcomeSummary", () => {
  it("summarizes completion and known outcome values", () => {
    const result = armOutcomeSummary([
      { status: "completed", tokens: 10, durationMs: 100, costUsd: null },
      { status: "failed", tokens: null, durationMs: 300, costUsd: 0.3 },
      { status: "completed", tokens: 30, durationMs: null, costUsd: 0.1 },
      { status: "pending", tokens: null, durationMs: null, costUsd: null },
      { status: "cancelled", tokens: null, durationMs: null, costUsd: null },
    ]);

    expect(result.completion).toEqual(wilsonInterval(2, 3));
    expect(result).toMatchObject({
      trialCount: 5,
      completedCount: 2,
      tokens: { median: 20, count: 2 },
      durationMs: { median: 200, count: 2 },
      costUsd: { median: 0.2, count: 2 },
    });
    expect(result.completion?.estimate).toBeCloseTo(2 / 3);
  });
});

describe("skillVerdict", () => {
  it("reports helps only with statistical, practical, interval, and completion evidence", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: 0.2, n: 100, ci: { low: 0.05, high: 0.35 } }),
        adjustedP: 0.01,
        treatmentCompletion: completion(0.75),
        controlCompletion: completion(0.8),
      }),
    ).toEqual({ verdict: "helps", reason: null });
  });

  it("reports statistically separated harm", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: -0.2, n: 100, ci: { low: -0.35, high: -0.05 } }),
        adjustedP: 0.01,
        treatmentCompletion: completion(0.8),
        controlCompletion: completion(0.8),
      }),
    ).toEqual({ verdict: "hurts", reason: null });
  });

  it("requires twice the practical difference from 50 through 99 tasks", () => {
    const shared = {
      adjustedP: 0.01,
      treatmentCompletion: completion(0.9),
      controlCompletion: completion(0.9),
    };
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        ...shared,
        effect: effect({ mean: 0.19, n: 99, ci: { low: 0.05, high: 0.3 } }),
      }),
    ).toEqual({ verdict: "not-enough-data", reason: "wide-interval" });
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        ...shared,
        effect: effect({ mean: 0.2, n: 50, ci: { low: 0.05, high: 0.35 } }),
      }),
    ).toEqual({ verdict: "helps", reason: null });
  });

  it("reports a large completion regression with non-overlapping Wilson intervals", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: 0, n: 100, ci: { low: -0.1, high: 0.1 } }),
        adjustedP: 1,
        treatmentCompletion: completion(0.5, 0.4, 0.6),
        controlCompletion: completion(0.8, 0.7, 0.9),
      }),
    ).toEqual({ verdict: "hurts", reason: null });
  });

  it("reports no evaluations", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: null, n: 0, ci: null, sd: null, pValue: null }),
        adjustedP: null,
        treatmentCompletion: null,
        controlCompletion: null,
      }),
    ).toEqual({ verdict: "not-enough-data", reason: "no-evaluations" });
  });

  it("requires three repeats and three judge samples", () => {
    const evidence = {
      effect: effect({ mean: 0.2, n: 100, ci: { low: 0.05, high: 0.35 } }),
      adjustedP: 0.01,
      treatmentCompletion: completion(0.75),
      controlCompletion: completion(0.8),
    };

    expect(skillVerdict({ ...evidence, repeats: 2, judgeSamples: 3 })).toEqual({
      verdict: "not-enough-data",
      reason: "too-few-repeats",
    });
    expect(skillVerdict({ ...evidence, repeats: 3, judgeSamples: 2 })).toEqual({
      verdict: "not-enough-data",
      reason: "too-few-repeats",
    });
    // The task floor is the primary gap and is reported first.
    expect(
      skillVerdict({
        ...evidence,
        effect: effect({ mean: 0.8, n: 20, ci: { low: 0.6, high: 0.99 } }),
        repeats: 1,
        judgeSamples: 1,
      }),
    ).toEqual({ verdict: "not-enough-data", reason: "too-few-tasks" });
  });

  it("reports too few tasks before applying completion harm", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: 0.5, n: 49, ci: { low: 0.3, high: 0.7 } }),
        adjustedP: 0.001,
        treatmentCompletion: completion(0.5, 0.4, 0.6),
        controlCompletion: completion(0.8, 0.7, 0.9),
      }),
    ).toEqual({ verdict: "not-enough-data", reason: "too-few-tasks" });
  });

  it("reports a likely negligible interval", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: 0.02, n: 100, ci: { low: -0.05, high: 0.08 } }),
        adjustedP: 0.4,
        treatmentCompletion: completion(0.8),
        controlCompletion: completion(0.8),
      }),
    ).toEqual({ verdict: "not-enough-data", reason: "likely-negligible" });
  });

  it("reports a wide interval for all other inconclusive evidence", () => {
    expect(
      skillVerdict({
        ...verdictEvidenceFloor,
        effect: effect({ mean: 0.2, n: 100, ci: { low: -0.1, high: 0.5 } }),
        adjustedP: 0.2,
        treatmentCompletion: completion(0.6),
        controlCompletion: completion(0.75),
      }),
    ).toEqual({ verdict: "not-enough-data", reason: "wide-interval" });
  });
});

describe("observationalSummary", () => {
  it("groups turns and labels the summaries as confounded", () => {
    const result = observationalSummary([
      {
        skillName: "review",
        driver: "claude",
        model: "fable",
        mode: "variant",
        activated: true,
        status: "completed",
        reverted: false,
        toolCalls: 4,
        toolFailures: 1,
        tokens: 100,
        durationMs: 1_000,
      },
      {
        skillName: "review",
        driver: "claude",
        model: "fable",
        mode: "variant",
        activated: false,
        status: "failed",
        reverted: null,
        toolCalls: 1,
        toolFailures: 1,
        tokens: null,
        durationMs: 3_000,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "observational",
      confounded: true,
      turns: 2,
      activations: 1,
      activationRate: 0.5,
      completions: 1,
      reverted: 0,
      toolCalls: 5,
      toolFailures: 2,
      toolFailureRate: 0.4,
      tokens: { median: 100, count: 1 },
      durationMs: { median: 2_000, count: 2 },
    });
    expect(result[0]?.completion?.estimate).toBe(0.5);
    expect(result[0]?.revert?.estimate).toBe(0);
  });
});
