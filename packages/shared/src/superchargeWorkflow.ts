import type {
  SuperchargeCheck,
  SuperchargeLimits,
  SuperchargePhase,
  SuperchargePreset,
  SuperchargeRun,
  SuperchargeStopReason,
} from "@t3tools/contracts";

/**
 * Supercharge's workflow as pure functions: the instructions each turn carries, the report the
 * agent ends with, and the decision Continuum makes when a turn ends.
 */

export interface SuperchargeReport {
  readonly checks: ReadonlyArray<SuperchargeCheck>;
  readonly testsRun: ReadonlyArray<string>;
  readonly diffReviewed: boolean;
  readonly done: boolean;
  readonly remaining: string;
}

const REPORT_FENCE = /```supercharge\s*\n([\s\S]*?)```/g;

/** The last ```supercharge fenced JSON block in the agent's reply. */
export function parseSuperchargeReport(text: string): SuperchargeReport | null {
  const blocks = [...text.matchAll(REPORT_FENCE)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const checks = Array.isArray(record.checks)
    ? record.checks.flatMap((entry): SuperchargeCheck[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const check = entry as Record<string, unknown>;
        const name = typeof check.name === "string" ? check.name.trim() : "";
        if (name === "") return [];
        const status =
          check.status === "pass" || check.status === "fail" ? check.status : "pending";
        const evidence = typeof check.evidence === "string" ? check.evidence.slice(0, 600) : "";
        return [{ name: name.slice(0, 200), status, evidence }];
      })
    : [];
  const testsRun = Array.isArray(record.tests_run)
    ? record.tests_run.filter((entry): entry is string => typeof entry === "string").slice(0, 20)
    : [];
  return {
    checks: checks.slice(0, 20),
    testsRun,
    diffReviewed: record.diff_reviewed === true,
    done: record.done === true,
    remaining: typeof record.remaining === "string" ? record.remaining.slice(0, 600) : "",
  };
}

const REPORT_FORMAT = [
  "End your reply with a fenced block exactly like this (valid JSON, no comments):",
  "```supercharge",
  '{"checks":[{"name":"<check>","status":"pass|fail","evidence":"<command and result, or what you inspected>"}],"tests_run":["<command>"],"diff_reviewed":true,"done":true,"remaining":""}',
  "```",
  'Mark a check "pass" only with evidence from this turn. Set "done" to false while any check fails.',
].join("\n");

export function superchargeLabel(preset: SuperchargePreset): string {
  return preset === "deep" ? "Deep" : preset === "verify" ? "Verify" : "Off";
}

/** Context added to each turn of a supercharged thread. */
export function superchargeTurnContext(input: {
  readonly preset: Exclude<SuperchargePreset, "off">;
  readonly phase: SuperchargePhase;
  readonly iteration: number;
  readonly limits: SuperchargeLimits;
}): string {
  const budget = `You have at most ${input.limits.maxIterations} follow-up turns and ${input.limits.maxMinutes} minutes for this task.`;
  const header = `Supercharge (${superchargeLabel(input.preset)}) is on for this task. ${budget}`;
  if (input.phase === "implementing") {
    const deep =
      input.preset === "deep"
        ? "\n5. Before reporting, review your change for regressions and edge cases: callers you did not update, error paths, empty and boundary inputs, concurrency, and platform differences. Add a check for each risk you found."
        : "";
    return [
      header,
      "Work in this order:",
      "1. Before changing code, write a short list of completion checks: concrete, verifiable conditions that prove the task is done (a test that passes, a command's output, a behavior you can observe).",
      "2. Implement the task.",
      "3. Inspect your own diff (for example `git diff`) and fix anything unintended.",
      "4. Run the narrowest verification that proves each check (targeted tests, a build, a script). Do not run whole-repository suites unless a check needs it." +
        deep,
      REPORT_FORMAT,
    ].join("\n");
  }
  if (input.phase === "independent-review") {
    return [
      header,
      "You are an independent reviewer with a fresh context. Do not trust earlier claims.",
      "Read the working tree's diff, re-run the verification for each check, and look for regressions and missed edge cases. Fix real problems you find and verify the fix.",
      REPORT_FORMAT,
    ].join("\n");
  }
  return [header, REPORT_FORMAT].join("\n");
}

export type SuperchargeDecision =
  | { readonly type: "stop"; readonly reason: SuperchargeStopReason; readonly message: string }
  | {
      readonly type: "continue";
      readonly phase: Exclude<SuperchargePhase, "implementing" | "finished">;
      readonly prompt: string;
      /** A fresh provider session, so the reviewer does not inherit the implementer's context. */
      readonly freshContext: boolean;
    };

export type SuperchargeTurnOutcome = "completed" | "interrupted" | "failed";

function hasPhase(run: SuperchargeRun, phase: SuperchargePhase): boolean {
  return run.log.some((entry) => entry.phase === phase);
}

function checkList(checks: ReadonlyArray<SuperchargeCheck>): string {
  return checks
    .map((check) => `- ${check.name}${check.evidence ? `: ${check.evidence}` : ""}`)
    .join("\n");
}

/** What Continuum does after a supercharged turn ends. */
export function decideNextSupercharge(input: {
  readonly run: SuperchargeRun;
  readonly report: SuperchargeReport | null;
  readonly outcome: SuperchargeTurnOutcome;
  readonly nowMs: number;
  readonly independentReview: boolean;
}): SuperchargeDecision {
  const { run, report } = input;
  if (input.outcome === "interrupted") {
    return { type: "stop", reason: "cancelled", message: "The turn was stopped, so Supercharge stopped too." };
  }
  if (input.outcome === "failed") {
    return { type: "stop", reason: "turn-failed", message: "The turn failed. Supercharge does not retry failed turns." };
  }
  const allPassed =
    report !== null &&
    report.done &&
    report.checks.length > 0 &&
    report.checks.every((check) => check.status === "pass");
  const verifiedFinish = (): SuperchargeDecision | null => {
    if (!allPassed) return null;
    if (run.preset === "deep" && !hasPhase(run, "reviewing")) return null;
    if (run.preset === "deep" && input.independentReview && !hasPhase(run, "independent-review")) {
      return null;
    }
    return {
      type: "stop",
      reason: "checks-passed",
      message: `All ${report!.checks.length} checks passed.`,
    };
  };
  const finished = verifiedFinish();
  if (finished) return finished;

  if (input.nowMs >= Date.parse(run.deadlineAt)) {
    return {
      type: "stop",
      reason: "time-limit",
      message: `The ${run.limits.maxMinutes}-minute limit ran out before every check passed.`,
    };
  }
  if (run.limits.maxTokens !== null && run.tokensUsed !== null && run.tokensUsed >= run.limits.maxTokens) {
    return {
      type: "stop",
      reason: "usage-limit",
      message: `${run.tokensMeasured ? "Reported" : "Estimated"} usage reached the ${run.limits.maxTokens.toLocaleString("en-US")}-token limit.`,
    };
  }
  if (run.iteration >= run.limits.maxIterations) {
    return {
      type: "stop",
      reason: "iteration-limit",
      message: `Used all ${run.limits.maxIterations} follow-up turns${report && !allPassed ? " with checks still failing" : ""}.`,
    };
  }
  const next = run.iteration + 1;
  const counter = `Supercharge (${superchargeLabel(run.preset)}) · follow-up ${next} of ${run.limits.maxIterations}`;
  if (report === null) {
    if (hasPhase(run, "verifying") && run.log.at(-1)?.phase === "verifying") {
      return { type: "stop", reason: "no-report", message: "The agent did not report its checks after being asked to." };
    }
    return {
      type: "continue",
      phase: "verifying",
      freshContext: false,
      prompt: `${counter}\n\nYour last reply had no Supercharge report. List the completion checks for this task, verify each one now, and end with the report block.`,
    };
  }
  if (!allPassed) {
    const failing = report.checks.filter((check) => check.status !== "pass");
    return {
      type: "continue",
      phase: "fixing",
      freshContext: false,
      prompt: `${counter}\n\n${
        failing.length > 0
          ? `These checks have not passed yet:\n${checkList(failing)}`
          : "You reported the task as not done."
      }${report.remaining ? `\n\nRemaining work you listed: ${report.remaining}` : ""}\n\nFix the cause, re-run the verification for every check, and report again.`,
    };
  }
  if (run.preset === "deep" && !hasPhase(run, "reviewing")) {
    return {
      type: "continue",
      phase: "reviewing",
      freshContext: false,
      prompt: `${counter}\n\nEvery check passed. Now review the whole diff for regressions and edge cases: callers you did not update, error and empty paths, boundary values, concurrency, and platform differences. Add checks for real risks, fix what you find, re-run verification, and report again.`,
    };
  }
  return {
    type: "continue",
    phase: "independent-review",
    freshContext: true,
    prompt: `${counter}\n\nIndependent review. Another session implemented a change in this working tree and reported these checks as passing:\n${checkList(report.checks)}\n\nVerify them yourself from the diff and by re-running the verification. Look for regressions and missed edge cases, fix real problems, and report.`,
  };
}

/** About four characters per token for English and code; labelled as an estimate in the UI. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The highest reasoning effort a model offers, for Deep, without changing the model. */
export function strongestEffort(options: ReadonlyArray<string>): string | null {
  const order = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];
  for (const level of order) if (options.includes(level)) return level;
  return options.at(-1) ?? null;
}
