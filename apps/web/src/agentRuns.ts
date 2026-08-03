/**
 * Groups the flat `task.*` orchestration activities a Claude turn emits into one
 * run per `taskId`, and swaps the consumed work-log rows out of the timeline.
 *
 * Fork-owned decision layer for the agent-run cards: pure, no React and no web
 * imports beyond types, so it can move to `packages/client-runtime` when mobile
 * grows the same surface.
 *
 * Keyed by `taskId`, never by `tool_use_id`: activities arrive ordered and
 * persisted, so a progress frame can never beat its own tool row and no orphan
 * buffering is needed. `toolUseId` is an optional link, never the identity.
 */

import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "./session-logic.ts";

export type AgentRunPhase = "running" | "done" | "failed" | "stopped";

/**
 * What produced a feed line. `subagent` exists because a nested agent arrives in
 * the same `lastToolName` slot as a tool but is not one (`probe:toolchain(65s)`),
 * and rendering it as a tool is what made three nested rows read identically.
 */
export type AgentRunFeedLineKind = "tool" | "subagent" | "status";

/**
 * One coalesced line of the run's work log.
 *
 * `tool` is the actor and `text` is the object, split by
 * {@link agentRunFeedText} — never a bare concatenation, which is what produced
 * "Bash Running Idle 30 seconds".
 */
export interface AgentRunFeedLine {
  /** The activity id of the frame that *opened* the line; stable across folds. */
  readonly id: string;
  readonly createdAt: string;
  /** Bumped by a repeat or an in-place update, so the row can show freshness. */
  readonly updatedAt: string;
  readonly kind: AgentRunFeedLineKind;
  /** Tool or nested-agent name. Never carries the `(65s)` elapsed suffix. */
  readonly tool?: string;
  /** May be empty: a tool-only frame is a legitimate line ("Bash"). */
  readonly text: string;
  readonly toolUseId?: string;
  /** 1 for a line seen once, N when the same line arrived N times in a row. */
  readonly repeat: number;
}

/** What a `task.progress` frame contributes before the fold decides its fate. */
export interface AgentRunFeedInput {
  readonly id: string;
  readonly createdAt: string;
  readonly kind: AgentRunFeedLineKind;
  readonly tool?: string;
  readonly text: string;
  readonly toolUseId?: string;
}

export interface AgentRun {
  readonly taskId: string;
  /** First consumed activity id — the timeline row identity, stable across re-derivations. */
  readonly rowId: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly turnId: TurnId | null;
  readonly title: string;
  readonly phase: AgentRunPhase;
  readonly taskType?: string;
  readonly subagentType?: string;
  readonly workflowName?: string;
  readonly prompt?: string;
  readonly toolUseId?: string;
  readonly lastToolName?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly ambient: boolean;
  /** True when no `task.started` was in the loaded window — the card says so rather than faking a start. */
  readonly detailsUnavailable: boolean;
  readonly feed: ReadonlyArray<AgentRunFeedLine>;
}

/** Ported from 2code's NESTED_CAP: an uncapped feed is an unbounded row. */
export const AGENT_RUN_FEED_CAP = 20;

const TASK_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.completed",
]);

export function isTerminalAgentRunPhase(phase: AgentRunPhase): boolean {
  return phase !== "running";
}

interface AgentRunDraft {
  taskId: string;
  rowId: string;
  createdAt: string;
  settledAt: string | null;
  turnId: TurnId | null;
  phase: AgentRunPhase;
  sawStart: boolean;
  /**
   * Frozen the first time the run can be named — see {@link refreshDraftTitle}.
   * Never reassigned, so a progress frame can no longer rename a card the user
   * is watching.
   */
  title?: string;
  /** `task.started`'s own `detail`. A progress frame never writes here. */
  startedDetail?: string;
  /** Only set for a run whose `task.started` was outside the loaded window. */
  restoredLabel?: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  prompt?: string;
  toolUseId?: string;
  lastToolName?: string;
  summary?: string;
  error?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  ambient: boolean;
  feed: ReadonlyArray<AgentRunFeedLine>;
}

export interface AgentRunsResult {
  readonly runs: ReadonlyArray<AgentRun>;
  readonly consumedActivityIds: ReadonlySet<string>;
}

export function deriveAgentRuns(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { readonly activeTurnId: TurnId | null },
): AgentRunsResult {
  const drafts = new Map<string, AgentRunDraft>();
  const consumedActivityIds = new Set<string>();

  // Server-ordered, replayed activities: a single forward pass is enough, and
  // the terminal-phase guard below is only safe because of that ordering.
  for (const activity of activities) {
    if (!TASK_ACTIVITY_KINDS.has(activity.kind)) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = readString(payload, "taskId");
    if (!taskId) {
      continue;
    }
    consumedActivityIds.add(activity.id);

    const draft =
      drafts.get(taskId) ??
      (() => {
        const created: AgentRunDraft = {
          taskId,
          rowId: activity.id,
          createdAt: activity.createdAt,
          settledAt: null,
          turnId: activity.turnId,
          phase: "running",
          sawStart: false,
          ambient: false,
          feed: [],
        };
        drafts.set(taskId, created);
        return created;
      })();

    applyActivity(draft, activity, payload);
  }

  const runs: AgentRun[] = [];
  for (const draft of drafts.values()) {
    runs.push(finalizeDraft(draft, options.activeTurnId));
  }
  return { runs, consumedActivityIds };
}

/**
 * Reuses the previous `AgentRun` objects (and the previous array) whenever a
 * re-derivation produced the same content.
 *
 * The fold re-runs on every thread activity, including the many that have
 * nothing to do with tasks. Without this, each unrelated tool row would hand
 * every consumer a brand new run object: the timeline's row-identity check
 * (`a.run === b.run`) would fail and the header controls hosting the tracker
 * would re-render on a hot path.
 */
export function stabilizeAgentRuns(
  previous: AgentRunsResult | null,
  next: AgentRunsResult,
): AgentRunsResult {
  if (previous === null) {
    return next;
  }
  // fork: f3 F-26 — compare the id SET, not its size. Two derivations with the
  // same count but different ids (one activity replaced by another in the same
  // fold) returned `previous`, so the timeline kept hiding the wrong work rows.
  let changed =
    previous.runs.length !== next.runs.length ||
    !sameIdSet(previous.consumedActivityIds, next.consumedActivityIds);

  const previousByTaskId = new Map(previous.runs.map((run) => [run.taskId, run]));
  const runs = next.runs.map((run, index) => {
    const prior = previousByTaskId.get(run.taskId);
    if (prior !== undefined && agentRunEquals(prior, run)) {
      if (previous.runs[index] !== prior) {
        changed = true; // same runs, different order
      }
      return prior;
    }
    changed = true;
    return run;
  });

  return changed ? { runs, consumedActivityIds: next.consumedActivityIds } : previous;
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

export function agentRunEquals(a: AgentRun, b: AgentRun): boolean {
  return (
    a.taskId === b.taskId &&
    a.rowId === b.rowId &&
    a.createdAt === b.createdAt &&
    a.settledAt === b.settledAt &&
    a.turnId === b.turnId &&
    a.title === b.title &&
    a.phase === b.phase &&
    a.taskType === b.taskType &&
    a.subagentType === b.subagentType &&
    a.workflowName === b.workflowName &&
    a.prompt === b.prompt &&
    a.toolUseId === b.toolUseId &&
    a.lastToolName === b.lastToolName &&
    a.summary === b.summary &&
    a.error === b.error &&
    a.totalTokens === b.totalTokens &&
    a.toolUses === b.toolUses &&
    a.durationMs === b.durationMs &&
    a.ambient === b.ambient &&
    a.detailsUnavailable === b.detailsUnavailable &&
    feedEquals(a.feed, b.feed)
  );
}

/**
 * Feed lines keep the id of the frame that opened them, so — since the D2 fold
 * lands repeats and progress *into* the tail — comparing ids alone would report
 * a coalescing update as "unchanged" and freeze the visible `×N` and text.
 */
function feedEquals(
  a: ReadonlyArray<AgentRunFeedLine>,
  b: ReadonlyArray<AgentRunFeedLine>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left?.id !== right?.id ||
      left?.kind !== right?.kind ||
      left?.tool !== right?.tool ||
      left?.text !== right?.text ||
      left?.repeat !== right?.repeat
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The one upstream hook: replaces the work rows an agent run consumed with a
 * single `agent-run` row anchored at the position of the first of them.
 */
export function withAgentRunEntries(
  entries: ReadonlyArray<TimelineEntry>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { readonly activeTurnId: TurnId | null },
  /**
   * Pre-derived result, so a caller that also renders the tracker pill folds the
   * activities once instead of twice. Omit it and the fold runs here.
   */
  derived?: AgentRunsResult,
): TimelineEntry[] {
  const { runs, consumedActivityIds } = derived ?? deriveAgentRuns(activities, options);
  if (runs.length === 0) {
    return [...entries];
  }

  // Ambient/housekeeping runs are hidden from the transcript per the SDK's own
  // instruction — their work rows are still consumed so they leave nothing behind.
  const runRows: TimelineEntry[] = runs
    .filter((run) => !run.ambient)
    .map((run) => ({
      id: `agent-run:${run.rowId}`,
      kind: "agent-run" as const,
      createdAt: run.createdAt,
      run,
    }))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Both sides are already ordered by createdAt, so one merge pass keeps the
  // run row at the timeline position of the work it replaced.
  const result: TimelineEntry[] = [];
  let runCursor = 0;
  for (const entry of entries) {
    while (
      runCursor < runRows.length &&
      (runRows[runCursor] as TimelineEntry).createdAt.localeCompare(entry.createdAt) <= 0
    ) {
      result.push(runRows[runCursor] as TimelineEntry);
      runCursor += 1;
    }
    if (entry.kind === "work" && consumedActivityIds.has(entry.entry.id)) {
      continue;
    }
    result.push(entry);
  }
  for (; runCursor < runRows.length; runCursor += 1) {
    result.push(runRows[runCursor] as TimelineEntry);
  }

  return result;
}

function applyActivity(
  draft: AgentRunDraft,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): void {
  if (activity.turnId !== null) {
    draft.turnId = activity.turnId;
  }

  switch (activity.kind) {
    case "task.started": {
      draft.sawStart = true;
      draft.createdAt = activity.createdAt;
      assignString(draft, "startedDetail", payload, "detail");
      assignString(draft, "taskType", payload, "taskType");
      assignString(draft, "subagentType", payload, "subagentType");
      assignString(draft, "workflowName", payload, "workflowName");
      assignString(draft, "prompt", payload, "prompt");
      assignString(draft, "toolUseId", payload, "toolUseId");
      if (readBoolean(payload, "ambient")) {
        draft.ambient = true;
      }
      refreshDraftTitle(draft);
      return;
    }

    case "task.progress": {
      // Terminal phase is sticky: a late progress frame must not un-settle a
      // run that already reported an outcome.
      assignString(draft, "subagentType", payload, "subagentType");
      assignString(draft, "toolUseId", payload, "toolUseId");
      assignString(draft, "lastToolName", payload, "lastToolName");
      assignNumber(draft, "totalTokens", payload, "totalTokens");
      assignNumber(draft, "toolUses", payload, "toolUses");
      assignNumber(draft, "durationMs", payload, "durationMs");
      // fork: f3 D1 — a run whose `task.started` fell outside the loaded window
      // has nothing else to be called; take the FIRST such label and freeze it.
      // A run that saw its start is never named from progress.
      if (!draft.sawStart && draft.restoredLabel === undefined) {
        assignString(draft, "restoredLabel", payload, "title");
        if (draft.restoredLabel === undefined) {
          assignString(draft, "restoredLabel", payload, "detail");
        }
      }
      refreshDraftTitle(draft);

      const actor = agentRunFeedActor(readString(payload, "lastToolName"));
      const rawText =
        readString(payload, "summary") ??
        readString(payload, "title") ??
        readString(payload, "detail") ??
        activity.summary;
      const text = agentRunFeedText(rawText, actor?.tool);
      const toolUseId = readString(payload, "toolUseId");
      draft.feed = agentRunFeedWith(draft.feed, {
        id: activity.id,
        createdAt: activity.createdAt,
        kind: actor?.kind ?? "status",
        // A nested agent's line carries the *parent's* prompt in this slot, so
        // three sibling agents rendered as three identical rows (D4).
        text: actor?.kind === "subagent" && echoesTheRun(text, draft) ? "" : text,
        ...(actor ? { tool: actor.tool } : {}),
        ...(toolUseId !== null ? { toolUseId } : {}),
      });
      return;
    }

    case "task.completed": {
      assignNumber(draft, "totalTokens", payload, "totalTokens");
      assignNumber(draft, "toolUses", payload, "toolUses");
      assignNumber(draft, "durationMs", payload, "durationMs");
      assignString(draft, "summary", payload, "summary");
      assignString(draft, "error", payload, "error");
      if (isTerminalAgentRunPhase(draft.phase)) {
        return;
      }
      draft.phase = phaseFromCompletedStatus(readString(payload, "status"));
      draft.settledAt = activity.createdAt;
      return;
    }

    default:
      return;
  }
}

function finalizeDraft(draft: AgentRunDraft, activeTurnId: TurnId | null): AgentRun {
  // A run left non-terminal by a turn that is no longer live can never settle:
  // report it as stopped instead of spinning forever.
  const phase: AgentRunPhase =
    draft.phase === "running" && draft.turnId !== null && draft.turnId !== activeTurnId
      ? "stopped"
      : draft.phase;

  const durationMs =
    draft.durationMs ?? (draft.settledAt ? elapsedMs(draft.createdAt, draft.settledAt) : undefined);

  return {
    taskId: draft.taskId,
    rowId: draft.rowId,
    createdAt: draft.createdAt,
    settledAt: draft.settledAt,
    turnId: draft.turnId,
    title: draft.title ?? AGENT_RUN_FALLBACK_TITLE,
    phase,
    ...(draft.taskType ? { taskType: draft.taskType } : {}),
    ...(draft.subagentType ? { subagentType: draft.subagentType } : {}),
    ...(draft.workflowName ? { workflowName: draft.workflowName } : {}),
    ...(draft.prompt ? { prompt: draft.prompt } : {}),
    ...(draft.toolUseId ? { toolUseId: draft.toolUseId } : {}),
    ...(draft.lastToolName ? { lastToolName: draft.lastToolName } : {}),
    ...(draft.summary ? { summary: draft.summary } : {}),
    ...(draft.error ? { error: draft.error } : {}),
    ...(draft.totalTokens !== undefined ? { totalTokens: draft.totalTokens } : {}),
    ...(draft.toolUses !== undefined ? { toolUses: draft.toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ambient: draft.ambient,
    detailsUnavailable: !draft.sawStart,
    feed: draft.feed,
  };
}

export const AGENT_RUN_FALLBACK_TITLE = "Agent run";

/** Words of the delegated prompt that stand in for a name. */
const AGENT_RUN_TITLE_PROMPT_WORDS = 6;

/**
 * fork: f3 D1 — freezes the run's name.
 *
 * The title used to be recomputed on every fold from `lastToolName` /
 * `description`, both of which a `task.progress` frame rewrites — so a card
 * renamed itself while the user watched it (a Bash description became the run's
 * name: "Idle 20 seconds"). Here the first non-empty candidate wins and is never
 * replaced; later frames can only fill a title that is still absent.
 *
 * Order: workflow → subagent → the task's own start detail → task type →
 * the first {@link AGENT_RUN_TITLE_PROMPT_WORDS} words of the prompt →
 * (restored runs only) the first progress label → {@link AGENT_RUN_FALLBACK_TITLE}.
 */
function refreshDraftTitle(draft: AgentRunDraft): void {
  if (draft.title !== undefined) {
    return;
  }
  const named =
    draft.workflowName ??
    draft.subagentType ??
    draft.startedDetail ??
    draft.taskType ??
    firstWords(draft.prompt, AGENT_RUN_TITLE_PROMPT_WORDS) ??
    draft.restoredLabel;
  if (named !== undefined && named.trim().length > 0) {
    draft.title = named.trim();
  }
}

function firstWords(value: string | undefined, count: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }
  const head = words.slice(0, count).join(" ");
  return words.length > count ? `${head}…` : head;
}

/**
 * Unknown status is a failure, never a green check — re-asserted here because a
 * run restored from persisted activities may predate the server-side normalizer.
 */
function phaseFromCompletedStatus(status: string | null): AgentRunPhase {
  switch (status) {
    case "completed":
      return "done";
    case "stopped":
      return "stopped";
    default:
      return "failed";
  }
}

/** `probe:toolchain(65s)` — a nested agent wearing the tool-name slot. */
const NESTED_AGENT_TOOL_NAME = /^(.+?)\(\d+(?:\.\d+)?s\)$/;

/**
 * fork: f3 D4 — tells a tool apart from a nested agent.
 *
 * The server puts both in `lastToolName`; only the nested one carries its own
 * elapsed time, which the row already ticks, so it is dropped here.
 */
export function agentRunFeedActor(
  lastToolName: string | null,
): { readonly kind: "tool" | "subagent"; readonly tool: string } | null {
  if (lastToolName === null) {
    return null;
  }
  const name = lastToolName.trim();
  if (name.length === 0) {
    return null;
  }
  const nested = NESTED_AGENT_TOOL_NAME.exec(name);
  const nestedName = nested?.[1]?.trim();
  if (nestedName !== undefined && nestedName.length > 0) {
    return { kind: "subagent", tool: nestedName };
  }
  return { kind: "tool", tool: name };
}

/**
 * Bare status verbs the server prefixes to a work-log sentence.
 *
 * Deliberately narrow: only verbs that restate what the row's own status glyph
 * and elapsed clock already say. Content verbs ("searching", "fetching") carry
 * a real relationship to the object and stay.
 */
const AGENT_RUN_FEED_STATUS_VERBS = [
  "running",
  "ran",
  "executing",
  "executed",
  "invoking",
  "invoked",
  "calling",
  "called",
  "using",
  "used",
  "starting",
  "started",
  "waiting",
  "queued",
  "pending",
];

/**
 * fork: f3 D3 — splits `{actor} {status verb} {object}` down to the object.
 *
 * `AgentRunCard` used to render `{toolName} {label}` with `label` already a
 * complete sentence, giving "Bash Running Idle 30 seconds". With the actor in
 * its own column, the copy on this side must not repeat it.
 */
export function agentRunFeedText(raw: string | null, tool: string | undefined): string {
  let text = (raw ?? "").trim();
  if (text.length === 0 || tool === undefined) {
    return text;
  }
  text = stripLeadingActor(text, tool);
  for (const verb of AGENT_RUN_FEED_STATUS_VERBS) {
    const stripped = stripLeadingWord(text, verb);
    if (stripped !== null) {
      text = stripped;
      break;
    }
  }
  // "Running Bash" — the actor can sit on either side of the verb.
  return stripLeadingActor(text, tool).trim();
}

/** Drops a leading `Read` / `Reading` when the actor column already says it. */
function stripLeadingActor(text: string, tool: string): string {
  const exact = stripLeadingWord(text, tool);
  if (exact !== null) {
    return exact;
  }
  const firstWord = /^[\p{L}\p{N}_:.-]+/u.exec(text)?.[0];
  if (firstWord === undefined || wordStem(firstWord) !== wordStem(tool)) {
    return text;
  }
  return stripLeadingWord(text, firstWord) ?? text;
}

/** Crude, deliberately: it only has to fold `read/reading`, `write/writing`. */
function wordStem(word: string): string {
  return word.toLowerCase().replace(/(ing|ed|es|s|e)$/u, "");
}

/** Removes `word` from the front of `text`, case-insensitively, on a boundary. */
function stripLeadingWord(text: string, word: string): string | null {
  if (word.length === 0 || text.length < word.length) {
    return null;
  }
  if (text.slice(0, word.length).toLowerCase() !== word.toLowerCase()) {
    return null;
  }
  const rest = text.slice(word.length);
  if (rest.length === 0) {
    return "";
  }
  return /^[\s:·–—-]/.test(rest) ? rest.replace(/^[\s:·–—-]+/, "") : null;
}

/** Shortest text worth comparing against the run's own copy. */
const AGENT_RUN_FEED_ECHO_MIN_LENGTH = 8;

/**
 * True when a nested agent's line is just repeating the parent run's prompt or
 * description — the reason three sibling agents rendered as three identical
 * rows in the reported screenshot.
 */
function echoesTheRun(text: string, draft: AgentRunDraft): boolean {
  const candidate = normalizeForEcho(text);
  if (candidate.length < AGENT_RUN_FEED_ECHO_MIN_LENGTH) {
    return false;
  }
  for (const source of [draft.prompt, draft.startedDetail, draft.title]) {
    if (source === undefined) {
      continue;
    }
    const normalized = normalizeForEcho(source);
    if (normalized.length === 0) {
      continue;
    }
    if (normalized.startsWith(candidate) || candidate.startsWith(normalized)) {
      return true;
    }
  }
  return false;
}

function normalizeForEcho(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/…+$/, "").toLowerCase();
}

/**
 * fork: f3 D2 — the coalescing fold that replaced a blind append.
 *
 * Three outcomes, in order:
 * 1. same actor and same text as the tail → bump `repeat`, keep one row;
 * 2. same `toolUseId` as the tail → one activity progressing, replace the tail
 *    in place so its React key (and scroll position) survives;
 * 3. otherwise append, capped at {@link AGENT_RUN_FEED_CAP}.
 *
 * Pure so the duplicate-line defect can be pinned by a test.
 */
export function agentRunFeedWith(
  feed: ReadonlyArray<AgentRunFeedLine>,
  incoming: AgentRunFeedInput,
): ReadonlyArray<AgentRunFeedLine> {
  // A frame with neither an actor nor text says nothing.
  if (incoming.text.length === 0 && incoming.tool === undefined) {
    return feed;
  }
  const tail = feed.at(-1);
  if (tail !== undefined) {
    if (tail.tool === incoming.tool && tail.text === incoming.text) {
      return replaceTail(feed, {
        ...tail,
        updatedAt: incoming.createdAt,
        repeat: tail.repeat + 1,
      });
    }
    if (
      incoming.toolUseId !== undefined &&
      tail.toolUseId === incoming.toolUseId &&
      tail.kind === incoming.kind
    ) {
      return replaceTail(feed, {
        id: tail.id,
        createdAt: tail.createdAt,
        updatedAt: incoming.createdAt,
        kind: incoming.kind,
        text: incoming.text,
        repeat: tail.repeat,
        toolUseId: incoming.toolUseId,
        ...(incoming.tool !== undefined ? { tool: incoming.tool } : {}),
      });
    }
  }
  const next = [
    ...feed,
    {
      id: incoming.id,
      createdAt: incoming.createdAt,
      updatedAt: incoming.createdAt,
      kind: incoming.kind,
      text: incoming.text,
      repeat: 1,
      ...(incoming.tool !== undefined ? { tool: incoming.tool } : {}),
      ...(incoming.toolUseId !== undefined ? { toolUseId: incoming.toolUseId } : {}),
    },
  ];
  return next.length > AGENT_RUN_FEED_CAP ? next.slice(next.length - AGENT_RUN_FEED_CAP) : next;
}

function replaceTail(
  feed: ReadonlyArray<AgentRunFeedLine>,
  line: AgentRunFeedLine,
): ReadonlyArray<AgentRunFeedLine> {
  const next = feed.slice(0, -1);
  next.push(line);
  return next;
}

function elapsedMs(from: string, to: string): number | undefined {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBoolean(payload: Record<string, unknown> | null, key: string): boolean {
  return payload?.[key] === true;
}

type AgentRunDraftStringField =
  | "startedDetail"
  | "restoredLabel"
  | "taskType"
  | "subagentType"
  | "workflowName"
  | "prompt"
  | "toolUseId"
  | "lastToolName"
  | "summary"
  | "error";

function assignString(
  draft: AgentRunDraft,
  field: AgentRunDraftStringField,
  payload: Record<string, unknown> | null,
  key: string,
): void {
  const value = readString(payload, key);
  if (value !== null) {
    draft[field] = value;
  }
}

function assignNumber(
  draft: AgentRunDraft,
  field: "totalTokens" | "toolUses" | "durationMs",
  payload: Record<string, unknown> | null,
  key: string,
): void {
  const value = payload?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    draft[field] = value;
  }
}
