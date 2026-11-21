import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A Bot is a coordinator thread: it keeps notes, leads the crew grouped under it, and is woken
 * when its crew or what it watches reaches a milestone. Home is the Bot for a whole environment.
 * Set when the thread is created; a thread never changes role mid-conversation.
 */
export const ThreadBotConfig = Schema.Struct({
  enabled: Schema.Literal(true),
  /** Crew threads surface only when they need input; their other updates stay quiet. */
  muteChildren: Schema.Boolean,
});
export type ThreadBotConfig = typeof ThreadBotConfig.Type;

export const BotFileKind = Schema.Literals(["notes", "preferences"]);
export type BotFileKind = typeof BotFileKind.Type;

export const BOT_FILE_MAX_CHARS = 64_000;

export const BotFilesReadInput = Schema.Struct({ threadId: ThreadId });
export type BotFilesReadInput = typeof BotFilesReadInput.Type;

export const BotFilesReadResult = Schema.Struct({
  notes: Schema.String,
  preferences: Schema.String,
});
export type BotFilesReadResult = typeof BotFilesReadResult.Type;

export const BotFileWriteInput = Schema.Struct({
  threadId: ThreadId,
  file: BotFileKind,
  contents: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)),
});
export type BotFileWriteInput = typeof BotFileWriteInput.Type;

/** Starts a new Bot seeded with a handoff of `threadId`, which becomes its first crew member. */
export const BotStartInput = Schema.Struct({ threadId: ThreadId });
export type BotStartInput = typeof BotStartInput.Type;

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
 * A thread or workflow run outside a Bot's crew whose milestones wake it until it settles.
 * Crew threads need no watch: they always wake their Bot.
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
  reason: Schema.Literals(["not_a_bot", "too_large", "io", "cannot_start", "launch_failed"]),
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
    }
  }
}
