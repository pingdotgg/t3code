import type { WorkflowQuestion, WorkflowRun, WorkflowStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allWorkflowRunNodes,
  buildWorkflowFeed,
  buildWorkflowTimeline,
  defaultWorkflowListTab,
  defaultWorkflowRunId,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowAgentSummary,
  workflowAnswer,
  workflowChip,
  workflowPath,
  workflowResultLines,
  workflowRunLists,
  workflowRunNow,
  workflowRunState,
  workflowSaidStart,
  workflowTriggerLine,
} from "./workflows.ts";

const two = (value: number) => String(value).padStart(2, "0");
const at = (minute: number, second = 0) => `2026-11-01T00:${two(minute)}:${two(second)}.000Z`;

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
  resumesAt: null,
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
  result: null,
  said: null,
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
  const registered = [
    { name: "release", version: 1, triggers: ["webhook tags"] },
    { name: "check", version: 1, triggers: [] },
    { name: "report", version: 2, triggers: ["daily at 09:00"] },
  ];

  it("puts what waits on a person first, then each workflow with its own runs", () => {
    const groups = groupWorkflowRuns(
      registered,
      [
        run("done", { status: "completed", endedAt: at(9) }),
        run("busy"),
        run("parent", { status: "waiting", detail: "check" }),
        // The child is what is paused, so its parent is the entry that needs someone.
        run("child", {
          workflow: "check",
          status: "paused",
          parentRunId: "parent",
          parentStep: "check",
        }),
        run("asks", { workflow: "old", status: "waiting", detail: "approve" }),
        run("orphan", { workflow: "old", status: "completed", endedAt: at(8), parentRunId: "x" }),
      ],
      [question("asks")],
    );
    expect(groups.needsYou.map((node) => node.run.runId)).toEqual(["parent", "asks"]);
    expect(groups.needsYou[0]?.children.map((node) => node.run.runId)).toEqual(["child"]);
    expect(
      groups.workflows.map((section) => [
        section.name,
        workflowTriggerLine(section),
        [...section.active, ...section.finished].map((node) => node.run.runId),
      ]),
    ).toEqual([
      // What is under way comes first, then what has run, then what only exists.
      ["release", "Starts on webhook tags", ["busy", "done"]],
      ["old", "No longer registered on this server", ["orphan"]],
      ["check", "Runs as part of other workflows", []],
      ["report", "Starts on daily at 09:00", []],
    ]);
    expect(allWorkflowRunNodes(groups).map((node) => node.run.runId)).toEqual([
      "parent",
      "child",
      "asks",
      "busy",
      "done",
      "orphan",
    ]);
    // Opening the page lands on the first thing to act on, not on its untroubled parent.
    expect(defaultWorkflowRunId(groups)).toBe("child");
  });

  it("opens a run that is under way when nothing waits on anyone, else the newest", () => {
    const quiet = groupWorkflowRuns(
      registered,
      [run("old", { endedAt: at(2), updatedAt: at(2) }), run("live", { workflow: "report" })],
      [],
    );
    expect(defaultWorkflowRunId(quiet)).toBe("live");
    const over = groupWorkflowRuns(
      registered,
      [
        run("first", { endedAt: at(2), updatedAt: at(2) }),
        run("last", { workflow: "report", endedAt: at(5), updatedAt: at(5) }),
      ],
      [],
    );
    expect(defaultWorkflowRunId(over)).toBe("last");
    expect(defaultWorkflowRunId(groupWorkflowRuns(registered, [], []))).toBeNull();
  });
});

describe("the list of runs", () => {
  const only = (fields: Partial<WorkflowRun>, questions: ReadonlyArray<WorkflowQuestion> = []) =>
    allWorkflowRunNodes(groupWorkflowRuns([], [run("a", fields)], questions))[0]!;

  it("gives a run the word the thread list would, and says what it is at", () => {
    const told = (fields: Partial<WorkflowRun>, questions?: ReadonlyArray<WorkflowQuestion>) => {
      const node = only(fields, questions);
      return `${workflowRunState(node).word}: ${workflowRunNow(node)}`;
    };
    expect(told({ status: "waiting", detail: "agent review" })).toBe("Working: review is working");
    expect(told({ status: "waiting", detail: "sleep night" })).toBe("Sleeping: Sleeping at night");
    expect(told({ status: "waiting", detail: "ci" })).toBe("Waiting: Waiting for ci");
    expect(told({ status: "waiting", detail: "approve" }, [question("a")])).toBe(
      "Input: Asks: Ship?",
    );
    expect(told({ status: "paused", detail: "build: exit 1\n  at build.ts" })).toBe(
      "Paused: build: exit 1",
    );
    expect(told({ status: "completed", endedAt: at(1), result: { merged: "ba6ac73" } })).toBe(
      "Done: merged: ba6ac73",
    );
    expect(told({ status: "cancelled", endedAt: at(1), detail: "superseded" })).toBe(
      "Cancelled: superseded",
    );
  });

  it("says of a run that waits on one it invoked what that one waits on", () => {
    const groups = groupWorkflowRuns(
      [],
      [
        run("child", { parentRunId: "parent", status: "waiting", title: "Check web" }),
        run("parent", { status: "waiting", detail: "check" }),
      ],
      [question("child")],
    );
    const parent = allWorkflowRunNodes(groups)[0]!;
    expect(workflowRunState(parent).word).toBe("Input");
    expect(workflowRunNow(parent)).toBe("Check web: Asks: Ship?");
  });

  it("sorts runs into what waits on a person, what is under way, and everything", () => {
    const groups = groupWorkflowRuns(
      [],
      [
        run("old", { status: "completed", endedAt: at(1), updatedAt: at(1) }),
        run("busy", { updatedAt: at(2) }),
        run("stuck", { status: "paused", updatedAt: at(3) }),
        run("new", { status: "completed", endedAt: at(4), updatedAt: at(4) }),
      ],
      [],
    );
    const lists = workflowRunLists(groups);
    const ids = (nodes: ReadonlyArray<{ readonly run: WorkflowRun }>) =>
      nodes.map((node) => node.run.runId);
    expect(ids(lists["needs-you"])).toEqual(["stuck"]);
    expect(ids(lists.running)).toEqual(["busy"]);
    expect(ids(lists.all)).toEqual(["stuck", "busy", "new", "old"]);
    expect(defaultWorkflowListTab(groups)).toBe("needs-you");
    expect(defaultWorkflowListTab(groupWorkflowRuns([], [run("busy")], []))).toBe("running");
    expect(
      defaultWorkflowListTab(
        groupWorkflowRuns([], [run("old", { status: "completed", endedAt: at(1) })], []),
      ),
    ).toBe("all");
  });

  it("marks a workflow with the same letters and colour every time", () => {
    expect(workflowChip("nightly-report").letters).toBe("NR");
    expect(workflowChip("issue").letters).toBe("IS");
    expect(workflowChip("issue")).toEqual(workflowChip("issue"));
  });
});

describe("workflowAgentSummary", () => {
  it("tells an agent's words apart from the facts of its result", () => {
    expect(workflowAgentSummary({ result: "Fixed in one line.", said: null })).toEqual({
      said: "Fixed in one line.",
      facts: [],
    });
    expect(
      workflowAgentSummary({
        said: "Reproduced on main.",
        result: { kind: "bug", reproduced: true, surfaces: ["web", "desktop"], prUrl: null },
      }),
    ).toEqual({
      said: "Reproduced on main.",
      facts: [
        { label: "kind", value: "bug" },
        { label: "reproduced", value: "yes" },
        { label: "surfaces", value: "web, desktop" },
      ],
    });
  });

  it("lets the longest prose of a result speak when no closing words were kept", () => {
    const summary =
      "The draft is stored per thread id, and a reload before the thread exists drops it for good.";
    expect(workflowAgentSummary({ said: null, result: { verdict: "merge", summary } })).toEqual({
      said: summary,
      facts: [{ label: "verdict", value: "merge" }],
    });
  });
});

describe("workflowSaidStart", () => {
  it("cuts a long reply where a paragraph ends", () => {
    const said =
      "It is a real bug.\n\n**Where:** line 5.\n\n**Reproduced:** yes, with 3660 seconds.";
    expect(workflowSaidStart(said, 200)).toBeNull();
    expect(workflowSaidStart(said, 40)).toBe("It is a real bug.\n\n**Where:** line 5.");
    expect(workflowSaidStart(said, 10)).toBe("It is a real bug.");
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
    // Read as a feed, the two reviews are one row, and the path has a stop per row that matters.
    const feed = buildWorkflowFeed(timeline);
    expect(
      feed.map((row) =>
        row.kind === "together"
          ? row.beats.map((beat) => beat.name).join("+")
          : row.kind === "quick"
            ? "quick"
            : row.name,
      ),
    ).toEqual(["quick", "triage", "review-a+review-b", "quick", "check", "build", "publish"]);
    expect(workflowPath(feed).map((node) => `${node.label}:${node.status}`)).toEqual([
      "triage:done",
      "review-a + review-b:done",
      "check:done",
      "build:done",
      "publish:failed",
    ]);
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

describe("workflowAnswer", () => {
  it("reads a person's answer off a question's result", () => {
    expect(workflowAnswer({ choice: "Ship", reason: " " })).toEqual({
      choice: "Ship",
      reason: null,
    });
    expect(workflowAnswer({ choice: "Hold", reason: "Too risky" })).toEqual({
      choice: "Hold",
      reason: "Too risky",
    });
    expect(workflowAnswer("done")).toBeNull();
    expect(workflowAnswer(null)).toBeNull();
  });
});
