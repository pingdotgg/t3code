import { MessageId } from "@t3tools/contracts";
import {
  type DisplayEvent,
  type DisplayMode,
  displayEventFromMessage,
  displayEventFromTurnItem,
  foldCores,
  isReplaceSendCall,
  type VisibleCore,
} from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";

import type { MessagesTimelineRow } from "../../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";
import type { SubThreadSummaries, SubThreadSummary } from "../subThreads/subThreadsState";

/** Each event id is its timeline entry's id, so each shown message leads back to its row. */
function displayEventFromEntry(entry: TimelineEntry): DisplayEvent | null {
  switch (entry.kind) {
    case "message":
      return displayEventFromMessage({ ...entry.message, id: entry.id });
    case "work": {
      const item = entry.entry.structuredPayload;
      if (item === undefined) return { type: "other" };
      const event = displayEventFromTurnItem(item);
      return event?.type === "sent" ? { ...event, id: entry.id } : event;
    }
    case "event":
      return displayEventFromTurnItem(entry.projectedItem.item);
    // A Normal-mode send, drawn from its output; the server reads the same send from its input.
    case "sent-message":
      return { type: "sent", id: entry.id, text: entry.text };
    default:
      return { type: "other" };
  }
}

// Entries change on every streamed delta. A reply that keeps its object keeps its row from redrawing,
// until a rewrite changes its text or edit time without changing its entry.
const repliesInRun = new WeakMap<TimelineEntry, Extract<TimelineEntry, { kind: "message" }>>();
const repliesOutsideRun = new WeakMap<TimelineEntry, Extract<TimelineEntry, { kind: "message" }>>();
const rewrittenSends = new WeakMap<
  TimelineEntry,
  Extract<TimelineEntry, { kind: "sent-message" }>
>();

/** Normal draws a Normal-mode send in upstream's row, with the text of its latest rewrite. */
function sentWithText(
  entry: Extract<TimelineEntry, { kind: "sent-message" }>,
  text: string,
): TimelineEntry {
  if (text === entry.text) return entry;
  const known = rewrittenSends.get(entry);
  if (known?.text === text) return known;
  const rewritten = { ...entry, text };
  rewrittenSends.set(entry, rewritten);
  return rewritten;
}

/**
 * A sent message reads as the agent's reply, not as a tool call. The turn fold hides messages of a
 * run before its last one, so a mode that shows every send gives its replies no run.
 */
function replyEntry(
  entry: TimelineEntry,
  text: string,
  editedAt: string | undefined,
  inRun: boolean,
): TimelineEntry {
  const replies = inRun ? repliesInRun : repliesOutsideRun;
  const known = replies.get(entry);
  if (known?.message.text === text && known.message.editedAt === editedAt) return known;
  const reply: Extract<TimelineEntry, { kind: "message" }> = {
    id: entry.id,
    kind: "message",
    createdAt: entry.createdAt,
    message: {
      id: MessageId.make(entry.id),
      role: "assistant",
      text,
      runId: inRun && entry.kind === "work" ? (entry.entry.structuredPayload?.runId ?? null) : null,
      streaming: false,
      createdBy: "agent",
      createdAt: entry.createdAt,
      // The turn fold's "Worked for" ends at updatedAt; the meta line shows editedAt instead.
      updatedAt: entry.createdAt,
      ...(editedAt === undefined ? {} : { editedAt }),
    },
  };
  replies.set(entry, reply);
  return reply;
}

interface FoldedTimeline {
  readonly events: ReadonlyArray<DisplayEvent | null>;
  readonly cores: ReadonlyArray<VisibleCore>;
  /** By core id, when the rewrite that last changed the core's text completed. Edited cores only. */
  readonly editedAt: ReadonlyMap<string, string>;
}

const NOT_EDITED: ReadonlyMap<string, string> = new Map();

function editTimes(
  entries: ReadonlyArray<TimelineEntry>,
  events: ReadonlyArray<DisplayEvent | null>,
  cores: ReadonlyArray<VisibleCore>,
): ReadonlyMap<string, string> {
  if (!cores.some((core) => core.editedBy !== undefined)) return NOT_EDITED;
  // An entry's time is its call's start; the user saw the new text when the call completed.
  const rewriteAt = new Map<string, string>();
  events.forEach((event, index) => {
    if (event?.type !== "rewrite") return;
    const entry = entries[index]!;
    const completedAt = entry.kind === "work" ? entry.entry.structuredPayload?.completedAt : null;
    rewriteAt.set(event.id, completedAt ? DateTime.formatIso(completedAt) : entry.createdAt);
  });
  return new Map(
    cores.flatMap((core): [string, string][] => {
      const at = core.editedBy === undefined ? undefined : rewriteAt.get(core.editedBy);
      return at === undefined ? [] : [[core.id, at]];
    }),
  );
}

// The rows and the sub-thread summaries of one timeline come from the same fold.
const foldedTimelines = new WeakMap<ReadonlyArray<TimelineEntry>, FoldedTimeline>();

function foldTimeline(entries: ReadonlyArray<TimelineEntry>): FoldedTimeline {
  let folded = foldedTimelines.get(entries);
  if (folded === undefined) {
    const events = entries.map(displayEventFromEntry);
    const cores = foldCores(events.filter((event) => event !== null));
    folded = { events, cores, editedAt: editTimes(entries, events, cores) };
    foldedTimelines.set(entries, folded);
  }
  return folded;
}

const summariesOfTimeline = new WeakMap<ReadonlyArray<TimelineEntry>, SubThreadSummaries>();

const sameSummary = (a: SubThreadSummary, b: SubThreadSummary) =>
  a.replies === b.replies &&
  a.lastAt === b.lastAt &&
  a.lastFrom === b.lastFrom &&
  a.lastText === b.lastText &&
  a.firstText === b.firstText &&
  a.agentReplyTimes.length === b.agentReplyTimes.length &&
  a.agentReplyTimes.every((at, index) => at === b.agentReplyTimes[index]);

/**
 * Each sub-thread that the loaded entries show, by the id of its first message, which must be
 * loaded too. A summary that equals its `previous` one is that object, and the result is
 * `previous` itself when nothing changed, so a streamed delta redraws no reply line.
 */
export function timelineSubThreads(
  entries: ReadonlyArray<TimelineEntry>,
  previous: SubThreadSummaries | null,
): SubThreadSummaries {
  const known = summariesOfTimeline.get(entries);
  if (known !== undefined) return known;
  const createdAt = new Map(entries.map((entry) => [entry.id, entry.createdAt]));
  const { cores, editedAt } = foldTimeline(entries);
  const summaries = new Map<string, SubThreadSummary>();
  for (const core of cores) {
    // Only the latest agent message of a sub-thread can be rewritten, so agentReplyTimes stays in order.
    const at = editedAt.get(core.id) ?? createdAt.get(core.id) ?? "";
    if (!core.reply) {
      summaries.set(core.id, {
        first: core.id,
        firstFrom: core.from,
        firstText: core.text,
        replies: 0,
        lastAt: at,
        lastFrom: core.from,
        lastText: core.text,
        agentReplyTimes: [],
      });
      continue;
    }
    const summary = core.first === null ? undefined : summaries.get(core.first);
    if (summary === undefined) continue;
    // A reply typed while an edit was delivered comes after the edited message but is older.
    const latest = !(Date.parse(at) < Date.parse(summary.lastAt));
    summaries.set(summary.first, {
      ...summary,
      replies: summary.replies + 1,
      ...(latest && { lastAt: at, lastFrom: core.from, lastText: core.text }),
      agentReplyTimes:
        core.from === "agent" ? [...summary.agentReplyTimes, at] : summary.agentReplyTimes,
    });
  }
  let changed = previous === null || previous.size !== summaries.size;
  for (const [first, summary] of summaries) {
    const before = previous?.get(first);
    if (before !== undefined && sameSummary(before, summary)) summaries.set(first, before);
    else changed = true;
  }
  const result = changed || previous === null ? summaries : previous;
  summariesOfTimeline.set(entries, result);
  return result;
}

/** The shown message of the row `id`, an entry id or a message id. Undefined when none is loaded. */
function coreOfRow(entries: ReadonlyArray<TimelineEntry>, id: string): VisibleCore | undefined {
  const entry = entries.find(
    (candidate) =>
      candidate.id === id || (candidate.kind === "message" && candidate.message.id === id),
  );
  return entry && foldTimeline(entries).cores.find((candidate) => candidate.id === entry.id);
}

/**
 * The first message of the sub-thread that holds the reply `id`. Null when `id` is not a loaded
 * reply: a first message, a row of no sub-thread, or no row.
 */
export function subThreadOfReply(entries: ReadonlyArray<TimelineEntry>, id: string): string | null {
  const core = coreOfRow(entries, id);
  return core?.reply === true ? core.first : null;
}

/**
 * Whether the row `id` shows in one view of a thread with sub-threads: the main list when
 * `subThread` is null, else the sub-thread of that first message. `elsewhere` is a loaded message
 * that only another view shows; `unknown` is a row that is not loaded, or is no message.
 */
export function rowShownIn(
  entries: ReadonlyArray<TimelineEntry>,
  id: string,
  subThread: string | null,
): "here" | "elsewhere" | "unknown" {
  const core = coreOfRow(entries, id);
  if (core === undefined) return "unknown";
  if (subThread === null) return core.reply ? "elsewhere" : "here";
  return core.first === subThread ? "here" : "elsewhere";
}

/**
 * Returns the rows that a display mode draws, or `entries` itself when no row changes. A completed
 * send is a reply with its latest text, but in Normal a Normal-mode send keeps upstream's row. A
 * replace call has no row. A mode without sub-threads keeps all other rows. A mode with
 * sub-threads draws the first messages, or with `subThread`, that first message and its replies.
 */
export function applyDisplayMode(
  mode: DisplayMode,
  entries: ReadonlyArray<TimelineEntry>,
  subThread: string | null = null,
): ReadonlyArray<TimelineEntry> {
  const { events, cores, editedAt } = foldTimeline(entries);
  const coreTexts = new Map(cores.map((core) => [core.id, core.text]));
  const shownIds = mode.subThreads
    ? new Set(
        cores
          .filter((core) => (subThread === null ? !core.reply : core.first === subThread))
          .map((core) => core.id),
      )
    : null;
  const rows = entries.flatMap((entry, index): TimelineEntry[] => {
    if (shownIds !== null && !shownIds.has(entry.id)) return [];
    const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
    if (item !== undefined && isReplaceSendCall(item)) return [];
    const event = events[index];
    if (event?.type !== "sent") return [entry];
    const text = coreTexts.get(entry.id) ?? event.text;
    if (entry.kind === "sent-message" && shownIds === null) return [sentWithText(entry, text)];
    return [replyEntry(entry, text, editedAt.get(entry.id), shownIds === null)];
  });
  return rows.length === entries.length && rows.every((row, index) => row === entries[index])
    ? entries
    : rows;
}

/**
 * A mode that chooses its replies draws no Working or Thinking row, and marks an agent message
 * drawn right after another one, with no user message between, so a rule can part the two.
 */
export function displayModeRows(
  rows: MessagesTimelineRow[],
  repliesChosen: boolean,
): MessagesTimelineRow[] {
  if (!repliesChosen) return rows;
  let afterAgent = false;
  return rows.flatMap((row): MessagesTimelineRow[] => {
    if (row.kind === "working" || row.kind === "thinking") return [];
    if (row.kind !== "message") return [row];
    const fromAgent = row.message.role === "assistant";
    const follows = fromAgent && afterAgent;
    afterAgent = fromAgent;
    return [follows ? { ...row, followsAgentMessage: true } : row];
  });
}
