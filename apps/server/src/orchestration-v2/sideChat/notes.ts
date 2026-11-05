import {
  SIDE_CHAT_NOTE_MAX_CHARS,
  SIDE_CHAT_SUMMARIZER_INPUT_BUDGET_CHARS,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import {
  sanitizeSideChatText,
  splitsSurrogatePair,
} from "@t3tools/provider-core/server/textGenerationUtils";

import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";

const ELLIPSIS = "…";

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

interface SideChatNoteEntry {
  readonly label: string;
  readonly note: string;
}

const NOTE_BULLET = "• ";

const noteLine = ({ label, note }: SideChatNoteEntry): string =>
  `${NOTE_BULLET}re "${oneLine(label)}": ${oneLine(note)}`;

/** First line of the context handoff that carries side-chat notes into the lesson. */
export const SIDE_CHAT_NOTES_HEADER =
  "Side-chat notes (the user asked about these separately; don't reply to them directly):";

/** The handoff text for the lesson: the header, then one `• re "<label>": <note>` line per note. */
export function buildSideChatNotesSummaryText(notes: ReadonlyArray<SideChatNoteEntry>): string {
  return [SIDE_CHAT_NOTES_HEADER, ...notes.map(noteLine)].join("\n");
}

/** True only for a handoff built by `buildSideChatNotesSummaryText`; other manual handoffs differ. */
export function isSideChatNotesHandoff(
  handoff: Pick<OrchestrationV2ContextHandoff, "strategy" | "history" | "summaryText">,
): boolean {
  return (
    handoff.strategy === "manual_context" &&
    handoff.history === undefined &&
    handoff.summaryText.startsWith(`${SIDE_CHAT_NOTES_HEADER}\n`)
  );
}

/** One-line note of at most `SIDE_CHAT_NOTE_MAX_CHARS`; empty or "null"-like answers are no note. */
export function normalizeSideChatNote(text: string | null): string | null {
  return sanitizeSideChatText(text === null ? null : oneLine(text), SIDE_CHAT_NOTE_MAX_CHARS);
}

/**
 * Whether a message is one a person sent in the side chat, as opposed to a scheduled run, a
 * notification, a delegated-task completion or a native maintenance command.
 */
export function isUserAuthoredSideChatTrigger(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "scheduledTaskId" | "notification" | "text" | "attachments"
  > & { readonly delegatedCompletion?: unknown },
): boolean {
  return (
    message.createdBy === "user" &&
    message.scheduledTaskId === undefined &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    !isNativeMaintenanceCommand(message)
  );
}

/** First line of the note writer's input, above the highlighted passage. */
export const SIDE_CHAT_OUTCOME_EXCERPT_HEADER = "Highlighted passage the learner asked about:";

const TRANSCRIPT_HEADER = "Side chat transcript:";
const CHILD_NOTES_HEADER = "Notes from nested side chats:";
const PREVIOUS_NOTE_HEADER =
  "Note already sent to the lesson for this side chat (write only what is new; otherwise reply null):";

/** `line` cut to at most `maxChars` UTF-16 units, keeping its start and ending in an ellipsis. */
function clipLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  if (maxChars <= 0) return "";
  const end = maxChars - ELLIPSIS.length;
  return `${line.slice(0, splitsSurrogatePair(line, end) ? end - 1 : end)}${ELLIPSIS}`;
}

const omittedMarker = (count: number): string => `[… ${count} earlier messages omitted …]`;

/**
 * The transcript entries that fit in `budget` characters, each costing its length plus the
 * newline before it. All of them when they fit. Otherwise the first entry (clipped to a quarter
 * of the budget) and an omitted marker, then as many of the newest entries as fit. When not even
 * the newest fits, only that entry, clipped.
 */
function fitTranscript(entries: ReadonlyArray<string>, budget: number): ReadonlyArray<string> {
  const cost = (entry: string): number => entry.length + 1;
  if (entries.reduce((total, entry) => total + cost(entry), 0) <= budget) return entries;
  const first = entries[0];
  const newest = entries.at(-1);
  if (first === undefined || newest === undefined || budget <= 1) return [];
  if (entries.length === 1) return [clipLine(newest, budget - 1)];

  const head = clipLine(first, Math.floor(budget / 4));
  // The marker's count is at most `entries.length - 1`, so that count's width is the widest.
  let remaining = budget - cost(head) - cost(omittedMarker(entries.length - 1));
  const tail: Array<string> = [];
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    const entry = entries[index] ?? "";
    if (cost(entry) > remaining) break;
    tail.unshift(entry);
    remaining -= cost(entry);
  }
  if (tail.length === 0) return [clipLine(newest, budget - 1)];
  const omitted = entries.length - 1 - tail.length;
  return omitted > 0 ? [head, omittedMarker(omitted), ...tail] : [head, ...tail];
}

interface NestedSideChatNotes {
  readonly childNotes: ReadonlyArray<SideChatNoteEntry>;
  /**
   * The side chat's own context handoffs. Nested notes its turns took reached only its AI, so they
   * still go up with its note.
   */
  readonly contextHandoffs?: ReadonlyArray<
    Pick<OrchestrationV2ContextHandoff, "strategy" | "history" | "summaryText">
  >;
  /** Lines the lesson already received in one of the side chat's notes. */
  readonly delivered?: ReadonlyArray<string>;
}

/** The `• re "<label>": <note>` line of every nested note the lesson lacks, without repeats. */
export function nestedSideChatNoteLines(input: NestedSideChatNotes): ReadonlySet<string> {
  const delivered = new Set(input.delivered);
  return new Set(
    [
      ...(input.contextHandoffs ?? [])
        .filter(isSideChatNotesHandoff)
        .flatMap((handoff) => handoff.summaryText.split("\n").slice(1)),
      ...input.childNotes.map(noteLine),
    ].filter((line) => !delivered.has(line)),
  );
}

/**
 * The nested notes as one note, `re "<label>": <note>` joined with "; ", or null when there are
 * none. It stands in for a writer that answered null while the lesson has none of the side chat's
 * notes, so a nested point never hangs on the writer's judgment.
 */
export function nestedSideChatNotesFallback(input: NestedSideChatNotes): string | null {
  const notes = [...nestedSideChatNoteLines(input)].map((line) =>
    line.startsWith(NOTE_BULLET) ? line.slice(NOTE_BULLET.length) : line,
  );
  return notes.length === 0 ? null : normalizeSideChatNote(notes.join("; "));
}

/**
 * What the note writer reads: the highlighted passage, the side chat's transcript, notes from its
 * nested side chats and the note already sent to the lesson. The transcript gets the budget left
 * after the other sections, so a long chat keeps its opening question and its latest messages.
 */
export function buildSideChatOutcomeInput(
  input: NestedSideChatNotes & {
    readonly excerpt: string;
    readonly messages: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly text: string;
    }>;
    readonly previousNote: string | null;
    readonly budgetChars?: number;
  },
): string {
  const budget = input.budgetChars ?? SIDE_CHAT_SUMMARIZER_INPUT_BUDGET_CHARS;
  const childNoteLines = nestedSideChatNoteLines(input);
  const before = [SIDE_CHAT_OUTCOME_EXCERPT_HEADER, input.excerpt, "", TRANSCRIPT_HEADER];
  const after = [
    ...(childNoteLines.size === 0 ? [] : ["", CHILD_NOTES_HEADER, ...childNoteLines]),
    ...(input.previousNote === null ? [] : ["", PREVIOUS_NOTE_HEADER, input.previousNote]),
  ];
  const transcript = fitTranscript(
    input.messages.map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`),
    Math.max(0, budget - [...before, ...after].join("\n").length),
  );
  return [...before, ...transcript, ...after].join("\n");
}
