import type { RunId, ScreenReaderAnnouncements } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { searchToolLabelParts } from "@t3tools/shared/toolActivity";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import {
  liveWorkEntryLabel,
  timelineEntryRunId,
  timelineEntryStartsResponse,
} from "./MessagesTimeline.logic";
import { markdownPlainText } from "./timelineMinimapItems";
import { appName } from "@t3tools/shared/appName";

export interface TurnMessage {
  readonly id: string;
  /** Markdown. */
  readonly text: string;
  /** The agent stopped writing it and went on working. A turn's closing reply never is. */
  readonly finished: boolean;
  /** It arrived after the entry the caller last saw, unlike history loaded above it. */
  readonly fresh: boolean;
}

export interface TurnDetail {
  /** The step the agent is on, or null when its newest output is not a step. */
  readonly activity: string | null;
  /** The agent's messages in the latest turn, oldest first. */
  readonly messages: ReadonlyArray<TurnMessage>;
  /** The thread's newest entry. */
  readonly tailId: string | null;
}

export const NO_TURN_DETAIL: TurnDetail = { activity: null, messages: [], tailId: null };

const ACTIVITY_MAX_LENGTH = 120;
// Parsing is synchronous, and nobody listens to a longer message through a live region.
const MESSAGE_MAX_LENGTH = 2_000;

/** The first `maxLength` code points of `text`, or null when it has no more than that. */
function cutText(text: string, maxLength: number): string | null {
  if (text.length <= maxLength) return null;
  const characters = Array.from(text);
  return characters.length > maxLength ? characters.slice(0, maxLength).join("") : null;
}

// The app builds these labels as a whole "Searched ..." sentence: a web search from its search
// parts, a file search without a provider title from its parts or as "Searched files".
function appLabelledSearch(work: WorkLogEntry): boolean {
  const data = work.toolData;
  const record =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  if (work.itemType === "file_search") {
    return typeof record?.title !== "string" || record.title.trim() === "";
  }
  const { query, glob, target } = searchToolLabelParts(record);
  return Boolean(query || glob || target);
}

// On screen these labels are a path or a query beside an icon.
function withVerb(work: WorkLogEntry, label: string) {
  if (work.itemType === "file_change") return m(msg("Editing {label}", { label }));
  if (work.itemType !== "file_search" && work.itemType !== "web_search") return label;
  if (appLabelledSearch(work)) return label;
  // Labels that did not come from the search parts are provider text, which stays English.
  if (/^search(?:ed|ing)?\s/i.test(label)) return label;
  return work.itemType === "web_search"
    ? m(msg("Searching the web for {label}", { label }))
    : m(msg("Searching for {label}", { label }));
}

type MessageEntry = Extract<TimelineEntry, { kind: "message" }>;

// A steer starts a new attempt in the same run. The reply it cut off also stops streaming,
// so only one that completed before the steer finished; see completeSupersededReplyEntryIds.
function completedBeforeSuperseded(entry: MessageEntry) {
  const item = entry.projectedItem?.item;
  const supersededAt = entry.attempt?.completedAt ?? null;
  return (
    item?.type === "assistant_message" &&
    item.status === "completed" &&
    item.completedAt !== null &&
    supersededAt !== null &&
    DateTime.isLessThan(item.completedAt, supersededAt)
  );
}

function stepLabel(work: WorkLogEntry, workspaceRoot: string | undefined): string | null {
  // Reasoning text is never read out.
  if (work.itemType === "reasoning") return m(msg("Thinking"));
  const status = work.toolLifecycleStatus;
  if (status === "failed" || status === "declined" || status === "stopped") return null;
  const label = liveWorkEntryLabel(work, workspaceRoot, true).replace(/\s+/g, " ").trim();
  if (label === "") return null;
  const spoken = withVerb(work, label);
  const cut = cutText(spoken, ACTIVITY_MAX_LENGTH);
  return cut === null ? spoken : `${cut}…`;
}

/**
 * What a screen reader can be told about the latest turn beyond its status.
 * It reads the thread's entries before "Tool calls in chat" hides any, so what
 * is spoken follows the announcement setting alone.
 */
export function turnDetail(
  entries: ReadonlyArray<TimelineEntry>,
  workspaceRoot: string | undefined,
  knownTailId: string | null,
): TurnDetail {
  const messages: TurnMessage[] = [];
  // Runs and attempts the agent kept working in after the entry being looked at.
  const continuedRunIds = new Set<RunId | null>();
  const continuedAttemptIds = new Set<string>();
  const markContinued = (entry: TimelineEntry, runId: RunId | null) => {
    continuedRunIds.add(runId);
    if (entry.attempt !== undefined) continuedAttemptIds.add(entry.attempt.id);
  };
  let activity: string | null | undefined;
  let fresh = true;
  let index = entries.length - 1;
  for (; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (timelineEntryStartsResponse(entry)) break;
    if (entry.id === knownTailId) fresh = false;
    if (entry.kind === "event") continue;
    if (entry.kind === "work") {
      const work = entry.entry;
      if (work.sourceActivityKind === "context-compaction") {
        activity ??= work.toolLifecycleStatus === "inProgress" ? work.label : null;
        continue;
      }
      // Notices, todo lists and checkpoints sit beside the turn's steps without being one.
      if (work.tone !== "tool" && work.itemType !== "reasoning") continue;
      markContinued(entry, work.runId ?? null);
      // A request is spoken as the thread's status; once answered, the step it was for goes on.
      if (work.itemType === "approval_request" || work.itemType === "user_input_request") continue;
      if (activity === undefined) activity = stepLabel(work, workspaceRoot);
      continue;
    }
    if (entry.kind === "message" && entry.message.role !== "assistant") continue;
    // A reply, plan or rendered page is newer than any step before it.
    activity ??= null;
    const runId = timelineEntryRunId(entry);
    if (entry.kind === "message") {
      messages.push({
        id: entry.message.id,
        text: entry.message.text,
        finished:
          !entry.message.streaming &&
          continuedRunIds.has(runId) &&
          (entry.attempt?.status !== "superseded" ||
            continuedAttemptIds.has(entry.attempt.id) ||
            completedBeforeSuperseded(entry)),
        fresh,
      });
    }
    markContinued(entry, runId);
  }
  // Nothing is known to be new when the entry last seen is gone, or there was none.
  let tailKnown = !fresh;
  if (knownTailId !== null) {
    for (; !tailKnown && index >= 0; index -= 1) tailKnown = entries[index]!.id === knownTailId;
  }
  return {
    activity: activity ?? null,
    messages: (tailKnown
      ? messages
      : messages.map((message) => ({ ...message, fresh: false }))
    ).reverse(),
    tailId: entries.at(-1)?.id ?? null,
  };
}

export interface TurnDetailSnapshot extends TurnDetail {
  readonly level: ScreenReaderAnnouncements;
  readonly status: "working" | "approval" | "input" | "idle";
}

export interface TurnDetailMemory {
  readonly activity: string | null;
  /** Each message seen in the turn, and whether it was already finished then. */
  readonly messages: ReadonlyMap<string, boolean>;
  readonly tailId: string | null;
}

/** The heading every agent message has in the timeline. */
const MESSAGE_AUTHOR = appName();

/**
 * Decides which of the turn's messages and steps a screen reader hears next.
 * The first snapshot of a thread is a silent baseline, like its status.
 */
export function nextTurnDetailAnnouncement(
  previous: TurnDetailMemory | null,
  next: TurnDetailSnapshot,
): {
  readonly memory: TurnDetailMemory;
  readonly messages: ReadonlyArray<string>;
  readonly activity: string | null;
} {
  const memory: TurnDetailMemory = {
    // A step is spoken again after a pause for an approval or a question.
    activity: next.status === "working" ? next.activity : null,
    messages: new Map(next.messages.map((message) => [message.id, message.finished])),
    tailId: next.tailId,
  };
  // A turn that already ended is history, however late its entries arrive.
  if (previous === null || next.level === "status" || next.status === "idle") {
    return { memory, messages: [], activity: null };
  }
  return {
    memory,
    messages: next.messages
      .filter(
        (message) =>
          message.finished &&
          previous.messages.get(message.id) !== true &&
          (message.fresh || previous.messages.has(message.id)),
      )
      .map((message) => {
        const cut = cutText(message.text, MESSAGE_MAX_LENGTH);
        return cut === null
          ? markdownPlainText(message.text)
          : m(msg("{text} More in the thread.", { text: markdownPlainText(cut) }));
      })
      .filter((text) => text !== "")
      .map((text) => `${MESSAGE_AUTHOR}: ${text}`),
    activity:
      next.level === "everything" && memory.activity !== previous.activity ? memory.activity : null,
  };
}
