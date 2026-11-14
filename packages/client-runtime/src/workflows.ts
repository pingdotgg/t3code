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
      .slice()
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
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
      .slice()
      .sort(
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
      .slice()
      .sort((left, right) => right.run.updatedAt.localeCompare(left.run.updatedAt))[0]?.run.runId ??
    null
  );
}

/** What starts a workflow, in words. */
export function workflowTriggerLine(section: WorkflowSection): string {
  if (section.triggers === null) return "No longer registered on this server";
  if (section.invokedOnly) return "Runs as part of other workflows";
  return section.triggers.length === 0
    ? "Started by hand"
    : `Starts on ${section.triggers.join(", ")}`;
}

export type WorkflowListTab = "needs-you" | "running" | "all";

/**
 * The three lists a person switches between. Each is whole pieces of work, newest change first: a
 * run that another invoked is reached through that one.
 */
export function workflowRunLists(
  groups: WorkflowRunGroups,
): Readonly<Record<WorkflowListTab, ReadonlyArray<WorkflowRunNode>>> {
  const byChange = (nodes: ReadonlyArray<WorkflowRunNode>) =>
    [...nodes].sort((left, right) => right.run.updatedAt.localeCompare(left.run.updatedAt));
  const running = groups.workflows.flatMap((section) => section.active);
  const finished = groups.workflows.flatMap((section) => section.finished);
  return {
    "needs-you": byChange(groups.needsYou),
    running: byChange(running),
    all: [...byChange(groups.needsYou), ...byChange(running), ...byChange(finished)],
  };
}

/** The list to open on: what waits on a person, else what is under way, else everything. */
export function defaultWorkflowListTab(groups: WorkflowRunGroups): WorkflowListTab {
  if (groups.needsYou.length > 0) return "needs-you";
  return groups.workflows.some((section) => section.active.length > 0) ? "running" : "all";
}

const CHIP_TONES = 5;

/** A workflow's mark in the list: two letters and one of a few colours, the same every time. */
export function workflowChip(name: string): { readonly letters: string; readonly tone: number } {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter((part) => part !== "");
  const letters =
    parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? name).slice(0, 2);
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 9973;
  return { letters: letters.toUpperCase(), tone: hash % CHIP_TONES };
}

export type WorkflowRunTone = "input" | "failed" | "working" | "quiet" | "done";

/** A run's state as the one word the thread list would use for it. */
export function workflowRunState(node: WorkflowRunNode): {
  readonly word: string;
  readonly tone: WorkflowRunTone;
} {
  const { run } = node;
  if (node.questions.length > 0) return { word: "Input", tone: "input" };
  switch (run.status) {
    case "paused":
      return { word: "Paused", tone: "failed" };
    case "running":
      return { word: "Working", tone: "working" };
    case "waiting": {
      const detail = run.detail ?? "";
      if (detail.startsWith("agent ")) return { word: "Working", tone: "working" };
      if (detail.startsWith("sleep ")) return { word: "Sleeping", tone: "quiet" };
      // Something below it holds it up; say that, not that it idles.
      if (node.children.some(needsPerson)) return { word: "Input", tone: "input" };
      return { word: "Waiting", tone: "quiet" };
    }
    case "completed":
      return { word: "Done", tone: "done" };
    case "stopped":
      return { word: "Stopped", tone: "quiet" };
    case "cancelled":
      return { word: "Cancelled", tone: "quiet" };
  }
}

const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.trim();

/** What a run is at right now, as the line under its title. */
export function workflowRunNow(node: WorkflowRunNode): string {
  const { run } = node;
  const detail = run.detail?.trim() ?? "";
  const asked = node.questions[0];
  if (asked !== undefined) {
    const more = node.questions.length - 1;
    return `Asks: ${readWorkflowQuestion(asked).title}${more > 0 ? ` and ${more} more` : ""}`;
  }
  const below = flattenWorkflowRunNodes(node.children);
  const holding = below.find(
    (child) => child.questions.length > 0 || child.run.status === "paused",
  );
  switch (run.status) {
    case "paused":
      return detail === "" ? "A step failed" : firstLine(detail);
    case "running":
      return "Running its own steps";
    case "waiting":
      if (holding !== undefined) return `${holding.run.title}: ${workflowRunNow(holding)}`;
      if (detail.startsWith("agent ")) return `${detail.slice(6)} is working`;
      if (detail.startsWith("sleep ")) return `Sleeping at ${detail.slice(6)}`;
      if (below.some((child) => child.run.endedAt === null)) {
        const open = below.filter((child) => child.run.endedAt === null);
        return open.length === 1 ? `Runs ${open[0]!.run.title}` : `${open.length} runs under way`;
      }
      return detail === "" ? "Waiting" : `Waiting for ${detail}`;
    case "completed": {
      const line = workflowResultLines(run.result)[0];
      if (line === undefined) return "Finished";
      return firstLine(line.label === null ? line.value : `${line.label}: ${line.value}`);
    }
    case "stopped":
    case "cancelled":
      return detail === "" ? "Ended early" : firstLine(detail);
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
  /** What an agent said in closing, when its result is data. */
  readonly said: string | null;
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
      said: step.said,
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

/** Steps that were under way at the same time, shown side by side. */
export interface WorkflowTogether {
  readonly kind: "together";
  readonly beats: ReadonlyArray<WorkflowBeat>;
}

export type WorkflowFeedRow = WorkflowTimelineRow | WorkflowTogether;

/**
 * The timeline as it is read: beats that overlapped become one row, so two reviewers at once look
 * like two reviewers at once and not like one after the other.
 */
export function buildWorkflowFeed(timeline: WorkflowTimeline): ReadonlyArray<WorkflowFeedRow> {
  const rows: WorkflowFeedRow[] = [];
  let together: WorkflowBeat[] = [];
  let until = 0;
  const flush = () => {
    if (together.length === 1) rows.push(together[0]!);
    else if (together.length > 1) rows.push({ kind: "together", beats: together });
    together = [];
  };
  for (const row of timeline.rows) {
    if (row.kind === "quick") {
      flush();
      rows.push(row);
      continue;
    }
    if (together.length > 0 && row.parallel && row.startMs < until) {
      together.push(row);
      until = Math.max(until, row.endMs);
      continue;
    }
    flush();
    together = [row];
    until = row.endMs;
  }
  flush();
  return rows;
}

export interface WorkflowPathNode {
  readonly key: string;
  readonly label: string;
  readonly status: "done" | "current" | "failed";
}

/** Where the run has been and where it is: one stop per beat, in order. Nothing is predicted. */
export function workflowPath(
  rows: ReadonlyArray<WorkflowFeedRow>,
): ReadonlyArray<WorkflowPathNode> {
  const statusOf = (beats: ReadonlyArray<WorkflowBeat>): WorkflowPathNode["status"] =>
    beats.some((beat) => beat.status === "failed")
      ? "failed"
      : beats.some((beat) => beat.status === "running")
        ? "current"
        : "done";
  return rows.flatMap((row): ReadonlyArray<WorkflowPathNode> => {
    if (row.kind === "quick") return [];
    if (row.kind !== "together") {
      return [{ key: row.name, label: row.name, status: statusOf([row]) }];
    }
    return [
      {
        key: row.beats[0]!.name,
        label:
          row.beats.length === 2
            ? `${row.beats[0]!.name} + ${row.beats[1]!.name}`
            : `${row.beats.length} at once`,
        status: statusOf(row.beats),
      },
    ];
  });
}

const FACT_LENGTH = 48;
const FACTS_SHOWN = 6;
// A string this long is the agent talking, not a fact about its work.
const PROSE_LENGTH = 80;

const words = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

function factValue(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const text = value.trim();
    return text !== "" && text.length <= FACT_LENGTH && !text.includes("\n") ? text : null;
  }
  if (Array.isArray(value) && value.length > 0 && value.length <= 4) {
    const parts = value.map(factValue);
    const joined = parts.join(", ");
    return parts.every((part) => part !== null) && joined.length <= FACT_LENGTH ? joined : null;
  }
  return null;
}

/**
 * What an agent step has to say for itself: its words, and the short facts of its result. With no
 * closing words kept, the longest piece of prose in the result stands in for them.
 */
export function workflowAgentSummary(beat: Pick<WorkflowBeat, "result" | "said">): {
  readonly said: string | null;
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
} {
  const { result } = beat;
  const kept = beat.said?.trim() ?? "";
  if (typeof result === "string") {
    return { said: kept !== "" ? kept : result.trim() === "" ? null : result.trim(), facts: [] };
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { said: kept === "" ? null : kept, facts: [] };
  }
  const entries = Object.entries(result);
  const prose =
    kept !== ""
      ? null
      : (entries
          .filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && entry[1].trim().length >= PROSE_LENGTH,
          )
          .slice()
          .sort((left, right) => right[1].length - left[1].length)[0] ?? null);
  return {
    said: kept !== "" ? kept : (prose?.[1].trim() ?? null),
    facts: entries
      .flatMap(([key, value]) => {
        const text = factValue(value);
        return text === null ? [] : [{ label: words(key), value: text }];
      })
      .slice(0, FACTS_SHOWN),
  };
}

/**
 * The start of what an agent said, cut where a paragraph ends so no markup is left half open.
 * Null when all of it fits.
 */
export function workflowSaidStart(said: string, limit: number): string | null {
  if (said.length <= limit) return null;
  const paragraphs = said.split(/\n{2,}/);
  let kept = paragraphs[0]!;
  for (const paragraph of paragraphs.slice(1)) {
    if (kept.length + paragraph.length + 2 > limit) break;
    kept = `${kept}\n\n${paragraph}`;
  }
  // One paragraph that runs on is cut at a word, which can still split markup but not a word.
  if (kept.length > limit * 2) kept = `${kept.slice(0, kept.lastIndexOf(" ", limit))}…`;
  return kept === said ? null : kept;
}
