import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

/** The shell fields pipeline nesting reads; `EnvironmentThreadShell` satisfies it. */
export interface PipelineNestable {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly createdAt: string;
  readonly pipeline?: { readonly runId: string; readonly stepId: string | null } | null | undefined;
}

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

/**
 * Whether a pipeline's group is active for shelf placement: the parent or any
 * of its steps is, by the predicate the shelf already uses. A parent with no
 * active step is placed as itself.
 */
export function isPipelineGroupActive<T extends PipelineNestable>(
  parent: T,
  stepsOfParent: ReadonlyMap<string, readonly T[]>,
  isActive: (shell: T) => boolean,
): boolean {
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

const URGENT_STEP_STATUSES = ["approval", "input", "request", "working"] as const;
export type PipelineStepStatus = (typeof URGENT_STEP_STATUSES)[number];

/** The most urgent status among a pipeline's steps (needs you before running), or null. */
export function aggregatePipelineStepStatus(statuses: Iterable<string>): PipelineStepStatus | null {
  const seen = new Set(statuses);
  return URGENT_STEP_STATUSES.find((status) => seen.has(status)) ?? null;
}

/** A parent shows its steps' status unless it has a busy or failed one of its own. */
export function mergePipelineParentStatus<S extends string>(
  own: S,
  stepStatus: PipelineStepStatus | null,
): S | PipelineStepStatus {
  return stepStatus !== null && (own === "ready" || own === "waiting") ? stepStatus : own;
}
