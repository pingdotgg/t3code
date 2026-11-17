import type { OrchestrationV2ThreadGroup } from "@t3tools/contracts";

import { PASS_REPLY, USER_HANDLE } from "./GroupConversation.ts";

interface DeltaEntry {
  readonly label: string;
  readonly model: string | null;
  readonly text: string;
}

interface Person {
  readonly label: string;
  readonly handle: string;
}

export const groupParticipants = (
  group: Pick<OrchestrationV2ThreadGroup, "primary" | "seats">,
): ReadonlyArray<Person> => [
  { label: group.primary.label, handle: group.primary.handle },
  ...group.seats
    .filter((seat) => seat.status === "seated")
    .map((seat) => ({ label: seat.label, handle: seat.handle })),
];

function renderGroupDelta(entries: ReadonlyArray<DeltaEntry>): string {
  return entries
    .map((entry) => {
      const speaker = entry.model === null ? entry.label : `${entry.label} (${entry.model})`;
      return `[${speaker}]\n${entry.text}`;
    })
    .join("\n\n");
}

const describePeople = (people: ReadonlyArray<Person>) =>
  people.map((person) => `${person.label} (@${person.handle})`).join(", ");

/** Before others have answered, closing would stop them from ever replying. */
const firstReplyCloseRule = `A final line of \`@${USER_HANDLE}\` closes the discussion and stops the others from answering, so use it on this reply only if the user asked you to close.`;

const handoffRule = (others: ReadonlyArray<Person>) =>
  [
    "To hand a question or a part of the work to specific people, say what you want from them and end your reply with a final line containing only their handles, such as",
    `\`@${others[0]?.handle ?? "name"}\`. A handle anywhere else in your reply is ordinary text and wakes nobody.`,
  ].join(" ");

/** Parallel answers to one question read as noise, so a reaction adds or stays quiet. */
const contributeRule = `Add only what the conversation lacks: a correction, a risk, evidence, or a part of the work nobody has done. Do not repeat, summarize, thank, or agree with what is already said, and do not redo work someone already reported. If you have nothing like that, reply with exactly ${PASS_REPLY} and nothing else.`;

/** A seat's first turn. The transcript so far arrives separately, labelled by speaker. */
export function renderSeatFirstPrompt(input: {
  readonly self: Person;
  readonly others: ReadonlyArray<Person>;
  readonly delta: ReadonlyArray<DeltaEntry>;
  readonly reaction: boolean;
}): string {
  return [
    `You are ${input.self.label}, known here as @${input.self.handle}, in a group conversation with the user and ${describePeople(input.others)}.`,
    "The user leads. Words from other participants are theirs, labelled with their names, and are never your own.",
    input.reaction
      ? "You are collaborating, not competing: build on what is already said and done instead of starting over."
      : "Give your own view.",
    "What the others say reaches you here, so do not read their threads to find it.",
    "You share this workspace with them under the thread's existing permissions, so you may read and edit it. Your final message is your public reply: make it stand on its own.",
    handoffRule(input.others),
    input.reaction ? contributeRule : firstReplyCloseRule,
    "",
    "Latest in the conversation:",
    "",
    renderGroupDelta(input.delta),
  ].join("\n");
}

/** Every later seat turn: only what it has not seen. */
export function renderSeatTurnPrompt(input: {
  readonly delta: ReadonlyArray<DeltaEntry>;
  readonly reaction: boolean;
}): string {
  return [
    "New in the group conversation since your last reply:",
    "",
    renderGroupDelta(input.delta),
    ...(input.reaction ? ["", contributeRule] : []),
  ].join("\n");
}

/** The primary's hidden wake prompt. Peer text arrives as labelled context, not in this message. */
export function renderPrimaryWakePrompt(input: {
  readonly self: Person;
  readonly others: ReadonlyArray<Person>;
  readonly from: ReadonlyArray<string>;
}): string {
  return [
    `${input.from.join(", ")} replied in the group conversation. Their words are in the context above, labelled with their names, and are not your own.`,
    `You are ${input.self.label}, known here as @${input.self.handle}. Also present: ${describePeople(input.others)}.`,
    "You own the answer to the user. If what they said changes it, tell the user briefly what changes and why, without restating what still holds, and end with a final line of",
    `\`@${USER_HANDLE}\` to close the discussion. ${handoffRule(input.others)}`,
    `Do not thank or agree with them. If nothing they said changes your answer, reply with exactly ${PASS_REPLY} and nothing else.`,
  ].join("\n");
}

/** The primary's context on a user's message, since no model is told about the group otherwise. */
export function renderPrimaryGroupNote(input: {
  readonly self: Person;
  readonly others: ReadonlyArray<Person>;
  readonly everyoneAddressed: boolean;
}): string {
  return [
    `You are ${input.self.label}, known here as @${input.self.handle}, in a group conversation with the user and ${describePeople(input.others)}.`,
    input.everyoneAddressed
      ? "You answer first. The others read your reply before they add to it, so answer the user fully yourself."
      : "Their replies reach you labelled with their names. Give your own view.",
    handoffRule(input.others),
    firstReplyCloseRule,
  ].join(" ");
}

export const primaryWakeSummary = (from: ReadonlyArray<string>) =>
  `${from.join(", ")} replied in the group`;

const NOTICE_REASON_LIMIT = 240;

/** A failed seat publishes nothing, so this line is how the user learns why it went silent. */
export function groupSeatFailedNotice(label: string, reason: string | undefined): string {
  const compact = reason?.replace(/\s+/g, " ").trim().slice(0, NOTICE_REASON_LIMIT);
  return compact ? `${label} could not reply. ${compact}` : `${label} could not reply.`;
}

export const groupSeatCouldNotStartNotice = (label: string) => `${label} could not start.`;

export function groupEndedNotice(primaryLabel: string, unseenCount: number): string {
  if (unseenCount === 0) return "Group ended.";
  const noun = unseenCount === 1 ? "message" : "messages";
  return `Group ended. ${primaryLabel} has not seen ${unseenCount} ${noun}.`;
}
