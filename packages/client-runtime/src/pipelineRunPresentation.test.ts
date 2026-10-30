import {
  ThreadId,
  type PipelinePauseReason,
  type PipelineRun,
  type PipelineRunStatus,
  type PipelineRunStepStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availablePipelineActions,
  pipelineFeedingStep,
  pipelineRunStatusLabel,
  pipelineStepAwaitsHandoff,
  pipelineStepBreadcrumbTitle,
  pipelineStepPosition,
} from "./pipelineRunPresentation.ts";

const NAMES = ["Plan", "Implement", "Review"] as const;

function makeRun(input: {
  readonly status: PipelineRunStatus;
  readonly pauseReason?: PipelinePauseReason | null;
  readonly currentStepIndex: number;
  readonly stepStatuses: ReadonlyArray<PipelineRunStepStatus>;
}): PipelineRun {
  return {
    status: input.status,
    pauseReason: input.pauseReason ?? null,
    currentStepIndex: input.currentStepIndex,
    definition: { name: "Pipeline", steps: NAMES.map((name) => ({ name })) },
    steps: input.stepStatuses.map((status, index) => ({ index, status })),
  } as unknown as PipelineRun;
}

describe("availablePipelineActions", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly run: PipelineRun;
    readonly expected: {
      readonly continue: boolean;
      readonly retry: boolean;
      readonly skip: boolean;
      readonly cancel: boolean;
    };
    readonly toggle: ReadonlyArray<boolean>;
  }> = [
    {
      name: "running step",
      run: makeRun({
        status: "running",
        currentStepIndex: 1,
        stepStatuses: ["completed", "running", "pending"],
      }),
      expected: { continue: false, retry: false, skip: false, cancel: true },
      toggle: [false, false, true],
    },
    {
      name: "paused awaiting continue",
      run: makeRun({
        status: "paused",
        pauseReason: "awaiting_continue",
        currentStepIndex: 1,
        stepStatuses: ["completed", "pending", "pending"],
      }),
      expected: { continue: true, retry: true, skip: true, cancel: true },
      toggle: [false, true, true],
    },
    {
      name: "paused after step failure",
      run: makeRun({
        status: "paused",
        pauseReason: "step_failed",
        currentStepIndex: 1,
        stepStatuses: ["completed", "failed", "pending"],
      }),
      expected: { continue: true, retry: true, skip: true, cancel: true },
      toggle: [false, false, true],
    },
    {
      name: "paused after step stopped",
      run: makeRun({
        status: "paused",
        pauseReason: "step_stopped",
        currentStepIndex: 0,
        stepStatuses: ["stopped", "pending", "pending"],
      }),
      expected: { continue: true, retry: true, skip: true, cancel: true },
      toggle: [false, true, true],
    },
    {
      name: "cancelled",
      run: makeRun({
        status: "cancelled",
        currentStepIndex: 1,
        stepStatuses: ["completed", "cancelled", "pending"],
      }),
      expected: { continue: false, retry: true, skip: true, cancel: false },
      toggle: [false, false, true],
    },
    {
      name: "completed",
      run: makeRun({
        status: "completed",
        currentStepIndex: 3,
        stepStatuses: ["completed", "skipped", "completed"],
      }),
      expected: { continue: false, retry: false, skip: false, cancel: false },
      toggle: [false, false, false],
    },
  ];

  it.each(cases)("$name", ({ run, expected, toggle }) => {
    const actions = availablePipelineActions(run);
    expect({
      continue: actions.continue,
      retry: actions.retry,
      skip: actions.skip,
      cancel: actions.cancel,
    }).toEqual(expected);
    expect([0, 1, 2].map((index) => actions.canTogglePauseBefore(index))).toEqual(toggle);
  });

  it("rejects pause-before toggles outside the step list", () => {
    const run = makeRun({
      status: "running",
      currentStepIndex: 0,
      stepStatuses: ["running", "pending", "pending"],
    });
    expect(availablePipelineActions(run).canTogglePauseBefore(3)).toBe(false);
  });
});

describe("rerunFrom", () => {
  it("offers earlier steps of a paused or cancelled run and every run step of a completed one", () => {
    const paused = makeRun({
      status: "paused",
      pauseReason: "awaiting_handoff",
      currentStepIndex: 1,
      stepStatuses: ["completed", "running", "pending"],
    });
    expect([0, 1, 2].map(availablePipelineActions(paused).rerunFrom)).toEqual([true, false, false]);
    const cancelled = makeRun({
      status: "cancelled",
      currentStepIndex: 2,
      stepStatuses: ["completed", "completed", "cancelled"],
    });
    expect([0, 1, 2].map(availablePipelineActions(cancelled).rerunFrom)).toEqual([
      true,
      true,
      false,
    ]);
    const completed = makeRun({
      status: "completed",
      currentStepIndex: 2,
      stepStatuses: ["completed", "completed", "completed"],
    });
    expect([0, 1, 2, 3].map(availablePipelineActions(completed).rerunFrom)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    const running = makeRun({
      status: "running",
      currentStepIndex: 1,
      stepStatuses: ["completed", "running", "pending"],
    });
    expect([0, 1, 2].map(availablePipelineActions(running).rerunFrom)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("missing handoff", () => {
  it("labels the run and marks only the current step", () => {
    const run = makeRun({
      status: "paused",
      pauseReason: "awaiting_handoff",
      currentStepIndex: 1,
      stepStatuses: ["completed", "running", "pending"],
    });
    expect(pipelineRunStatusLabel(run)).toBe("Implement ended without handing off");
    expect([0, 1, 2].map((index) => pipelineStepAwaitsHandoff(run, index))).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("pipelineFeedingStep", () => {
  function withChildren(run: PipelineRun, children: ReadonlyArray<string | null>): PipelineRun {
    return {
      ...run,
      steps: run.steps.map((step, index) => {
        const child = children[index];
        return { ...step, childThreadId: child == null ? null : ThreadId.make(child) };
      }),
    };
  }

  it("names the previous step while the next one is still pending", () => {
    const run = withChildren(
      makeRun({
        status: "running",
        currentStepIndex: 1,
        stepStatuses: ["completed", "pending", "pending"],
      }),
      ["thread-plan"],
    );
    expect(pipelineFeedingStep(run)).toEqual({
      index: 0,
      name: "Plan",
      childThreadId: "thread-plan",
    });
  });

  it.each([
    [
      "the current step already runs",
      makeRun({
        status: "running",
        currentStepIndex: 1,
        stepStatuses: ["completed", "running", "pending"],
      }),
    ],
    [
      "the run is paused",
      makeRun({
        status: "paused",
        pauseReason: "awaiting_continue",
        currentStepIndex: 1,
        stepStatuses: ["completed", "pending", "pending"],
      }),
    ],
    [
      "the first step is pending",
      makeRun({
        status: "running",
        currentStepIndex: 0,
        stepStatuses: ["pending", "pending", "pending"],
      }),
    ],
  ])("is null when %s", (_name, run) => {
    expect(pipelineFeedingStep(withChildren(run, ["thread-plan", "thread-impl"]))).toBeNull();
  });

  it("is null when the previous step never launched a thread", () => {
    const run = withChildren(
      makeRun({
        status: "running",
        currentStepIndex: 1,
        stepStatuses: ["skipped", "pending", "pending"],
      }),
      [],
    );
    expect(pipelineFeedingStep(run)).toBeNull();
  });
});

describe("pipelineStepPosition", () => {
  const run = {
    definition: { name: "Review", steps: [{ name: "Plan" }, { name: "Build" }] },
    steps: [{ stepId: "a" }, { stepId: "b" }],
  } as unknown as PipelineRun;

  it("numbers a step from one, names it from the snapshot and titles its breadcrumb", () => {
    expect(pipelineStepPosition(run, "b")).toEqual({ number: 2, total: 2, name: "Build" });
    expect(pipelineStepBreadcrumbTitle(run, "b")).toBe("Pipeline: Review · step 2/2");
  });

  it("is null for a step the run does not have", () => {
    expect(pipelineStepPosition(run, "missing")).toBeNull();
    expect(pipelineStepBreadcrumbTitle(run, "missing")).toBe("Pipeline: Review");
  });
});
