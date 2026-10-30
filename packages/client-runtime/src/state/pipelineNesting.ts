import type { EnvironmentId, PipelineRunSummary, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

/** The shell fields pipeline nesting reads; `EnvironmentThreadShell` satisfies it. */
export interface PipelineNestable {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly createdAt: string;
  readonly pipeline?: { readonly runId: string; readonly stepId: string | null } | null | undefined;
}

/** Running and paused runs by `environmentId:runId`, from the environments' live-run streams. */
export type PipelineLiveRuns = ReadonlyMap<string, PipelineRunSummary>;

export interface PipelineNesting<T> {
  /** The list's top-level rows in display order; a pipeline's steps are not repeated here. */
  readonly rows: readonly T[];
  /** Steps by their parent's `scopedThreadKey`, in step order. Only parents in the list appear. */
  readonly stepsByParentKey: ReadonlyMap<string, readonly T[]>;
}

const NESTED_STEP_SEPARATOR = " · ";

function shellKey(shell: PipelineNestable): string {
  return scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));
}

function runKey(environmentId: EnvironmentId, runId: string): string {
  return `${environmentId}:${runId}`;
}

/**
 * The parent shell of every step whose parent is in `shells`, by the step's
 * `scopedThreadKey`. A step whose parent is not in the list is absent, so it
 * stays a top-level row and is never out of reach.
 */
export function pipelineParentsOfSteps<T extends PipelineNestable>(
  shells: readonly T[],
): ReadonlyMap<string, T> {
  const parents = new Map<string, T>();
  for (const shell of shells) {
    if (shell.pipeline != null && shell.pipeline.stepId === null) {
      const key = runKey(shell.environmentId, shell.pipeline.runId);
      if (!parents.has(key)) parents.set(key, shell);
    }
  }
  const parentBySteps = new Map<string, T>();
  if (parents.size === 0) return parentBySteps;
  for (const shell of shells) {
    if (shell.pipeline == null || shell.pipeline.stepId === null) continue;
    const parent = parents.get(runKey(shell.environmentId, shell.pipeline.runId));
    if (parent !== undefined) parentBySteps.set(shellKey(shell), parent);
  }
  return parentBySteps;
}

/** The steps of each parent in `shells`, by the parent's `scopedThreadKey`; `parentOfStep` is `pipelineParentsOfSteps(shells)`. */
export function pipelineStepsOfParents<T extends PipelineNestable>(
  shells: readonly T[],
  parentOfStep: ReadonlyMap<string, T>,
): ReadonlyMap<string, readonly T[]> {
  const stepsOfParent = new Map<string, T[]>();
  if (parentOfStep.size === 0) return stepsOfParent;
  for (const shell of shells) {
    const parent = parentOfStep.get(shellKey(shell));
    if (parent === undefined) continue;
    const parentKey = shellKey(parent);
    const steps = stepsOfParent.get(parentKey);
    if (steps === undefined) stepsOfParent.set(parentKey, [shell]);
    else steps.push(shell);
  }
  return stepsOfParent;
}

export function indexPipelineLiveRuns(
  environments: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly runs: ReadonlyArray<PipelineRunSummary>;
  }>,
): PipelineLiveRuns {
  const index = new Map<string, PipelineRunSummary>();
  for (const { environmentId, runs } of environments) {
    for (const run of runs) index.set(runKey(environmentId, run.id), run);
  }
  return index;
}

/** The live run a parent or step thread belongs to; undefined for a run that is over or unknown. */
export function livePipelineRunOf(
  runs: PipelineLiveRuns | undefined,
  shell: PipelineNestable,
): PipelineRunSummary | undefined {
  return shell.pipeline == null
    ? undefined
    : runs?.get(runKey(shell.environmentId, shell.pipeline.runId));
}

/**
 * Whether a pipeline's group is active for shelf placement: the parent or any
 * of its steps is, by the predicate the shelf already uses. A parent with no
 * active step is placed as itself. A paused run waits on the user, so like any
 * thread needing input it is never active.
 */
export function isPipelineGroupActive<T extends PipelineNestable>(
  parent: T,
  stepsOfParent: ReadonlyMap<string, readonly T[]>,
  isActive: (shell: T) => boolean,
  liveRuns?: PipelineLiveRuns,
): boolean {
  if (livePipelineRunOf(liveRuns, parent)?.status === "paused") return false;
  return (
    isActive(parent) ||
    (stepsOfParent.get(shellKey(parent))?.some((step) => isActive(step)) ?? false)
  );
}

function timestampMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Nests steps under their run's parent in a list already in display order. A
 * run sits where the first of its parent or steps sits, so a fresh step keeps
 * its pipeline high. `anchored` parents (hand-placed) keep their own position.
 */
export function nestPipelineSteps<T extends PipelineNestable>(
  shells: readonly T[],
  options?: { readonly anchored?: (parent: T) => boolean },
): PipelineNesting<T> {
  const parentOfStep = pipelineParentsOfSteps(shells);
  if (parentOfStep.size === 0) return { rows: shells, stepsByParentKey: new Map() };

  const indexByKey = new Map<string, number>();
  shells.forEach((shell, index) => indexByKey.set(shellKey(shell), index));

  const stepsByParentKey = new Map<string, T[]>();
  const slotByParentKey = new Map<string, number>();
  for (const shell of shells) {
    const parent = parentOfStep.get(shellKey(shell));
    if (parent === undefined) continue;
    const parentKey = shellKey(parent);
    const steps = stepsByParentKey.get(parentKey) ?? [];
    steps.push(shell);
    stepsByParentKey.set(parentKey, steps);
  }
  for (const [parentKey, steps] of stepsByParentKey) {
    steps.sort(
      (left, right) =>
        timestampMs(left.createdAt) - timestampMs(right.createdAt) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    const parent = shells[indexByKey.get(parentKey)!]!;
    const parentIndex = indexByKey.get(parentKey)!;
    slotByParentKey.set(
      parentKey,
      options?.anchored?.(parent) === true
        ? parentIndex
        : Math.min(parentIndex, ...steps.map((step) => indexByKey.get(shellKey(step))!)),
    );
  }

  const rows: T[] = [];
  shells.forEach((shell, index) => {
    const key = shellKey(shell);
    if (parentOfStep.has(key)) {
      // A step stands in for its run when it sits earlier than the parent.
      const parentKey = shellKey(parentOfStep.get(key)!);
      if (slotByParentKey.get(parentKey) === index) rows.push(shells[indexByKey.get(parentKey)!]!);
      return;
    }
    if (!stepsByParentKey.has(key) || slotByParentKey.get(key) === index) rows.push(shell);
  });
  return { rows, stepsByParentKey };
}

/**
 * A step's title under its parent. Server titles read "<Pipeline> · <Step>"
 * (plus " (attempt n)" on retries); the parent row already names the pipeline,
 * so the part after the first separator is shown. Other titles show whole.
 */
export function nestedPipelineStepLabel(title: string): string {
  const separatorIndex = title.indexOf(NESTED_STEP_SEPARATOR);
  if (separatorIndex < 0) return title;
  const label = title.slice(separatorIndex + NESTED_STEP_SEPARATOR.length).trim();
  return label === "" ? title : label;
}

/** A step's label under its parent: its name in the live run, else its title as `nestedPipelineStepLabel` reads it. */
export function pipelineStepLabel(
  runs: PipelineLiveRuns | undefined,
  step: PipelineNestable & { readonly title: string },
): string {
  const stepId = step.pipeline?.stepId;
  const name = livePipelineRunOf(runs, step)?.steps.find((entry) => entry.stepId === stepId)?.name;
  return name === undefined || name === "" ? nestedPipelineStepLabel(step.title) : name;
}

const URGENT_STEP_STATUSES = ["approval", "input", "request", "working"] as const;
export type PipelineStepStatus = (typeof URGENT_STEP_STATUSES)[number];

/**
 * The most urgent status among a pipeline's steps (needs you before running), or null. A paused
 * run counts as `input`: it waits on Continue, or on a failed or stopped step.
 */
export function aggregatePipelineStepStatus(
  statuses: Iterable<string>,
  run?: Pick<PipelineRunSummary, "status"> | null,
): PipelineStepStatus | null {
  const seen = new Set(statuses);
  if (run?.status === "paused") seen.add("input");
  return URGENT_STEP_STATUSES.find((status) => seen.has(status)) ?? null;
}

/** A parent shows its steps' status unless it has a busy or failed one of its own. */
export function mergePipelineParentStatus<S extends string>(
  own: S,
  stepStatus: PipelineStepStatus | null,
): S | PipelineStepStatus {
  return stepStatus !== null && (own === "ready" || own === "waiting") ? stepStatus : own;
}

/** A segment's colour in a pipeline's collapsed progress bar. */
export type PipelineProgressStatus =
  | "completed"
  | "running"
  | "attention"
  | "failed"
  | "stopped"
  | "skipped"
  | "pending";

export interface PipelineProgressSegment<T> {
  readonly stepId: string;
  readonly label: string;
  readonly status: PipelineProgressStatus;
  /** The step's latest thread, null for a step that has not started. */
  readonly thread: T | null;
}

const ATTENTION_THREAD_STATUSES: ReadonlySet<string> = new Set(["approval", "input", "request"]);

function finishedRunStepStatus(threadStatus: string): PipelineProgressStatus {
  if (ATTENTION_THREAD_STATUSES.has(threadStatus)) return "attention";
  if (threadStatus === "working") return "running";
  if (threadStatus === "failed" || threadStatus === "limited") return "failed";
  return "completed";
}

/**
 * One segment per step of a pipeline, in run order. A live run lists every
 * defined step, started or not. A run that is over has left the live stream,
 * so its steps come from their threads, one per step with its latest attempt.
 * A step thread waiting on the user shows as `attention` either way.
 */
export function pipelineProgressSegments<T extends PipelineNestable & { readonly title: string }>(
  run: PipelineRunSummary | undefined,
  steps: readonly T[],
  threadStatus: (step: T) => string,
): readonly PipelineProgressSegment<T>[] {
  // Steps arrive oldest first, so the last thread per step is its latest attempt.
  const latestByStepId = new Map<string, T>();
  for (const step of steps) {
    if (step.pipeline?.stepId != null) latestByStepId.set(step.pipeline.stepId, step);
  }
  if (run === undefined) {
    return [...latestByStepId].map(([stepId, thread]) => ({
      stepId,
      label: nestedPipelineStepLabel(thread.title),
      status: finishedRunStepStatus(threadStatus(thread)),
      thread,
    }));
  }
  return run.steps.map((entry, index) => {
    const thread =
      steps.find((step) => step.id === entry.childThreadId) ??
      latestByStepId.get(entry.stepId) ??
      null;
    // A paused run waits on the user at its current step: Continue before it, or its handoff.
    const awaitsUser =
      (run.status === "paused" && index === run.currentStepIndex) ||
      (thread !== null && ATTENTION_THREAD_STATUSES.has(threadStatus(thread)));
    const status: PipelineProgressStatus =
      entry.status === "stopped" || entry.status === "cancelled" ? "stopped" : entry.status;
    return {
      stepId: entry.stepId,
      label:
        entry.name === ""
          ? thread
            ? nestedPipelineStepLabel(thread.title)
            : entry.stepId
          : entry.name,
      status: (status === "running" || status === "pending") && awaitsUser ? "attention" : status,
      thread,
    };
  });
}

/** Steps that are done for a progress count: completed or skipped. */
export function countFinishedPipelineSegments(
  segments: ReadonlyArray<{ readonly status: PipelineProgressStatus }>,
): number {
  return segments.filter(
    (segment) => segment.status === "completed" || segment.status === "skipped",
  ).length;
}
