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
  pipelineParentsOfSteps,
  pipelineProgressSegments,
  pipelineStepLabel,
  pipelineStepsOfParents,
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
    for (const busy of ["working", "waiting"]) {
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
    const status = (s: { id: string }) => (s.id === "s2" ? "failed" : "ready");
    expect(summarize(pipelineProgressSegments(undefined, steps, status))).toEqual([
      "Plan:completed:s1",
      "Build (attempt 2):completed:s3",
    ]);
  });
});
