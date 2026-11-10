import { markdownPlainText } from "@t3tools/client-runtime/work-log/presentation";
import type { RunId, ScreenReaderAnnouncements } from "@t3tools/contracts";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import {
  liveWorkEntryLabel,
  timelineEntryRunId,
  timelineEntryStartsResponse,
} from "./MessagesTimeline.logic";

export interface TurnDetail {
  /** The step the agent is on, or null when its newest output is not a step. */
  readonly activity: string | null;
  /** Messages the agent finished and then kept working after, oldest first, as Markdown. */
  readonly messages: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

export const NO_TURN_DETAIL: TurnDetail = { activity: null, messages: [] };

const ACTIVITY_MAX_LENGTH = 120;

function stepLabel(work: WorkLogEntry, workspaceRoot: string | undefined): string | null {
  // Reasoning text is never read out.
  if (work.itemType === "reasoning") return "Thinking";
  const status = work.toolLifecycleStatus;
  if (status === "failed" || status === "declined" || status === "stopped") return null;
  const label = liveWorkEntryLabel(work, workspaceRoot, true).replace(/\s+/g, " ").trim();
  if (label === "") return null;
  // On screen a file change is its path beside an icon.
  const spoken = work.itemType === "file_change" ? `Editing ${label}` : label;
  return spoken.length > ACTIVITY_MAX_LENGTH ? `${spoken.slice(0, ACTIVITY_MAX_LENGTH)}…` : spoken;
}

/**
 * What a screen reader can be told about the latest turn beyond its status.
 * It reads the thread's entries before "Tool calls in chat" hides any, so what
 * is spoken follows the announcement setting alone.
 */
export function turnDetail(
  entries: ReadonlyArray<TimelineEntry>,
  workspaceRoot: string | undefined,
): TurnDetail {
  const messages: Array<TurnDetail["messages"][number]> = [];
  // Runs the agent kept working in after the entry being looked at.
  const continuedRunIds = new Set<RunId | null>();
  let activity: string | null | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (timelineEntryStartsResponse(entry)) break;
    if (entry.kind === "event") continue;
    if (entry.kind === "work") {
      const work = entry.entry;
      // Notices, todo lists and checkpoints sit beside the turn's steps without being one.
      if (work.tone !== "tool" && work.itemType !== "reasoning") continue;
      continuedRunIds.add(work.runId ?? null);
      // A request is spoken as the thread's status; once answered, the step it was for goes on.
      if (work.itemType === "approval_request" || work.itemType === "user_input_request") continue;
      if (activity === undefined) activity = stepLabel(work, workspaceRoot);
      continue;
    }
    if (entry.kind === "message" && entry.message.role !== "assistant") continue;
    // A reply, plan or rendered page is newer than any step before it.
    activity ??= null;
    const runId = timelineEntryRunId(entry);
    if (entry.kind === "message" && !entry.message.streaming && continuedRunIds.has(runId)) {
      messages.push({ id: entry.message.id, text: entry.message.text });
    }
    continuedRunIds.add(runId);
  }
  return { activity: activity ?? null, messages: messages.reverse() };
}

export interface TurnDetailSnapshot extends TurnDetail {
  readonly level: ScreenReaderAnnouncements;
  readonly status: "working" | "approval" | "input" | "idle";
}

export interface TurnDetailMemory {
  readonly activity: string | null;
  readonly spokenMessageIds: ReadonlySet<string>;
}

/** The heading every agent message has in the timeline. */
const MESSAGE_AUTHOR = "T3 Code";

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
    spokenMessageIds: new Set(next.messages.map((message) => message.id)),
  };
  // A turn that already ended is history, however late its entries arrive.
  if (previous === null || next.level === "status" || next.status === "idle") {
    return { memory, messages: [], activity: null };
  }
  return {
    memory,
    messages: next.messages
      .filter((message) => !previous.spokenMessageIds.has(message.id))
      .map((message) => markdownPlainText(message.text))
      .filter((text) => text !== "")
      .map((text) => `${MESSAGE_AUTHOR}: ${text}`),
    activity:
      next.level === "everything" && memory.activity !== previous.activity ? memory.activity : null,
  };
}
