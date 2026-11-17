import type {
  OrchestrationV2MessageSpeaker,
  OrchestrationV2Run,
  OrchestrationV2ThreadGroup,
  OrchestrationV2ThreadGroupMember,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import { threadRuntimeIsActive, type ThreadStructureTurnItem } from "./models.ts";

export type ThreadGroup = OrchestrationV2ThreadGroup;
export type ThreadGroupSeat = ThreadGroup["seats"][number];

/** Whom a message reaches. `primary` is whatever model the thread itself runs. */
export type ThreadGroupMember = OrchestrationV2ThreadGroupMember;

export interface ThreadGroupParticipant {
  readonly member: ThreadGroupMember;
  readonly handle: string;
  readonly label: string;
  readonly isPrimary: boolean;
}

type GroupLike = ThreadGroup | null | undefined;

/**
 * Thread events replace the whole thread, so an unchanged group arrives as a new object. Rows
 * keep the old one while this holds, so their memoized markdown does not redraw.
 */
export const sameThreadGroup = (left: GroupLike, right: GroupLike): boolean =>
  left === right || JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const isGroupActive = (group: GroupLike): group is ThreadGroup => group?.status === "active";

/** The server's own rule: a reply is a pass only when it says exactly `PASS`. */
export const isQuietPass = (text: string): boolean => text.trim() === "PASS";

const seatedSeats = (group: GroupLike): ReadonlyArray<ThreadGroupSeat> =>
  group?.seats.filter((seat) => seat.status === "seated") ?? [];

/** Seats run on hidden side chats of their own, so these are not ordinary side chats. */
export const isSeatedSeatThread = (group: GroupLike, threadId: ThreadId): boolean =>
  seatedSeats(group).some((seat) => seat.threadId === threadId);

function listedParticipants(
  group: ThreadGroup,
  seatedOnly: boolean,
): ReadonlyArray<ThreadGroupParticipant> {
  const seats = seatedOnly ? seatedSeats(group) : group.seats;
  return [
    {
      member: "primary",
      handle: group.primary.handle,
      label: group.primary.label,
      isPrimary: true,
    },
    ...seats.map((seat) => ({
      member: seat.threadId,
      handle: seat.handle,
      label: seat.label,
      isPrimary: false,
    })),
  ];
}

/** The primary first, then each seated peer in invite order. */
export function groupParticipants(group: GroupLike): ReadonlyArray<ThreadGroupParticipant> {
  if (group == null) return [];
  return listedParticipants(group, true);
}

// Clients trim before sending, so an address may end the prompt. The lookbehind keeps `me@astra`
// an email address, and `@astra.ts` stays a file mention because only trailing punctuation goes.
const ADDRESS_TOKEN = /(?<=^|[\s(])@(\S+)/g;
const TRAILING_PUNCTUATION = /[.,:;!?)\]}'"]+$/;

export interface GroupMentionOccurrence {
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly member: ThreadGroupMember;
}

export function groupMentionOccurrences(
  text: string,
  group: GroupLike,
  options?: { readonly seatedOnly?: boolean },
): ReadonlyArray<GroupMentionOccurrence> {
  if (group == null) return [];
  const members = listedParticipants(group, options?.seatedOnly === true);
  const byHandle = new Map(members.map((member) => [member.handle.toLowerCase(), member]));
  const [primary] = members;
  if (primary !== undefined) byHandle.set("primary", primary);
  const occurrences: GroupMentionOccurrence[] = [];
  for (const match of text.matchAll(ADDRESS_TOKEN)) {
    const handle = (match[1] ?? "").replace(TRAILING_PUNCTUATION, "");
    const participant = byHandle.get(handle.toLowerCase());
    if (participant === undefined) continue;
    const end = match.index + 1 + handle.length;
    occurrences.push({
      start: match.index,
      end,
      source: text.slice(match.index, end),
      label: participant.label,
      isPrimary: participant.isPrimary,
      member: participant.member,
    });
  }
  return occurrences;
}

/**
 * Who a composer prompt addresses. `@handle` tokens naming a seated member pick them, anything
 * else reaches everyone. Absent while no group is active, so an ordinary thread sends as before.
 */
export function groupAudienceForPrompt(
  group: GroupLike,
  prompt: string,
): "everyone" | ReadonlyArray<ThreadGroupMember> | undefined {
  if (!isGroupActive(group)) return undefined;
  const addressed = new Set<ThreadGroupMember>();
  for (const mention of groupMentionOccurrences(prompt, group, { seatedOnly: true })) {
    addressed.add(mention.member);
  }
  return addressed.size === 0 ? "everyone" : [...addressed];
}

type SeatShell = {
  readonly id: ThreadId;
  readonly runtime: Parameters<typeof threadRuntimeIsActive>[0];
};

export function runningSeats(
  group: GroupLike,
  shellOf: (threadId: ThreadId) => SeatShell | null | undefined,
): ReadonlyArray<ThreadGroupSeat> {
  return seatedSeats(group).filter((seat) =>
    threadRuntimeIsActive(shellOf(seat.threadId)?.runtime),
  );
}

/** Stop and the working state hold while a discussion is open, even when no run is. */
export const groupIsWorking = (group: GroupLike, seatsRunning: number): boolean =>
  group?.discussion != null || seatsRunning > 0;

export interface GroupRowSpeaker {
  readonly label: string;
  readonly model: string;
}

/**
 * Who spoke an assistant row. A peer's row carries its own `speaker`. The primary's rows keep
 * none, so they are named from the run, and only while a group exists to tell them apart.
 */
export function groupRowSpeaker(
  group: GroupLike,
  row: {
    readonly speaker?: OrchestrationV2MessageSpeaker | undefined;
    readonly run?: Pick<OrchestrationV2Run, "modelSelection"> | undefined;
  },
): GroupRowSpeaker | null {
  if (row.speaker !== undefined) return row.speaker;
  const selection = row.run?.modelSelection;
  if (group == null || selection === undefined) return null;
  return {
    label: selection.model === group.primary.model ? group.primary.label : selection.model,
    model: selection.model,
  };
}

/** A trailing `@user` only steers the discussion, so a reader never needs it. */
export function withoutCloseLine(text: string): string {
  const trimmed = text.trimEnd();
  const newline = trimmed.lastIndexOf("\n");
  if (newline < 0 || !/^@user(?:\s+@user)*$/i.test(trimmed.slice(newline + 1).trim())) return text;
  const body = trimmed.slice(0, newline).trimEnd();
  return body || text;
}

/** "Astra had nothing to add", for a reply that was exactly `PASS`. */
export const quietPassLine = (label: string): string => `${label} had nothing to add`;

const ACTIVE_ITEM_STATUSES = new Set<string>(["pending", "running", "waiting"]);
const MAX_ACTIVITY_LENGTH = 48;

const short = (text: string) =>
  text.length > MAX_ACTIVITY_LENGTH ? `${text.slice(0, MAX_ACTIVITY_LENGTH - 1)}…` : text;

/** What an open seat run is doing now, from the newest unfinished item of that run. */
export function seatActivityLabel(
  items: ReadonlyArray<ThreadStructureTurnItem>,
  runId: RunId | null | undefined,
): string {
  const current = items
    .filter((item) => item.runId === runId && ACTIVE_ITEM_STATUSES.has(item.status))
    .reduce<ThreadStructureTurnItem | undefined>(
      (newest, item) => (newest === undefined || item.ordinal > newest.ordinal ? item : newest),
      undefined,
    );
  switch (current?.type) {
    case "command_execution":
      return `running ${short(current.input.trim().split("\n")[0] ?? "a command")}`;
    case "file_change":
      return `editing ${short(current.fileName)}`;
    case "file_search":
      return current.pattern ? `searching ${short(current.pattern)}` : "searching files";
    case "web_search":
      return "searching the web";
    case "approval_request":
      return "waiting for approval";
    case "user_input_request":
      return "waiting for an answer";
    case "reasoning":
      return "thinking";
    case "assistant_message":
      return "writing a reply";
    default:
      return "working";
  }
}
