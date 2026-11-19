import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * `/improve <prompt>`: one model rewrites the prompt with the thread's context, then a new
 * thread opens on the destination model with the rewrite as its first message. Jobs persist
 * by `requestId`, so a retry continues the same job instead of opening a second thread.
 */
export const ImproveRequestId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{8,80}$/),
);
export type ImproveRequestId = typeof ImproveRequestId.Type;

export const ImprovePhase = Schema.Literals([
  "rewriting",
  "rewritten",
  "launching",
  "launched",
  "failed",
]);
export type ImprovePhase = typeof ImprovePhase.Type;

export const ImproveJob = Schema.Struct({
  requestId: ImproveRequestId,
  sourceThreadId: ThreadId,
  originalPrompt: Schema.String,
  improvedPrompt: Schema.NullOr(Schema.String),
  /** The context handed to the new thread with the prompt. */
  contextSummary: Schema.NullOr(Schema.String),
  improver: ModelSelection,
  destination: ModelSelection,
  phase: ImprovePhase,
  failedStep: Schema.NullOr(Schema.Literals(["rewrite", "launch"])),
  error: Schema.NullOr(Schema.String),
  newThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ImproveJob = typeof ImproveJob.Type;

export const ImproveStartInput = Schema.Struct({
  requestId: ImproveRequestId,
  sourceThreadId: ThreadId,
  prompt: TrimmedNonEmptyString,
  improver: ModelSelection,
  destination: ModelSelection,
});
export type ImproveStartInput = typeof ImproveStartInput.Type;

export const ImproveRetryInput = Schema.Struct({
  requestId: ImproveRequestId,
  /** A failed rewrite may switch models; a launch retry keeps the finished rewrite. */
  improver: Schema.optionalKey(ModelSelection),
  destination: Schema.optionalKey(ModelSelection),
  /** The user's edit of the rewrite before launching it. */
  improvedPrompt: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ImproveRetryInput = typeof ImproveRetryInput.Type;

export const ImproveListInput = Schema.Struct({ sourceThreadId: ThreadId });
export type ImproveListInput = typeof ImproveListInput.Type;

export const ImproveDismissInput = Schema.Struct({ requestId: ImproveRequestId });
export type ImproveDismissInput = typeof ImproveDismissInput.Type;

export class ImproveError extends Schema.TaggedError<ImproveError>()("ImproveError", {
  message: Schema.String,
}) {}
