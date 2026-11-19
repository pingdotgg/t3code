import type { SuperchargeRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideNextSupercharge, parseSuperchargeReport, strongestEffort } from "./superchargeWorkflow.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const run = (overrides: Partial<SuperchargeRun> = {}): SuperchargeRun => ({
  preset: "verify",
  phase: "implementing",
  iteration: 0,
  limits: { maxIterations: 3, maxMinutes: 30, maxTokens: null },
  startedAt: "2026-11-19T11:50:00.000Z",
  deadlineAt: "2026-11-19T12:20:00.000Z",
  tokensUsed: null,
  tokensMeasured: false,
  checks: [],
  testsRun: [],
  effort: null,
  stop: null,
  log: [{ at: "2026-11-19T11:50:00.000Z", iteration: 0, phase: "implementing", summary: "Started" }],
  ...overrides,
});
const report = (status: "pass" | "fail", done = status === "pass") =>
  parseSuperchargeReport(
    `Done.\n\n\`\`\`supercharge\n${JSON.stringify({
      checks: [{ name: "login test passes", status, evidence: "vp test run auth.test.ts" }],
      tests_run: ["vp test run auth.test.ts"],
      diff_reviewed: true,
      done,
    })}\n\`\`\``,
  );

describe("parseSuperchargeReport", () => {
  it("reads the last report block and ignores malformed ones", () => {
    const text = "```supercharge\n{\"checks\":[],\"done\":false}\n```\nlater\n```supercharge\n{\"checks\":[{\"name\":\"a\",\"status\":\"pass\"}],\"done\":true}\n```";
    expect(parseSuperchargeReport(text)).toMatchObject({ done: true, checks: [{ name: "a", status: "pass" }] });
    expect(parseSuperchargeReport("```supercharge\nnot json\n```")).toBeNull();
    expect(parseSuperchargeReport("no block")).toBeNull();
  });
});

describe("decideNextSupercharge", () => {
  it("stops Verify once every check passes", () => {
    expect(decideNextSupercharge({ run: run(), report: report("pass"), outcome: "completed", nowMs: NOW, independentReview: false })).toMatchObject({
      type: "stop",
      reason: "checks-passed",
    });
  });

  it("sends the failing checks back while the budget lasts, then stops", () => {
    const next = decideNextSupercharge({ run: run(), report: report("fail"), outcome: "completed", nowMs: NOW, independentReview: false });
    expect(next).toMatchObject({ type: "continue", phase: "fixing", freshContext: false });
    expect(next.type === "continue" && next.prompt).toContain("login test passes");
    expect(
      decideNextSupercharge({ run: run({ iteration: 3 }), report: report("fail"), outcome: "completed", nowMs: NOW, independentReview: false }),
    ).toMatchObject({ type: "stop", reason: "iteration-limit" });
  });

  it("stops on cancellation, failure, time, and usage before any follow-up", () => {
    const failing = report("fail");
    expect(decideNextSupercharge({ run: run(), report: failing, outcome: "interrupted", nowMs: NOW, independentReview: false })).toMatchObject({ reason: "cancelled" });
    expect(decideNextSupercharge({ run: run(), report: failing, outcome: "failed", nowMs: NOW, independentReview: false })).toMatchObject({ reason: "turn-failed" });
    expect(
      decideNextSupercharge({ run: run(), report: failing, outcome: "completed", nowMs: Date.parse("2026-11-19T12:21:00.000Z"), independentReview: false }),
    ).toMatchObject({ reason: "time-limit" });
    expect(
      decideNextSupercharge({
        run: run({ limits: { maxIterations: 3, maxMinutes: 30, maxTokens: 10_000 }, tokensUsed: 12_000, tokensMeasured: true }),
        report: failing,
        outcome: "completed",
        nowMs: NOW,
        independentReview: false,
      }),
    ).toMatchObject({ reason: "usage-limit", message: expect.stringContaining("Reported") });
  });

  it("asks once for a missing report, then stops", () => {
    expect(decideNextSupercharge({ run: run(), report: null, outcome: "completed", nowMs: NOW, independentReview: false })).toMatchObject({
      type: "continue",
      phase: "verifying",
    });
    const nudged = run({ iteration: 1, log: [...run().log, { at: "x", iteration: 1, phase: "verifying", summary: "asked" }] });
    expect(decideNextSupercharge({ run: nudged, report: null, outcome: "completed", nowMs: NOW, independentReview: false })).toMatchObject({
      type: "stop",
      reason: "no-report",
    });
  });

  it("runs Deep's review and the optional independent review with a fresh context", () => {
    const deep = run({ preset: "deep", limits: { maxIterations: 5, maxMinutes: 60, maxTokens: null } });
    expect(decideNextSupercharge({ run: deep, report: report("pass"), outcome: "completed", nowMs: NOW, independentReview: true })).toMatchObject({
      type: "continue",
      phase: "reviewing",
    });
    const reviewed = { ...deep, iteration: 1, log: [...deep.log, { at: "x", iteration: 1, phase: "reviewing" as const, summary: "review" }] };
    expect(decideNextSupercharge({ run: reviewed, report: report("pass"), outcome: "completed", nowMs: NOW, independentReview: true })).toMatchObject({
      type: "continue",
      phase: "independent-review",
      freshContext: true,
    });
    expect(decideNextSupercharge({ run: reviewed, report: report("pass"), outcome: "completed", nowMs: NOW, independentReview: false })).toMatchObject({
      type: "stop",
      reason: "checks-passed",
    });
  });

  it("picks the strongest offered effort", () => {
    expect(strongestEffort(["low", "medium", "high"])).toBe("high");
    expect(strongestEffort(["low", "xhigh", "max"])).toBe("max");
    expect(strongestEffort([])).toBeNull();
  });
});
