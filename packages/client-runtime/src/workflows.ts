import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import {
  type IssueRef,
  type PullRequestRef,
  WorkflowIssueAddress,
  WorkflowPullRequestAddress,
  WorkflowReferenceKind,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowRunReference,
  type WorkflowRunsSnapshot,
  type WorkflowRunSubject,
  type WorkflowStep,
  type WorkflowSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { parseUrl } from "@t3tools/shared/url";

export interface WorkflowQuestionChoice {
  readonly value: string;
  /** What picking it does. */
  readonly description: string | null;
  /** The server refuses it without a reason. */
  readonly requireReason: boolean;
}

export interface WorkflowQuestionLink {
  readonly label: string;
  readonly url: string;
}

export interface WorkflowQuestionView {
  readonly title: string;
  readonly choices: ReadonlyArray<WorkflowQuestionChoice>;
  readonly body: string | null;
  readonly links: ReadonlyArray<WorkflowQuestionLink>;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const isWebUrl = (url: string) => {
  const protocol = parseUrl(url)?.protocol;
  return protocol === "https:" || protocol === "http:";
};

/**
 * What a question shows. `request` is whatever the workflow handed `ask`, so a part that is
 * missing or of another shape is left out instead of failing the whole list.
 */
export function readWorkflowQuestion(question: WorkflowQuestion): WorkflowQuestionView {
  const choices = field(question.request, "choices");
  const details = field(question.request, "choiceDetails");
  const links = field(question.request, "links");
  const detailOf = (value: string) =>
    Array.isArray(details) ? details.find((detail) => field(detail, "value") === value) : undefined;
  return {
    title: text(field(question.request, "title")) ?? question.name,
    choices: Array.isArray(choices)
      ? choices
          .filter((choice): choice is string => typeof choice === "string")
          .map((value) => {
            const detail = detailOf(value);
            return {
              value,
              description: text(field(detail, "description")),
              requireReason: field(detail, "requireReason") === true,
            };
          })
      : [],
    body: text(field(field(question.request, "data"), "body")),
    links: Array.isArray(links)
      ? links.flatMap((link) => {
          const label = text(field(link, "label"));
          const url = field(link, "url");
          return label !== null && typeof url === "string" && isWebUrl(url) ? [{ label, url }] : [];
        })
      : [],
  };
}

/**
 * What a run's detail is read again on, out of the live list: the run's last change once it has
 * ended. Steps do not move a run's `updatedAt`, so one under way is read again on any change.
 */
export function workflowRunRefreshKey(
  snapshot: WorkflowRunsSnapshot | undefined,
  runId: string,
): unknown {
  const run = snapshot?.runs.find((candidate) => candidate.runId === runId);
  return run === undefined || run.endedAt === null ? snapshot : run.updatedAt;
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
/**
 * The runs a list shows: without those a workflow skipped as not its to do, unless asked for
 * them. A skipped run that another run invoked stays, as a step of that one.
 */
export function listedWorkflowRuns(
  runs: ReadonlyArray<WorkflowRun>,
  showSkipped: boolean,
): { readonly runs: ReadonlyArray<WorkflowRun>; readonly skipped: number } {
  const hidden = (run: WorkflowRun) => run.status === "skipped" && run.parentRunId === null;
  const skipped = runs.filter(hidden).length;
  return { runs: showSkipped ? runs : runs.filter((run) => !hidden(run)), skipped };
}

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
export function workflowTriggerLine(
  section: WorkflowSection,
  resolve: MFunctionType = mFallback,
): string {
  if (section.triggers === null) return resolve(msg("No longer registered on this server"));
  if (section.invokedOnly) return resolve(msg("Runs as part of other workflows"));
  return section.triggers.length === 0
    ? resolve(msg("Started by hand"))
    : resolve(msg("Starts on {triggers}", { triggers: section.triggers.join(", ") }));
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

/** Whether a run is of this workflow or invoked one, so a workflow that only runs inside others is found. */
export function workflowRunInvolves(node: WorkflowRunNode, workflow: string): boolean {
  return (
    node.run.workflow === workflow ||
    node.children.some((child) => workflowRunInvolves(child, workflow))
  );
}

/**
 * The filter value for the questions listed as Other: asked with no kind, or with one their
 * workflow does not declare. A workflow cannot declare a blank kind.
 */
export const WORKFLOW_OTHER_KIND = "";

export interface WorkflowQuestionKind {
  /** The kind as its workflow declares it, or `WORKFLOW_OTHER_KIND`. */
  readonly kind: string;
  /** What its workflow calls it. Null for Other, which the caller words. */
  readonly label: string | null;
  /** How many open questions in these runs are listed under it. */
  readonly count: number;
}

/**
 * The kind a question of this run is listed under: its own when the run's workflow declares it,
 * else `WORKFLOW_OTHER_KIND`. The question keeps the kind it was asked with either way.
 */
function workflowListedKind(
  workflows: ReadonlyArray<WorkflowSummary>,
  node: WorkflowRunNode,
  question: WorkflowQuestion,
): string {
  const declared = workflows.find((workflow) => workflow.name === node.run.workflow)?.asks ?? [];
  return question.kind !== undefined && declared.some(({ kind }) => kind === question.kind)
    ? question.kind
    : WORKFLOW_OTHER_KIND;
}

/** The first run among these, or the runs they invoked, that itself asks a question listed under this kind. */
export function workflowRunAskingKind(
  workflows: ReadonlyArray<WorkflowSummary>,
  nodes: ReadonlyArray<WorkflowRunNode>,
  kind: string,
): WorkflowRunNode | null {
  return (
    flattenWorkflowRunNodes(nodes).find((node) =>
      node.questions.some((question) => workflowListedKind(workflows, node, question) === kind),
    ) ?? null
  );
}

/**
 * The declared kinds of the open questions, in declared order, then Other. `sources` is one per
 * environment, counted together. `picked` stays listed at zero, so a filter with nothing left
 * can be undone. Empty when no question is of a declared kind and none is picked.
 */
export function workflowQuestionKinds(
  sources: ReadonlyArray<{
    readonly workflows: ReadonlyArray<WorkflowSummary>;
    readonly nodes: ReadonlyArray<WorkflowRunNode>;
  }>,
  picked: string | null = null,
): ReadonlyArray<WorkflowQuestionKind> {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const { workflows, nodes } of sources) {
    for (const node of flattenWorkflowRunNodes(nodes)) {
      for (const question of node.questions) {
        const kind = workflowListedKind(workflows, node, question);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    for (const workflow of workflows) {
      for (const { kind, label } of workflow.asks ?? []) {
        if (!labels.has(kind)) labels.set(kind, label);
      }
    }
  }
  if (picked !== null && !counts.has(picked)) counts.set(picked, 0);
  const other = counts.get(WORKFLOW_OTHER_KIND);
  counts.delete(WORKFLOW_OTHER_KIND);
  if (counts.size === 0 && picked === null) return [];
  const order = [...new Set([...labels.keys(), ...counts.keys()])];
  return [
    ...order.flatMap((kind) => {
      const count = counts.get(kind);
      return count === undefined ? [] : [{ kind, label: labels.get(kind) ?? kind, count }];
    }),
    ...(other === undefined ? [] : [{ kind: WORKFLOW_OTHER_KIND, label: null, count: other }]),
  ];
}

/** Whether a run, or one it invoked, has an open question listed under this kind. */
export function workflowRunAsksKind(
  workflows: ReadonlyArray<WorkflowSummary>,
  node: WorkflowRunNode,
  kind: string,
): boolean {
  return workflowRunAskingKind(workflows, [node], kind) !== null;
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
    parts.length > 1
      ? `${[...parts[0]!][0]}${[...parts[1]!][0]}`
      : [...(parts[0] ?? name)].slice(0, 2).join("");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 9973;
  return { letters: letters.toUpperCase(), tone: hash % CHIP_TONES };
}

export type WorkflowRunTone = "input" | "failed" | "working" | "quiet" | "done";

/** A run's state as the one word the thread list would use for it. */
export function workflowRunState(
  node: WorkflowRunNode,
  resolve: MFunctionType = mFallback,
): {
  readonly word: string;
  readonly tone: WorkflowRunTone;
} {
  const { run } = node;
  const input = {
    word: resolve(msg("Needs you", { $context: "workflow run status: it waits on a person" })),
    tone: "input",
  } as const;
  const working = {
    word: resolve(msg("Working", { $context: "workflow run status" })),
    tone: "working",
  } as const;
  if (node.questions.length > 0) return input;
  switch (run.status) {
    case "paused":
      return {
        word: resolve(msg("Paused", { $context: "workflow run status" })),
        tone: "failed",
      };
    case "running":
      return working;
    case "waiting": {
      const detail = run.detail ?? "";
      if (detail.startsWith("agent ")) return working;
      if (detail.startsWith("sleep ")) {
        return {
          word: resolve(msg("Sleeping", { $context: "workflow run status" })),
          tone: "quiet",
        };
      }
      if (detail.startsWith("queue ")) {
        return {
          word: resolve(
            msg("Queued", { $context: "workflow run status: it waits for a free place" }),
          ),
          tone: "quiet",
        };
      }
      // Something below it holds it up; say that, not that it idles.
      if (node.children.some(needsPerson)) return input;
      return { word: resolve(msg("Waiting", { $context: "workflow run status" })), tone: "quiet" };
    }
    case "completed":
      return { word: resolve(msg("Done", { $context: "workflow run status" })), tone: "done" };
    case "stopped":
      return { word: resolve(msg("Stopped", { $context: "workflow run status" })), tone: "quiet" };
    case "skipped":
      return { word: resolve(msg("Skipped", { $context: "workflow run status" })), tone: "quiet" };
    case "cancelled":
      return {
        word: resolve(msg("Cancelled", { $context: "workflow run status" })),
        tone: "quiet",
      };
  }
}

const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.trim();

/** What a run is at right now, as the line under its title. */
export function workflowRunNow(node: WorkflowRunNode, resolve: MFunctionType = mFallback): string {
  const { run } = node;
  const detail = run.detail?.trim() ?? "";
  const asked = node.questions[0];
  if (asked !== undefined) {
    const more = node.questions.length - 1;
    const question = readWorkflowQuestion(asked).title;
    return more > 0
      ? resolve(msg("Asks: {question} and {more} more", { question, more }))
      : resolve(msg("Asks: {question}", { question }));
  }
  const below = flattenWorkflowRunNodes(node.children);
  const holding = below.find(
    (child) => child.questions.length > 0 || child.run.status === "paused",
  );
  switch (run.status) {
    case "paused":
      return detail === "" ? resolve(msg("A step failed")) : firstLine(detail);
    case "running":
      return resolve(msg("Running its own steps"));
    case "waiting":
      if (holding !== undefined) {
        return `${holding.run.title}: ${workflowRunNow(holding, resolve)}`;
      }
      if (detail.startsWith("agent ")) {
        return resolve(msg("{step} is working", { step: detail.slice(6) }));
      }
      if (detail.startsWith("sleep ")) {
        return resolve(msg("Sleeping at {step}", { step: detail.slice(6) }));
      }
      if (detail.startsWith("queue ")) {
        return resolve(msg("Queued for {pool}", { pool: detail.slice(6) }));
      }
      if (below.some((child) => child.run.endedAt === null)) {
        const open = below.filter((child) => child.run.endedAt === null);
        return open.length === 1
          ? resolve(msg("Runs {run}", { run: open[0]!.run.title }))
          : resolve(msg("{count} runs under way", { count: open.length }));
      }
      return detail === ""
        ? resolve(msg("Waiting", { $context: "what a workflow run is doing now" }))
        : resolve(msg("Waiting for {step}", { step: detail }));
    case "completed": {
      const line = workflowResultLines(run.result)[0];
      if (line === undefined) {
        return resolve(msg("Finished", { $context: "what a workflow run is doing now" }));
      }
      return firstLine(line.label === null ? line.value : `${line.label}: ${line.value}`);
    }
    case "stopped":
    case "skipped":
    case "cancelled":
      return detail === "" ? resolve(msg("Ended early")) : firstLine(detail);
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
  /** For a step queued for a place in a pool, how many are ahead of it. */
  readonly ahead: number | undefined;
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
  // A caller's clock can be a minute old. Now is never before anything the run has done.
  const nowMs = Math.max(
    input.nowMs,
    startMs,
    ...input.steps.map((step) => Date.parse(step.endedAt ?? step.startedAt)),
  );
  const endMs = input.run.endedAt === null ? nowMs : Date.parse(input.run.endedAt);
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
    const stepEnd = step.endedAt === null ? nowMs : Date.parse(step.endedAt);
    const childRun = step.kind === "wait" ? (childByStep.get(step.name) ?? null) : null;
    // A place given at once is bookkeeping too; a wait for one is a beat.
    const isBeat =
      (step.kind !== "step" && step.kind !== "queue") ||
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
      ahead: step.ahead,
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
    left !== right && left.startMs < openEnd(right) && right.startMs < openEnd(left);
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

/** When a beat stops overlapping what starts after it: one still under way never does. */
const openEnd = (beat: WorkflowBeat) =>
  beat.status === "running" ? Number.POSITIVE_INFINITY : beat.endMs;

/** What a person answered a question with, when a step's result is such an answer. */
export function workflowAnswer(result: WorkflowStep["result"]): {
  readonly choice: string;
  readonly reason: string | null;
  /** The client, tool or agent thread that answered, by name; null on an answer kept before this. */
  readonly answeredBy: string | null;
  /** The client session that answered; null for a tool, an agent, or an answer kept before this. */
  readonly answeredBySession: string | null;
  readonly answeredAt: string | null;
} | null {
  const choice = field(result, "choice");
  return typeof choice === "string"
    ? {
        choice,
        reason: text(field(result, "reason")),
        answeredBy: text(field(result, "answeredBy")),
        answeredBySession: text(field(result, "answeredBySession")),
        answeredAt: text(field(result, "answeredAt")),
      }
    : null;
}

/** Who withdrew a question unanswered, and why, when a step's result says so. */
export function workflowWithdrawal(
  result: WorkflowStep["result"],
): { readonly by: string; readonly reason: string | null } | null {
  const withdrawn = field(result, "withdrawn");
  const by = field(withdrawn, "by");
  const reason = field(withdrawn, "reason");
  return typeof by === "string"
    ? { by, reason: typeof reason === "string" && reason.trim() !== "" ? reason : null }
    : null;
}

/**
 * Whether the client whose session on the run's environment is `sessionId` gave `answer`. Decided
 * by session, never by name: two browsers share "Chrome on Linux" and every phone its app's name.
 */
export const isOwnWorkflowAnswer = (
  answer: { readonly answeredBySession: string | null },
  sessionId: string | null | undefined,
): boolean => answer.answeredBySession !== null && answer.answeredBySession === sessionId;

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
      until = Math.max(until, openEnd(row));
      continue;
    }
    flush();
    together = [row];
    until = openEnd(row);
  }
  flush();
  return rows;
}

/** The steps of a feed that take a place in the run's flow: every beat, in order. */
const beatsOf = (rows: ReadonlyArray<WorkflowFeedRow>) =>
  rows.flatMap((row) => (row.kind === "quick" ? [] : row.kind === "together" ? row.beats : [row]));

/**
 * The step a paused run stopped at: the last that failed, unless the run went on after it, since
 * then the workflow caught that failure. Null when the run is not paused at a step.
 */
export function workflowPausedBeat(
  rows: ReadonlyArray<WorkflowFeedRow>,
  status: WorkflowRun["status"],
): WorkflowBeat | null {
  if (status !== "paused") return null;
  const failed = beatsOf(rows).findLast((beat) => beat.status === "failed");
  if (failed === undefined) return null;
  const wentOn = rows.some((row) =>
    row.kind === "together"
      ? row.beats.some((beat) => beat !== failed && beat.startMs >= failed.endMs)
      : row !== failed && row.startMs >= failed.endMs,
  );
  return wentOn ? null : failed;
}

/**
 * Which part of a run's flow to open on: what waits on a person, then where it failed, then how
 * it ended, then what is under way. Keys are `step:<name>`, `question:<name>`, `pause` and `end`.
 */
export function workflowFlowFocus(input: {
  readonly rows: ReadonlyArray<WorkflowFeedRow>;
  readonly status: WorkflowRun["status"];
  readonly ended: boolean;
  /** The names of the questions that wait on a person. */
  readonly questions: ReadonlyArray<string>;
}): string | null {
  const beats = beatsOf(input.rows);
  const asked = input.questions[0];
  if (asked !== undefined) {
    const at = beats.find(
      (beat) =>
        beat.kind === "ask" && beat.status === "running" && input.questions.includes(beat.name),
    );
    return at === undefined ? `question:${asked}` : `step:${at.name}`;
  }
  if (input.status === "paused") {
    const failed = workflowPausedBeat(input.rows, input.status);
    return failed === null ? "pause" : `step:${failed.name}`;
  }
  if (input.ended) return "end";
  const last = beats.findLast((beat) => beat.status === "running") ?? beats.at(-1);
  return last === undefined ? null : `step:${last.name}`;
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
  // Text with no space before the limit, such as Chinese, is cut at the limit, never inside a
  // surrogate pair.
  if (kept.length > limit * 2) {
    const space = kept.lastIndexOf(" ", limit);
    const before = kept.charCodeAt(limit - 1);
    const highSurrogateLast = before >= 0xd800 && before <= 0xdbff;
    const end = space > 0 ? space : highSurrogateLast ? limit - 1 : limit;
    kept = `${kept.slice(0, end)}…`;
  }
  return kept === said ? null : kept;
}

const decodeIssueAddress = Schema.decodeUnknownOption(WorkflowIssueAddress);
const decodePullRequestAddress = Schema.decodeUnknownOption(WorkflowPullRequestAddress);

/** A reference's issue, when it is one and its address reads as one. */
export function workflowReferenceIssue(reference: WorkflowRunSubject): IssueRef | null {
  return reference.kind === WorkflowReferenceKind.issue
    ? Option.getOrNull(decodeIssueAddress(reference.address))
    : null;
}

/** A reference's pull request, when it is one and its address reads as one. */
export function workflowReferencePullRequest(reference: WorkflowRunSubject): PullRequestRef | null {
  return reference.kind === WorkflowReferenceKind.pullRequest
    ? Option.getOrNull(decodePullRequestAddress(reference.address))
    : null;
}

/** A reference's thread, when it is one, in the run's own environment. */
export function workflowReferenceThreadId(reference: WorkflowRunSubject): string | null {
  const threadId = field(reference.address, "threadId");
  return reference.kind === WorkflowReferenceKind.thread && typeof threadId === "string"
    ? threadId
    : null;
}

/**
 * What a reference is called in a chip: `#412` for an issue or pull request on a git host, a
 * tracker's own key such as `ENG-12`, and otherwise the title, or the host of its web address.
 */
export function workflowReferenceLabel(reference: WorkflowRunSubject): string {
  const pullRequest = workflowReferencePullRequest(reference);
  if (pullRequest !== null) return `#${pullRequest.number}`;
  const issue = workflowReferenceIssue(reference);
  if (issue !== null) return /^\d+$/.test(issue.key) ? `#${issue.key}` : issue.key;
  if (reference.title !== "") return reference.title;
  const url = reference.url === null ? null : parseUrl(reference.url);
  return url?.host ?? reference.kind;
}

/** The references a step touched, in the order the run first touched them. */
export function workflowStepReferences(
  references: ReadonlyArray<WorkflowRunReference>,
  step: string,
): ReadonlyArray<WorkflowRunReference> {
  return references.filter((reference) => reference.steps.includes(step));
}

/** A step's time in one shape down a column: 0.3s, 9.7s, 12s, then minutes. */
export function workflowStepTime(ms: number, resolve: MFunctionType = mFallback): string {
  if (ms < 9_950 && ms % 1000 !== 0) {
    return resolve(msg("{seconds}s", { seconds: (Math.max(ms, 100) / 1000).toFixed(1) }));
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return resolve(msg("{seconds}s", { seconds }));
  return formatDuration(ms, resolve);
}

/**
 * The first prose sentence of a reply, as one line of plain text: headings, tables, and fenced
 * code blocks are skipped; indented text is a fallback. List marks, code, emphasis, and links read as words.
 * Code keeps its text, and an underscore inside a word, as in snake_case, is not emphasis.
 */
export function workflowOneLine(text: string): string {
  let fence: string | null = null;
  let fenceQuoteDepth = 0;
  let indented: string | undefined;
  const line =
    text
      .split("\n")
      .find((candidate) => {
        const quote = /^(?: {0,3}>[ \t]?)+/.exec(candidate)?.[0] ?? "";
        const quoteDepth = quote.replace(/[^>]/g, "").length;
        const content = candidate.slice(quote.length);
        const [, marker, rest] = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(content) ?? [];
        if (quoteDepth < fenceQuoteDepth) fence = null;
        if (fence !== null) {
          if (
            quoteDepth === fenceQuoteDepth &&
            marker?.startsWith(fence) &&
            /^[ \t]*\r?$/.test(rest ?? "")
          ) {
            fence = null;
          }
          return false;
        }
        if (marker !== undefined && !(marker[0] === "`" && rest?.includes("`"))) {
          fence = marker;
          fenceQuoteDepth = quoteDepth;
          return false;
        }
        if (
          /^\s*$/.test(content) ||
          /^ {0,3}#{1,6}(?:[ \t]|\r?$)/.test(content) ||
          /^[ \t]*\|/.test(candidate)
        )
          return false;
        if (!/^(?: {4}| {0,3}\t)/.test(content)) return true;
        indented ??= candidate;
        return false;
      })
      ?.trim() ??
    indented?.trim() ??
    "";
  const code: string[] = [];
  const plain = line
    .replace(/^(?:>\s*)+/, "")
    .replace(/^([-*]|\d+\.)\s+/, "")
    .replace(/(`+)(.+?)\1(?!`)/g, (_, _ticks, inner: string) => `\0${code.push(inner) - 1}\0`)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?<![\p{L}\p{M}\p{N}_/])(__|_)(\S(?:.*?\S)?)\1(?![\p{L}\p{M}\p{N}_/])/gu, "$2")
    .replace(/(\*\*|\*)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\0(\d+)\0/g, (match, index: string) => code[Number(index)] ?? match);
  const end = plain.search(/[.!?](\s|$)/);
  return end === -1 ? plain : plain.slice(0, end + 1);
}
