import type {
  WorkflowQuestion,
  WorkflowRun,
  WorkflowStep,
  WorkflowSummary,
} from "@t3tools/contracts";

export interface WorkflowQuestionView {
  readonly title: string;
  readonly choices: ReadonlyArray<string>;
  readonly body: string | null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/**
 * What a question shows. `request` is whatever the workflow handed `ask`, so a part that is
 * missing or of another shape is left out instead of failing the whole list.
 */
export function readWorkflowQuestion(question: WorkflowQuestion): WorkflowQuestionView {
  const title = field(question.request, "title");
  const choices = field(question.request, "choices");
  const body = field(field(question.request, "data"), "body");
  return {
    title: typeof title === "string" && title.trim() !== "" ? title : question.name,
    choices: Array.isArray(choices)
      ? choices.filter((choice): choice is string => typeof choice === "string")
      : [],
    body: typeof body === "string" && body.trim() !== "" ? body : null,
  };
}

export interface WorkflowRunNode {
  readonly run: WorkflowRun;
  /** The runs it invoked, in the order they started. */
  readonly children: ReadonlyArray<WorkflowRunNode>;
  /** Questions open on this run. */
  readonly questions: ReadonlyArray<WorkflowQuestion>;
}

/** One workflow and the runs of it that nobody has to act on. */
export interface WorkflowSection {
  readonly name: string;
  /** What starts it, in words. Null for a workflow this server no longer has registered. */
  readonly triggers: ReadonlyArray<string> | null;
  readonly active: ReadonlyArray<WorkflowRunNode>;
  readonly finished: ReadonlyArray<WorkflowRunNode>;
  /** It has runs, and every one was invoked by a run of another workflow. */
  readonly invokedOnly: boolean;
  /** It has never run here, as far as the list goes back. */
  readonly neverRan: boolean;
}

export interface WorkflowRunGroups {
  /** Runs a person has to act on: one has a question open or is paused, itself or below it. */
  readonly needsYou: ReadonlyArray<WorkflowRunNode>;
  /** Every workflow there is, busiest first, each with its other runs. */
  readonly workflows: ReadonlyArray<WorkflowSection>;
}

const needsPerson = (node: WorkflowRunNode): boolean =>
  node.questions.length > 0 || node.run.status === "paused" || node.children.some(needsPerson);

/**
 * The list a person reads: what waits on them first, then each workflow with its runs. A run
 * that another invoked sits under that one, so a piece of work is one entry, and a workflow that
 * has not run yet is still listed, since the list is also how one learns what exists. `runs` is
 * newest first and that order is kept.
 */
export function groupWorkflowRuns(
  workflows: ReadonlyArray<WorkflowSummary>,
  runs: ReadonlyArray<WorkflowRun>,
  questions: ReadonlyArray<WorkflowQuestion>,
): WorkflowRunGroups {
  const listed = new Set(runs.map((run) => run.runId));
  const childrenOf = new Map<string, WorkflowRun[]>();
  const roots: WorkflowRun[] = [];
  for (const run of runs) {
    if (run.parentRunId === null || !listed.has(run.parentRunId)) {
      roots.push(run);
      continue;
    }
    const siblings = childrenOf.get(run.parentRunId);
    if (siblings) siblings.push(run);
    else childrenOf.set(run.parentRunId, [run]);
  }
  const node = (run: WorkflowRun): WorkflowRunNode => ({
    run,
    questions: questions.filter((question) => question.runId === run.runId),
    children: (childrenOf.get(run.runId) ?? [])
      .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(node),
  });
  const needsYou: WorkflowRunNode[] = [];
  const sections = new Map<string, { active: WorkflowRunNode[]; finished: WorkflowRunNode[] }>();
  const sectionOf = (name: string) => {
    const known = sections.get(name);
    if (known) return known;
    const made = { active: [], finished: [] };
    sections.set(name, made);
    return made;
  };
  for (const root of roots.map(node)) {
    if (needsPerson(root)) needsYou.push(root);
    else if (root.run.endedAt === null) sectionOf(root.run.workflow).active.push(root);
    else sectionOf(root.run.workflow).finished.push(root);
  }
  const registered = new Map(workflows.map((workflow) => [workflow.name, workflow] as const));
  const hasRuns = new Set(runs.map((run) => run.workflow));
  const hasRootRuns = new Set(roots.map((run) => run.workflow));
  const names = [...new Set([...sections.keys(), ...registered.keys(), ...hasRuns])];
  const rank = (name: string) => {
    const section = sections.get(name);
    if (section !== undefined && section.active.length > 0) return 0;
    return section !== undefined && section.finished.length > 0 ? 1 : 2;
  };
  return {
    needsYou,
    workflows: names
      .map((name) => ({
        name,
        triggers: registered.get(name)?.triggers ?? null,
        active: sections.get(name)?.active ?? [],
        finished: sections.get(name)?.finished ?? [],
        invokedOnly: hasRuns.has(name) && !hasRootRuns.has(name),
        neverRan: !hasRuns.has(name),
      }))
      .toSorted(
        (left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name),
      ),
  };
}

/** Every run of these, parents before the runs they invoked. */
function flattenWorkflowRunNodes(
  nodes: ReadonlyArray<WorkflowRunNode>,
): ReadonlyArray<WorkflowRunNode> {
  return nodes.flatMap((node) => [node, ...flattenWorkflowRunNodes(node.children)]);
}

/** Every run in the list, in the order it is listed. */
export function allWorkflowRunNodes(groups: WorkflowRunGroups): ReadonlyArray<WorkflowRunNode> {
  return flattenWorkflowRunNodes([
    ...groups.needsYou,
    ...groups.workflows.flatMap((section) => [...section.active, ...section.finished]),
  ]);
}

/** The run to show when none was picked: the first that waits on a person, else one under way. */
export function defaultWorkflowRunId(groups: WorkflowRunGroups): string | null {
  const waiting = flattenWorkflowRunNodes(groups.needsYou).find(
    (node) => node.questions.length > 0 || node.run.status === "paused",
  );
  const rest = groups.workflows;
  return (
    waiting?.run.runId ??
    rest.find((section) => section.active.length > 0)?.active[0]?.run.runId ??
    rest
      .flatMap((section) => section.finished)
      .toSorted((left, right) => right.run.updatedAt.localeCompare(left.run.updatedAt))[0]?.run
      .runId ??
    null
  );
}

/** What starts a workflow, as the line under its name. */
export function workflowTriggerLine(section: WorkflowSection): string {
  if (section.triggers === null) return "No longer registered on this server";
  if (section.invokedOnly) return "Runs as part of other workflows";
  return section.triggers.length === 0
    ? "Started by hand"
    : `Starts on ${section.triggers.join(", ")}`;
}

/** What a run is doing right now, in a few words, for its line in the list. */
export function workflowRunActivity(
  run: Pick<WorkflowRun, "status" | "detail">,
  questions: number,
): string | null {
  const detail = run.detail?.trim() ?? "";
  if (questions > 0)
    return questions === 1 ? "Asks you a question" : `Asks you ${questions} questions`;
  switch (run.status) {
    case "paused":
      return detail === "" ? "A step failed" : detail;
    case "waiting":
      if (detail.startsWith("agent ")) return `Agent working on ${detail.slice(6)}`;
      if (detail.startsWith("sleep ")) return "Sleeping";
      return detail === "" ? "Waiting" : `Waiting for ${detail}`;
    case "running":
      return "Running";
    case "completed":
      return null;
    case "stopped":
    case "cancelled":
      return detail === "" ? null : detail;
  }
}

export function workflowRunStatusVariant(status: WorkflowRun["status"]) {
  switch (status) {
    case "running":
      return "info";
    case "waiting":
      return "warning";
    case "paused":
      return "error";
    case "completed":
      return "success";
    case "stopped":
      return "outline";
    case "cancelled":
      return "secondary";
  }
}

/** A run's result as lines a person can read: a sentence, or the fields of an object. */
export function workflowResultLines(
  result: WorkflowRun["result"],
): ReadonlyArray<{ readonly label: string | null; readonly value: string }> {
  if (result === null) return [];
  if (typeof result !== "object") return [{ label: null, value: String(result) }];
  if (Array.isArray(result)) return [{ label: null, value: JSON.stringify(result) }];
  return Object.entries(result).map(([label, value]) => ({
    label,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

// A step this short is bookkeeping between the parts of a run that take time.
const QUICK_STEP_MS = 1_000;

export interface WorkflowBeat {
  readonly kind: WorkflowStep["kind"] | "run";
  readonly name: string;
  readonly status: WorkflowStep["status"];
  readonly attempts: number;
  /** A failure's reason, or when a sleep wakes. */
  readonly detail: string | null;
  /** What it produced: a value, an agent's data or reply, the answer to a question. */
  readonly result: WorkflowStep["result"];
  readonly startMs: number;
  /** When it ended, or `nowMs` while it is under way. */
  readonly endMs: number;
  readonly thread: { readonly threadId: string; readonly environmentId: string | null } | null;
  /** The run this step invoked and waited for. */
  readonly childRun: WorkflowRun | null;
  /** Another beat was under way at the same time. */
  readonly parallel: boolean;
}

export interface WorkflowQuickSteps {
  readonly kind: "quick";
  readonly steps: ReadonlyArray<WorkflowStep>;
  readonly startMs: number;
  readonly endMs: number;
}

export type WorkflowTimelineRow = WorkflowBeat | WorkflowQuickSteps;

export interface WorkflowTimeline {
  readonly rows: ReadonlyArray<WorkflowTimelineRow>;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A run's steps as the story of the run: what took time or involved someone is a beat, and the
 * quick steps between two beats fold into one row, since a journal of them hides where the run
 * is. An invoked run takes the place of the two steps that started and awaited it.
 */
export function buildWorkflowTimeline(input: {
  readonly run: Pick<WorkflowRun, "runId" | "startedAt" | "endedAt">;
  readonly steps: ReadonlyArray<WorkflowStep>;
  readonly children: ReadonlyArray<WorkflowRun>;
  readonly nowMs: number;
}): WorkflowTimeline {
  const childByStep = new Map(
    input.children
      .filter((child) => child.parentRunId === input.run.runId && child.parentStep !== null)
      .map((child) => [child.parentStep, child] as const),
  );
  const startMs = Date.parse(input.run.startedAt);
  const endMs = input.run.endedAt === null ? input.nowMs : Date.parse(input.run.endedAt);
  const rows: WorkflowTimelineRow[] = [];
  const beats: WorkflowBeat[] = [];
  let quick: WorkflowStep[] = [];
  const flush = () => {
    if (quick.length === 0) return;
    rows.push({
      kind: "quick",
      steps: quick,
      startMs: Date.parse(quick[0]!.startedAt),
      endMs: Date.parse(quick.at(-1)!.endedAt ?? quick.at(-1)!.startedAt),
    });
    quick = [];
  };
  for (const step of input.steps) {
    // The step that started an invoked run is told by the wait that follows it.
    if (step.kind === "step" && step.name.endsWith("/start")) {
      if (childByStep.has(step.name.slice(0, -"/start".length))) continue;
    }
    const stepStart = Date.parse(step.startedAt);
    const stepEnd = step.endedAt === null ? input.nowMs : Date.parse(step.endedAt);
    const childRun = step.kind === "wait" ? (childByStep.get(step.name) ?? null) : null;
    const isBeat =
      step.kind !== "step" ||
      step.status !== "completed" ||
      step.attempts > 1 ||
      stepEnd - stepStart >= QUICK_STEP_MS;
    if (!isBeat) {
      quick.push(step);
      continue;
    }
    flush();
    const beat: WorkflowBeat = {
      kind: childRun === null ? step.kind : "run",
      name: step.name,
      status: step.status,
      attempts: step.attempts,
      detail: step.detail,
      result: step.result,
      startMs: stepStart,
      endMs: Math.max(stepStart, stepEnd),
      thread:
        step.threadId === null
          ? null
          : { threadId: step.threadId, environmentId: step.environmentId },
      childRun,
      parallel: false,
    };
    beats.push(beat);
    rows.push(beat);
  }
  flush();
  const overlaps = (left: WorkflowBeat, right: WorkflowBeat) =>
    left !== right && left.startMs < right.endMs && right.startMs < left.endMs;
  return {
    rows: rows.map((row) =>
      row.kind === "quick"
        ? row
        : { ...row, parallel: beats.some((other) => overlaps(row, other)) },
    ),
    startMs,
    endMs: Math.max(endMs, ...beats.map((beat) => beat.endMs), startMs + 1),
  };
}

/** Where a beat sits in its run, as fractions of the run's length, for its bar. */
export function workflowBeatSpan(
  timeline: Pick<WorkflowTimeline, "startMs" | "endMs">,
  beat: Pick<WorkflowBeat, "startMs" | "endMs">,
): { readonly offset: number; readonly length: number } {
  const span = Math.max(1, timeline.endMs - timeline.startMs);
  const offset = Math.min(1, Math.max(0, (beat.startMs - timeline.startMs) / span));
  // A sliver stays visible: a beat that took a moment of a long run still happened.
  const length = Math.min(1 - offset, Math.max(0.01, (beat.endMs - beat.startMs) / span));
  return { offset, length };
}

/** What a person answered a question with, when a step's result is such an answer. */
export function workflowAnswer(
  result: WorkflowStep["result"],
): { readonly choice: string; readonly reason: string | null } | null {
  const choice = field(result, "choice");
  const reason = field(result, "reason");
  return typeof choice === "string"
    ? { choice, reason: typeof reason === "string" && reason.trim() !== "" ? reason : null }
    : null;
}
