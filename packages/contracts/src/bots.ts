import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * A Bot is a coordinator thread: it keeps notes, leads the workers grouped under it, and is woken
 * when its workers or what it watches reaches a milestone.
 * Set when the thread is created; a thread never changes role mid-conversation.
 */
/** The avatar shapes a Bot can wear, drawn by `open-bot-avatar` on every client. */
const BOT_AVATAR_SHAPES = [
  "controller",
  "barbell",
  "mug",
  "lightbulb",
  "chat",
  "sprout",
  "watering-can",
  "book",
  "brain",
  "bull",
  "bunny",
  "camera",
  "cat",
  "cloud",
  "egg",
  "ghost",
  "magnifier",
  "paint-brush",
  "palette",
  "rocket",
  "shield",
  "star",
  "witch-hat",
] as const;
export const BotAvatarShape = Schema.Literals(BOT_AVATAR_SHAPES);
export type BotAvatarShape = typeof BotAvatarShape.Type;

/** A Bot's chosen avatar: a shape and a `#rrggbb` color. */
export const BotAvatarChoice = Schema.Struct({
  shape: BotAvatarShape,
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
});
export type BotAvatarChoice = typeof BotAvatarChoice.Type;

export const ThreadBotConfig = Schema.Struct({
  enabled: Schema.Literal(true),
  /** Worker threads surface only when they need input; their other updates stay quiet. */
  muteChildren: Schema.Boolean,
  /** Its chat opens with the Bot asking what to look after, and the user's reply is its first turn. */
  greets: Schema.optional(Schema.Literal(true)),
  /** Absent: the avatar is picked from the thread id. */
  avatar: Schema.optional(BotAvatarChoice),
});
export type ThreadBotConfig = typeof ThreadBotConfig.Type;

export const BOT_FILE_MAX_CHARS = 64_000;
export const BOT_NOTE_MAX_COUNT = 200;

/** A note's file name under the Bot's notes folder, without `.md`. */
export const BotNoteSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u, {
    message:
      "A note slug is 1-64 lowercase letters, digits and dashes, starting with a letter or digit.",
  }),
);
export type BotNoteSlug = typeof BotNoteSlug.Type;

const NoteTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));
const NoteSummary = Schema.String.check(Schema.isMaxLength(300));

/** One line of a Bot's memory index: enough to decide whether to read the note. */
export const BotNoteSummary = Schema.Struct({
  slug: BotNoteSlug,
  title: Schema.String,
  summary: Schema.String,
  updatedAt: IsoDateTime,
});
export type BotNoteSummary = typeof BotNoteSummary.Type;

export const BotNote = Schema.Struct({
  ...BotNoteSummary.fields,
  body: Schema.String,
});
export type BotNote = typeof BotNote.Type;

export const BotFilesReadInput = Schema.Struct({ threadId: ThreadId });
export type BotFilesReadInput = typeof BotFilesReadInput.Type;

/** `preferences` is the user's instructions; `notes` is the index of the Bot's notes. */
export const BotFilesReadResult = Schema.Struct({
  preferences: Schema.String,
  notes: Schema.Array(BotNoteSummary),
});
export type BotFilesReadResult = typeof BotFilesReadResult.Type;

export const BotPreferencesWriteInput = Schema.Struct({
  threadId: ThreadId,
  contents: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)),
});
export type BotPreferencesWriteInput = typeof BotPreferencesWriteInput.Type;

export const BotNoteReadInput = Schema.Struct({ threadId: ThreadId, slug: BotNoteSlug });
export type BotNoteReadInput = typeof BotNoteReadInput.Type;

export const BotNoteWriteFields = {
  slug: BotNoteSlug,
  title: NoteTitle,
  summary: NoteSummary,
  body: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)),
};
export const BotNoteWriteInput = Schema.Struct({ threadId: ThreadId, ...BotNoteWriteFields });
export type BotNoteWriteInput = typeof BotNoteWriteInput.Type;

export const BotNoteDeleteInput = BotNoteReadInput;
export type BotNoteDeleteInput = typeof BotNoteDeleteInput.Type;

/** Starts a new Bot seeded with a handoff of `threadId`, which becomes its first worker. */
export const BotStartInput = Schema.Struct({ threadId: ThreadId });
export type BotStartInput = typeof BotStartInput.Type;

/** Starts a new Bot with no source thread. `instructions` seeds its preferences.md. */
export const BotCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  instructions: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)),
  modelSelection: ModelSelection,
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotStartResult = Schema.Struct({ threadId: ThreadId });
export type BotStartResult = typeof BotStartResult.Type;

/** `launched`: a workflow run the Bot started. `manual`: asked for. */
export const BotWatchReason = Schema.Literals(["launched", "manual"]);
export type BotWatchReason = typeof BotWatchReason.Type;

const BotWatchFields = {
  /** Absent means this environment. */
  environmentId: Schema.optionalKey(EnvironmentId),
  reason: BotWatchReason,
  addedAt: IsoDateTime,
};

export const BotThreadWatch = Schema.Struct({ threadId: ThreadId, ...BotWatchFields });
export const BotWorkflowRunWatch = Schema.Struct({
  workflowRunId: TrimmedNonEmptyString,
  ...BotWatchFields,
});

/**
 * A thread or workflow run, other than a Bot's workers, whose milestones wake it until it settles.
 * Worker threads need no watch: they always wake their Bot.
 */
export const BotWatch = Schema.Union([BotThreadWatch, BotWorkflowRunWatch]);
export type BotWatch = typeof BotWatch.Type;

export const BotWatchTarget = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({ workflowRunId: TrimmedNonEmptyString }),
]);
export type BotWatchTarget = typeof BotWatchTarget.Type;

export const botWatchKey = (target: BotWatchTarget): string =>
  "threadId" in target ? `thread:${target.threadId}` : `workflow:${target.workflowRunId}`;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  threadId: ThreadId,
  reason: Schema.Literals([
    "not_a_bot",
    "too_large",
    "io",
    "cannot_start",
    "launch_failed",
    "note_not_found",
    "too_many_notes",
  ]),
  /** Why a Bot cannot start from the thread; safe to show. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_a_bot":
        return `Thread ${this.threadId} is not a Bot.`;
      case "too_large":
        return `A Bot file holds at most ${BOT_FILE_MAX_CHARS} characters.`;
      case "io":
        return `Failed to read or save the Bot files for thread ${this.threadId}.`;
      case "cannot_start":
        return this.detail ?? `A Bot cannot start from thread ${this.threadId}.`;
      case "launch_failed":
        return `The Bot for thread ${this.threadId} could not be started.`;
      case "note_not_found":
        return this.detail ?? "That note does not exist.";
      case "too_many_notes":
        return `A Bot keeps at most ${BOT_NOTE_MAX_COUNT} notes. Merge or delete some first.`;
    }
  }
}
