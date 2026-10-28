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

function liveRun(id: string, status: "running" | "paused", stepNames: ReadonlyArray<string> = []) {
  return {
    id: PipelineRunId.make(id),
    status,
    steps: stepNames.map((name) => ({ stepId: name.toLowerCase(), name })),
  } as unknown as PipelineRunSummary;
}
const liveRuns = indexPipelineLiveRuns([
  { environmentId: env, runs: [liveRun("r1", "paused", ["Plan"]), liveRun("r2", "running")] },
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
  it.each([
    { steps: [], expected: null },
    { steps: ["ready", "waiting", "failed"], expected: null },
    { steps: ["ready", "working"], expected: "working" },
    { steps: ["working", "input", "ready"], expected: "input" },
    { steps: ["working", "request", "approval"], expected: "approval" },
  ])("aggregates $steps to $expected", ({ steps, expected }) => {
    expect(aggregatePipelineStepStatus(steps)).toBe(expected);
  });

  it.each([
    { steps: [], run: "paused", expected: "input" },
    { steps: ["working"], run: "paused", expected: "input" },
    { steps: ["approval"], run: "paused", expected: "approval" },
    { steps: ["working"], run: "running", expected: "working" },
    { steps: [], run: "running", expected: null },
  ] as const)("a $run run with steps $steps shows $expected", ({ steps, run, expected }) => {
    expect(aggregatePipelineStepStatus(steps, { status: run })).toBe(expected);
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
    { name: "its run is paused", parent: "p", active: ["s2"], expected: false, live: true },
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
