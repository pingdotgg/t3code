import {
  EnvironmentId,
  PipelineRunId,
  ThreadId,
  type PipelineRunSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregatePipelineStepStatus,
  indexPipelineLiveRuns,
  isPipelineGroupActive,
  mergePipelineParentStatus,
  nestedPipelineStepLabel,
  nestPipelineSteps,
  pipelineAttentionTargets,
  pipelineParentsOfSteps,
  pipelineProgressSegments,
  pipelineShownSteps,
  pipelineStepAttempts,
  pipelineStepLabel,
  pipelineStepsOfParents,
  withPipelineExpanded,
} from "./pipelineNesting.ts";

const env = EnvironmentId.make("env-1");

function shell(
  id: string,
  createdAt: string,
  pipeline?: { runId: string; stepId: string | null },
  environmentId: EnvironmentId = env,
) {
  return { id: ThreadId.make(id), environmentId, createdAt, pipeline: pipeline ?? null };
}

function liveRun(
  id: string,
  status: "running" | "paused",
  stepNames: ReadonlyArray<string> = [],
  currentStep: { index: number; threadId: string } | null = null,
) {
  return {
    id: PipelineRunId.make(id),
    status,
    currentStepIndex: currentStep?.index ?? 0,
    steps: stepNames.map((name, index) => ({
      stepId: name.toLowerCase(),
      name,
      childThreadId: currentStep?.index === index ? ThreadId.make(currentStep.threadId) : null,
    })),
  } as unknown as PipelineRunSummary;
}
const liveRuns = indexPipelineLiveRuns([
  {
    environmentId: env,
    runs: [
      liveRun("r1", "paused", ["Plan", "Build"], { index: 1, threadId: "s2" }),
      liveRun("r2", "running"),
    ],
  },
]);

const parent = (id: string, runId: string, createdAt = "2026-01-01T00:00:00Z") =>
  shell(id, createdAt, { runId, stepId: null });
const step = (id: string, runId: string, stepId: string, createdAt: string) =>
  shell(id, createdAt, { runId, stepId });

function layout(
  shells: ReturnType<typeof shell>[],
  anchored?: (parent: ReturnType<typeof shell>) => boolean,
) {
  const nesting = nestPipelineSteps(shells, anchored ? { anchored } : undefined);
  return nesting.rows.map((row) => {
    const steps = nesting.stepsByParentKey.get(`${row.environmentId}:${row.id}`) ?? [];
    return steps.length === 0 ? row.id : `${row.id}[${steps.map((s) => s.id).join(",")}]`;
  });
}

describe("nestPipelineSteps", () => {
  it.each([
    {
      name: "leaves lists without pipelines untouched",
      shells: [shell("a", "2026-01-03T00:00:00Z"), shell("b", "2026-01-02T00:00:00Z")],
      expected: ["a", "b"],
    },
    {
      name: "nests steps under the parent in step (createdAt) order, retries after their step",
      shells: [
        parent("p", "r1"),
        step("s3", "r1", "review", "2026-01-01T00:03:00Z"),
        step("s1", "r1", "plan", "2026-01-01T00:01:00Z"),
        step("s2", "r1", "build", "2026-01-01T00:02:00Z"),
        step("s2b", "r1", "build", "2026-01-01T00:02:30Z"),
      ],
      expected: ["p[s1,s2,s2b,s3]"],
    },
    {
      name: "keeps steps top-level when the parent is not in the list",
      shells: [
        shell("x", "2026-01-05T00:00:00Z"),
        step("s1", "r1", "plan", "2026-01-01T00:01:00Z"),
        step("s2", "r1", "build", "2026-01-01T00:02:00Z"),
      ],
      expected: ["x", "s1", "s2"],
    },
    {
      name: "does not nest across environments",
      shells: [
        parent("p", "r1"),
        shell(
          "s1",
          "2026-01-01T00:01:00Z",
          { runId: "r1", stepId: "plan" },
          EnvironmentId.make("env-2"),
        ),
      ],
      expected: ["p", "s1"],
    },
    {
      name: "sorts a run by its most recent member when the list is newest first",
      shells: [
        shell("new", "2026-01-09T00:00:00Z"),
        step("s2", "r1", "build", "2026-01-08T00:00:00Z"),
        shell("mid", "2026-01-05T00:00:00Z"),
        parent("p", "r1", "2026-01-01T00:00:00Z"),
        step("s1", "r1", "plan", "2026-01-02T00:00:00Z"),
      ],
      expected: ["new", "p[s1,s2]", "mid"],
    },
    {
      name: "keeps the parent's place when it is already the first member",
      shells: [
        parent("p", "r1"),
        shell("a", "2026-01-05T00:00:00Z"),
        step("s1", "r1", "plan", "2026-01-02T00:00:00Z"),
      ],
      expected: ["p[s1]", "a"],
    },
    {
      name: "keeps an anchored parent where the user put it",
      shells: [
        step("s2", "r1", "build", "2026-01-08T00:00:00Z"),
        shell("a", "2026-01-05T00:00:00Z"),
        parent("p", "r1"),
      ],
      anchored: true,
      expected: ["a", "p[s2]"],
    },
    {
      name: "groups two runs independently and leaves a stepless parent alone",
      shells: [
        parent("p1", "r1"),
        parent("p2", "r2"),
        step("t1", "r2", "plan", "2026-01-02T00:00:00Z"),
        step("s1", "r1", "plan", "2026-01-03T00:00:00Z"),
        parent("lonely", "r3"),
      ],
      expected: ["p1[s1]", "p2[t1]", "lonely"],
    },
  ])("$name", ({ shells, expected, anchored }) => {
    expect(layout(shells, anchored ? () => true : undefined)).toEqual(expected);
  });
});

describe("nestedPipelineStepLabel", () => {
  it.each([
    ["Feature delivery · Plan", "Plan"],
    ["Feature delivery · Implement (attempt 2)", "Implement (attempt 2)"],
    ["A · B · C", "B · C"],
    ["No separator here", "No separator here"],
    ["Trailing · ", "Trailing · "],
  ])("%s -> %s", (title, label) => {
    expect(nestedPipelineStepLabel(title)).toBe(label);
  });
});

describe("pipelineStepLabel", () => {
  it.each([
    ["the live run's step name", step("s1", "r1", "plan", "2026-01-01T00:00:00Z"), "Plan"],
    ["the title when the run has no such step", step("s2", "r1", "x", "2026-01-01T00:00:00Z"), "X"],
    ["the title when the run is not live", step("s3", "gone", "plan", "2026-01-01T00:00:00Z"), "X"],
    [
      "the title in another environment",
      shell(
        "s4",
        "2026-01-01T00:00:00Z",
        { runId: "r1", stepId: "plan" },
        EnvironmentId.make("other"),
      ),
      "X",
    ],
  ])("uses %s", (_name, target, expected) => {
    expect(pipelineStepLabel(liveRuns, { ...target, title: "Feature · X" })).toBe(expected);
  });
});

describe("pipeline parent status", () => {
  // Step threads s0, s1, ... with the given statuses; s0 is the run's current step.
  const statusSteps = (statuses: ReadonlyArray<string>) =>
    statuses.map((status, index) => ({
      ...step(`s${index}`, "r1", `step-${index}`, "2026-01-01T00:01:00Z"),
      status,
    }));
  const statusOf = (s: { status: string }) => s.status;
  const runWith = (status: "running" | "paused", currentThreadId: string | null) =>
    ({
      status,
      currentStepIndex: 0,
      steps: [
        {
          stepId: "step-0",
          name: "",
          status: "running",
          childThreadId: currentThreadId === null ? null : ThreadId.make(currentThreadId),
        },
      ],
    }) as unknown as PipelineRunSummary;

  it.each([
    { steps: [], expected: null },
    { steps: ["ready", "waiting", "failed"], expected: null },
    { steps: ["ready", "queued"], expected: null },
    { steps: ["ready", "working"], expected: "working" },
    { steps: ["working", "input", "ready"], expected: "input" },
    { steps: ["working", "request", "approval"], expected: "approval" },
  ])("aggregates $steps to $expected", ({ steps, expected }) => {
    expect(aggregatePipelineStepStatus(statusSteps(steps), statusOf)).toBe(expected);
  });

  it.each([
    { name: "a paused run before its step starts", steps: [], run: "paused", expected: "input" },
    { name: "a paused run whose step ended", steps: ["ready"], run: "paused", expected: "input" },
    {
      name: "a paused run whose step works again",
      steps: ["working"],
      run: "paused",
      expected: "working",
    },
    { name: "a paused run whose step monitors", steps: ["waiting"], run: "paused", expected: null },
    { name: "a paused run whose step is queued", steps: ["queued"], run: "paused", expected: null },
    {
      name: "a paused run whose step asks",
      steps: ["approval"],
      run: "paused",
      expected: "approval",
    },
    { name: "a running run", steps: ["working"], run: "running", expected: "working" },
    { name: "a running run with no steps", steps: [], run: "running", expected: null },
  ] as const)("$name shows $expected", ({ steps, run, expected }) => {
    expect(
      aggregatePipelineStepStatus(
        statusSteps(steps),
        statusOf,
        runWith(run, steps.length === 0 ? null : "s0"),
      ),
    ).toBe(expected);
  });

  it.each([
    { own: "ready", step: "working", expected: "working" },
    { own: "waiting", step: "input", expected: "input" },
    { own: "ready", step: null, expected: "ready" },
    { own: "failed", step: "working", expected: "failed" },
    { own: "working", step: "input", expected: "working" },
  ] as const)("$own with step $step shows $expected", ({ own, step, expected }) => {
    expect(mergePipelineParentStatus(own, step)).toBe(expected);
  });
});

describe("isPipelineGroupActive", () => {
  const shells = [
    parent("p", "r1"),
    step("s1", "r1", "plan", "2026-01-01T00:01:00Z"),
    step("s2", "r1", "build", "2026-01-01T00:02:00Z"),
    parent("idle", "r2"),
    step("t1", "r2", "plan", "2026-01-01T00:03:00Z"),
  ];
  const stepsOfParent = pipelineStepsOfParents(shells, pipelineParentsOfSteps(shells));

  it.each([
    { name: "a step is active", parent: "p", active: ["s2"], expected: true },
    { name: "only the parent is active", parent: "p", active: ["p"], expected: true },
    { name: "another run's step is active", parent: "idle", active: ["s2"], expected: false },
    { name: "nothing is active", parent: "p", active: [], expected: false },
    { name: "its paused run's step is idle", parent: "p", active: [], expected: false, live: true },
    {
      name: "only an earlier step of its paused run is active",
      parent: "p",
      active: ["s1"],
      expected: false,
      live: true,
    },
    {
      name: "its paused run's current step is active again",
      parent: "p",
      active: ["s2"],
      expected: true,
      live: true,
    },
    { name: "its run is running", parent: "idle", active: ["t1"], expected: true, live: true },
  ])("$name", ({ parent: parentId, active, expected, live }) => {
    const target = shells.find((shell) => shell.id === parentId)!;
    expect(
      isPipelineGroupActive(
        target,
        stepsOfParent,
        (shell) => active.includes(shell.id),
        live ? liveRuns : undefined,
      ),
    ).toBe(expected);
  });
});

describe("pipelineProgressSegments", () => {
  const titled = (id: string, stepId: string, createdAt: string, title: string) => ({
    ...step(id, "r1", stepId, createdAt),
    title,
  });
  const summarize = (
    segments: ReadonlyArray<{ label: string; status: string; thread: { id: string } | null }>,
  ) => segments.map((segment) => `${segment.label}:${segment.status}:${segment.thread?.id ?? "-"}`);

  it("shows every defined step of a live run, started or not", () => {
    const run = {
      id: PipelineRunId.make("r1"),
      status: "running",
      currentStepIndex: 1,
      steps: [
        { stepId: "plan", name: "Plan", status: "completed", childThreadId: ThreadId.make("s1") },
        { stepId: "build", name: "Build", status: "running", childThreadId: ThreadId.make("s2") },
        { stepId: "qa", name: "QA", status: "pending", childThreadId: null },
      ],
    } as unknown as PipelineRunSummary;
    const steps = [
      titled("s1", "plan", "2026-01-01T00:01:00Z", "P · Plan"),
      titled("s2", "build", "2026-01-01T00:02:00Z", "P · Build"),
    ];
    expect(summarize(pipelineProgressSegments(run, steps, () => "working"))).toEqual([
      "Plan:completed:s1",
      "Build:running:s2",
      "QA:pending:-",
    ]);
    // A running step waiting on the user needs attention.
    expect(
      summarize(pipelineProgressSegments(run, steps, (s) => (s.id === "s2" ? "input" : "ready"))),
    ).toContain("Build:attention:s2");
  });

  it("marks the step a paused run waits on", () => {
    const run = {
      id: PipelineRunId.make("r1"),
      status: "paused",
      currentStepIndex: 1,
      steps: [
        { stepId: "plan", name: "Plan", status: "completed", childThreadId: null },
        { stepId: "build", name: "Build", status: "pending", childThreadId: null },
        { stepId: "qa", name: "QA", status: "cancelled", childThreadId: null },
      ],
    } as unknown as PipelineRunSummary;
    expect(summarize(pipelineProgressSegments(run, [], () => "ready"))).toEqual([
      "Plan:completed:-",
      "Build:attention:-",
      "QA:stopped:-",
    ]);
    // Paused for a handoff, the current step is still running.
    const awaitingHandoff = {
      ...run,
      currentStepIndex: 0,
      steps: run.steps.map((entry, index) =>
        index === 0 ? { ...entry, status: "running" } : entry,
      ),
    } as PipelineRunSummary;
    expect(summarize(pipelineProgressSegments(awaitingHandoff, [], () => "ready"))[0]).toBe(
      "Plan:attention:-",
    );
    // Once that step works or monitors again, nothing waits on the user.
    const resumed = {
      ...awaitingHandoff,
      steps: awaitingHandoff.steps.map((entry, index) =>
        index === 0 ? { ...entry, childThreadId: ThreadId.make("s1") } : entry,
      ),
    } as PipelineRunSummary;
    const plan = [titled("s1", "plan", "2026-01-01T00:01:00Z", "P · Plan")];
    for (const busy of ["queued", "working", "waiting"]) {
      expect(summarize(pipelineProgressSegments(resumed, plan, () => busy))[0]).toBe(
        "Plan:running:s1",
      );
    }
    expect(summarize(pipelineProgressSegments(resumed, plan, () => "ready"))[0]).toBe(
      "Plan:attention:s1",
    );
  });

  it("builds a finished run from its threads, one segment per step at its latest attempt", () => {
    const steps = [
      titled("s1", "plan", "2026-01-01T00:01:00Z", "P · Plan"),
      titled("s2", "build", "2026-01-01T00:02:00Z", "P · Build"),
      titled("s3", "build", "2026-01-01T00:03:00Z", "P · Build (attempt 2)"),
    ];
    const status = (s: { id: string }) =>
      s.id === "s2" ? "failed" : s.id === "s3" ? "queued" : "ready";
    expect(summarize(pipelineProgressSegments(undefined, steps, status))).toEqual([
      "Plan:completed:s1",
      "Build (attempt 2):running:s3",
    ]);
  });
});

describe("pipelineAttentionTargets and pipelineStepAttempts", () => {
  const titled = (id: string, stepId: string, createdAt: string) => ({
    ...step(id, "r1", stepId, createdAt),
    title: `P · ${stepId}`,
  });
  const runOf = (
    status: "running" | "paused",
    currentStepIndex: number,
    entries: ReadonlyArray<[string, string, string | null]>,
    pauseReason: string | null = status === "paused" ? "awaiting_handoff" : null,
  ) =>
    ({
      id: PipelineRunId.make("r1"),
      status,
      pauseReason,
      currentStepIndex,
      steps: entries.map(([stepId, entryStatus, childThreadId]) => ({
        stepId,
        name: stepId,
        status: entryStatus,
        childThreadId: childThreadId === null ? null : ThreadId.make(childThreadId),
      })),
    }) as unknown as PipelineRunSummary;
  const threads = [
    titled("s1", "plan", "2026-01-01T00:01:00Z"),
    titled("s2", "build", "2026-01-01T00:02:00Z"),
    titled("s3", "qa", "2026-01-01T00:03:00Z"),
  ];
  const summarize = (result: ReturnType<typeof pipelineAttentionTargets>) => ({
    marked: [...result.attentionThreads],
    target: result.target?.id ?? null,
  });
  const entries: Array<[string, string, string | null]> = [
    ["plan", "completed", "s1"],
    ["build", "completed", "s2"],
    ["qa", "running", "s3"],
    ["review", "pending", null],
  ];

  it.each([
    {
      name: "marks an idle thread of a run paused awaiting handoff",
      run: runOf("paused", 2, entries),
      status: () => "ready",
      expected: { marked: [[`${env}:s3`, "input"]], target: "s3" },
    },
    {
      name: "marks a failed step a paused run stopped at",
      run: runOf(
        "paused",
        2,
        entries.map((e) => (e[0] === "qa" ? ["qa", "failed", "s3"] : e)),
      ),
      status: () => "failed",
      expected: { marked: [[`${env}:s3`, "input"]], target: "s3" },
    },
    {
      name: "marks nothing while the paused step's thread works",
      run: runOf("paused", 2, entries),
      status: () => "working",
      expected: { marked: [], target: null },
    },
    {
      name: "targets an earlier step asking for approval unless the current step needs you",
      run: runOf("running", 2, entries),
      status: (s: { id: string }) => (s.id === "s1" ? "approval" : "working"),
      expected: { marked: [[`${env}:s1`, "approval"]], target: "s1" },
    },
    {
      name: "prefers the current step over an earlier one",
      run: runOf("running", 2, entries),
      status: (s: { id: string }) =>
        s.id === "s1" ? "approval" : s.id === "s3" ? "input" : "ready",
      expected: {
        marked: [
          [`${env}:s1`, "approval"],
          [`${env}:s3`, "input"],
        ],
        target: "s3",
      },
    },
    {
      name: "marks no thread before a gated step that has none",
      run: runOf("paused", 1, [
        ["plan", "completed", "s1"],
        ["build", "pending", null],
      ]),
      status: () => "ready",
      expected: { marked: [], target: null },
    },
    {
      name: "marks no older thread of a gated step the run is paused before",
      run: runOf(
        "paused",
        1,
        [
          ["plan", "completed", "s1"],
          ["build", "pending", null],
          ["qa", "pending", null],
        ],
        "awaiting_continue",
      ),
      steps: threads,
      status: () => "ready",
      expected: { marked: [], target: null },
    },
    {
      name: "ignores an earlier attempt asking for approval",
      run: runOf("running", 2, entries),
      steps: [titled("s0", "qa", "2026-01-01T00:00:30Z"), ...threads],
      status: (s: { id: string }) => (s.id === "s0" ? "approval" : "working"),
      expected: { marked: [], target: null },
    },
  ])("$name", ({ run, steps, status, expected }) => {
    const started = steps ?? threads.filter((s) => run.steps.some((e) => e.childThreadId === s.id));
    expect(summarize(pipelineAttentionTargets(run, started, status))).toEqual(expected);
  });

  it("marks the latest attempt with input in a finished run", () => {
    const attempts = [...threads, titled("s4", "qa", "2026-01-01T00:04:00Z")];
    const status = (s: { id: string }) => (s.id === "s3" || s.id === "s4" ? "input" : "ready");
    expect(summarize(pipelineAttentionTargets(undefined, attempts, status))).toEqual({
      marked: [[`${env}:s4`, "input"]],
      target: "s4",
    });
  });

  it("splits current from earlier attempts in run order and flags steps the run will redo", () => {
    const rerun = runOf("paused", 0, [
      ["plan", "running", "s5"],
      ["build", "pending", null],
      ["qa", "pending", null],
    ]);
    const all = [
      ...threads,
      titled("s4", "plan", "2026-01-01T00:04:00Z"),
      titled("s5", "plan", "2026-01-01T00:05:00Z"),
    ];
    const result = pipelineStepAttempts(rerun, all);
    expect(result.current.map((s) => s.id)).toEqual(["s5", "s2", "s3"]);
    expect(result.earlier.map((e) => `${e.thread.id}#${e.attempt}`)).toEqual(["s1#1", "s4#2"]);
    expect([...result.redoKeys].sort()).toEqual([`${env}:s2`, `${env}:s3`]);
    expect(pipelineStepAttempts(undefined, all).current.map((s) => s.id)).toEqual([
      "s5",
      "s2",
      "s3",
    ]);
  });

  it("shows the open step when collapsed, even an earlier attempt, and folds the rest", () => {
    const attempts = pipelineStepAttempts(undefined, [
      titled("a1", "plan", "2026-01-01T00:01:00Z"),
      titled("a2", "plan", "2026-01-01T00:02:00Z"),
      titled("b1", "build", "2026-01-01T00:03:00Z"),
    ]);
    const shown = (expanded: boolean, foldExpanded: boolean, open: string | null) => {
      const result = pipelineShownSteps(attempts, {
        expanded,
        foldExpanded,
        isOpen: (thread) => thread.id === open,
      });
      return {
        current: result.current.map((t) => t.id),
        earlier: result.earlier.map((e) => e.thread.id),
        foldCount: result.foldCount,
      };
    };
    expect(shown(false, true, "a1")).toEqual({ current: [], earlier: ["a1"], foldCount: 0 });
    expect(shown(false, false, "b1")).toEqual({ current: ["b1"], earlier: [], foldCount: 0 });
    expect(shown(true, false, "a1")).toEqual({
      current: ["a2", "b1"],
      earlier: ["a1"],
      foldCount: 1,
    });
    expect(shown(true, true, null)).toEqual({
      current: ["a2", "b1"],
      earlier: ["a1"],
      foldCount: 1,
    });
  });

  it("closes a run's earlier-attempts fold when the run collapses", () => {
    const keys = withPipelineExpanded(["a", "b"], "b#earlier", true, 3);
    expect(keys).toEqual(["a", "b", "b#earlier"]);
    expect(withPipelineExpanded(keys, "c", true, 3)).toEqual(["b", "b#earlier", "c"]);
    expect(withPipelineExpanded(keys, "b", false, 3)).toEqual(["a"]);
  });
});
