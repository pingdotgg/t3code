import type { WorkflowQuestion, WorkflowRun, WorkflowStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkflowTimeline,
  defaultWorkflowRunId,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowBeatSpan,
  workflowResultLines,
  workflowRunActivity,
} from "./workflows.logic";

const at = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 10, 1, 0, minute, second)).toISOString();

const run = (runId: string, fields: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId,
  workflow: "release",
  version: 1,
  title: runId,
  status: "running",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  parentRunId: null,
  parentStep: null,
  startedAt: at(0),
  updatedAt: at(0),
  endedAt: null,
  ...fields,
});
const step = (
  name: string,
  kind: WorkflowStep["kind"],
  from: string,
  to: string | null,
  fields: Partial<WorkflowStep> = {},
): WorkflowStep => ({
  name,
  kind,
  status: to === null ? "running" : "completed",
  attempts: 1,
  detail: null,
  threadId: null,
  environmentId: null,
  startedAt: from,
  endedAt: to,
  ...fields,
});
const question = (runId: string, request: unknown = { title: "Ship?" }): WorkflowQuestion => ({
  runId,
  name: "approve",
  request: request as never,
  askedAt: at(1),
  thread: null,
});

describe("groupWorkflowRuns", () => {
  it("puts what waits on a person first, and a piece of work in one place", () => {
    const groups = groupWorkflowRuns(
      [
        run("done", { status: "completed", endedAt: at(9) }),
        run("busy"),
        run("parent", { status: "waiting", detail: "check" }),
        // The child is what is paused, so its parent is the entry that needs someone.
        run("child", { status: "paused", parentRunId: "parent", parentStep: "check" }),
        run("asks", { status: "waiting", detail: "approve" }),
        run("orphan", { status: "completed", endedAt: at(8), parentRunId: "gone" }),
      ],
      [question("asks")],
    );
    expect(groups.needsYou.map((node) => node.run.runId)).toEqual(["parent", "asks"]);
    expect(groups.needsYou[0]?.children.map((node) => node.run.runId)).toEqual(["child"]);
    expect(groups.active.map((node) => node.run.runId)).toEqual(["busy"]);
    expect(groups.finished.map((node) => node.run.runId)).toEqual(["done", "orphan"]);
    // Opening the page lands on the first thing to act on, not on its untroubled parent.
    expect(defaultWorkflowRunId(groups)).toBe("child");
  });

  it("opens the newest run when nothing waits on anyone", () => {
    const groups = groupWorkflowRuns([run("old", { endedAt: at(2) }), run("live")], []);
    expect(defaultWorkflowRunId(groups)).toBe("live");
    expect(defaultWorkflowRunId(groupWorkflowRuns([], []))).toBeNull();
  });
});

describe("workflowRunActivity", () => {
  it("says what a run is doing in a person's words", () => {
    expect(workflowRunActivity(run("a", { status: "waiting", detail: "agent review" }), 0)).toBe(
      "Agent working on review",
    );
    expect(workflowRunActivity(run("a", { status: "waiting", detail: "sleep night" }), 0)).toBe(
      "Sleeping",
    );
    expect(workflowRunActivity(run("a", { status: "waiting", detail: "ci" }), 0)).toBe(
      "Waiting for ci",
    );
    expect(workflowRunActivity(run("a", { status: "waiting", detail: "approve" }), 1)).toBe(
      "Asks you a question",
    );
    expect(workflowRunActivity(run("a", { status: "paused", detail: "build: exit 1" }), 0)).toBe(
      "build: exit 1",
    );
    expect(workflowRunActivity(run("a", { status: "completed" }), 0)).toBeNull();
  });
});

describe("buildWorkflowTimeline", () => {
  it("keeps the beats of a run and folds the bookkeeping between them", () => {
    const parent = run("r", { startedAt: at(0), endedAt: at(10) });
    const child = run("c", { parentRunId: "r", parentStep: "check", title: "Check web" });
    const timeline = buildWorkflowTimeline({
      run: parent,
      children: [child],
      nowMs: Date.parse(at(10)),
      steps: [
        step("load", "step", at(0), at(0)),
        step("switch", "step", at(0), at(0)),
        step("triage", "agent", at(0), at(3), { threadId: "t1" }),
        // Two reviews at once.
        step("review-a", "agent", at(3), at(5)),
        step("review-b", "agent", at(3), at(6)),
        step("record", "step", at(6), at(6)),
        step("check/start", "step", at(6), at(6)),
        step("check", "wait", at(6), at(8)),
        step("build", "step", at(8), at(9)),
        step("publish", "step", at(9), at(9), { status: "failed", detail: "503" }),
      ],
    });
    expect(
      timeline.rows.map((row) =>
        row.kind === "quick"
          ? `quick:${row.steps.map((quick) => quick.name).join(",")}`
          : `${row.kind}:${row.name}${row.parallel ? ":parallel" : ""}`,
      ),
    ).toEqual([
      "quick:load,switch",
      "agent:triage",
      "agent:review-a:parallel",
      "agent:review-b:parallel",
      "quick:record",
      // The step that started the invoked run is told by the wait for it.
      "run:check",
      // A plain step that took a minute is a beat; so is one that failed in no time.
      "step:build",
      "step:publish",
    ]);
    const invoked = timeline.rows.find((row) => row.kind === "run");
    expect(invoked?.kind === "run" ? invoked.childRun?.title : null).toBe("Check web");
    const triage = timeline.rows.find((row) => row.kind === "agent");
    expect(triage?.kind === "agent" ? workflowBeatSpan(timeline, triage) : null).toEqual({
      offset: 0,
      length: 0.3,
    });
  });

  it("measures a step that is under way up to now", () => {
    const timeline = buildWorkflowTimeline({
      run: run("r", { startedAt: at(0) }),
      children: [],
      nowMs: Date.parse(at(4)),
      steps: [step("fix", "agent", at(1), null)],
    });
    const [fix] = timeline.rows;
    expect(fix?.kind === "agent" ? [fix.endMs - fix.startMs, timeline.endMs] : null).toEqual([
      180_000,
      Date.parse(at(4)),
    ]);
  });
});

describe("workflowResultLines", () => {
  it("reads a result as a sentence or as its fields", () => {
    expect(workflowResultLines("merged as ba6ac7")).toEqual([
      { label: null, value: "merged as ba6ac7" },
    ]);
    expect(workflowResultLines({ sent: true, to: "everyone" })).toEqual([
      { label: "sent", value: "true" },
      { label: "to", value: "everyone" },
    ]);
    expect(workflowResultLines(null)).toEqual([]);
  });
});

describe("readWorkflowQuestion", () => {
  it("reads the title, the choices and the body, and drops parts of another shape", () => {
    expect(
      readWorkflowQuestion(
        question("r", { title: "Ship it?", choices: ["yes", 2], data: { body: "Diff is small." } }),
      ),
    ).toEqual({ title: "Ship it?", choices: ["yes"], body: "Diff is small." });
    expect(readWorkflowQuestion(question("r", null))).toEqual({
      title: "approve",
      choices: [],
      body: null,
    });
  });
});
