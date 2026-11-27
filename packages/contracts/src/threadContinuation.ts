import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  GitRefName,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ImportedHistory } from "./orchestrationV2.ts";

const ContinuationMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
);

/**
 * Continue a thread in a linked environment. `message`, when given, starts the
 * first turn there; without it the new thread waits for the user.
 */
export const ThreadContinueOnEnvironmentInput = Schema.Struct({
  threadId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  commitAndPush: Schema.Boolean,
  message: Schema.optional(ContinuationMessage),
});
export type ThreadContinueOnEnvironmentInput = typeof ThreadContinueOnEnvironmentInput.Type;

export const ThreadContinueOnEnvironmentResult = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  targetThreadId: ThreadId,
  title: Schema.String,
});
export type ThreadContinueOnEnvironmentResult = typeof ThreadContinueOnEnvironmentResult.Type;

/** What a sending environment hands the receiver to start the continued thread. */
export const ThreadReceiveInput = Schema.Struct({
  repository: Schema.Struct({
    remoteUrl: TrimmedNonEmptyString,
    /** The key of the remote the branch is pushed to, which can be a fork. */
    canonicalKey: TrimmedNonEmptyString,
  }),
  /** The sender's name for that remote. Receivers use their own remote; older ones read this. */
  remoteName: Schema.optional(TrimmedNonEmptyString),
  branch: GitRefName,
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  importedHistory: OrchestrationV2ImportedHistory,
  message: Schema.optional(ContinuationMessage),
  /** The same for every retry of one send, so a retry returns the thread the first one made. */
  requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type ThreadReceiveInput = typeof ThreadReceiveInput.Type;

export const ThreadReceiveResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
});
export type ThreadReceiveResult = typeof ThreadReceiveResult.Type;
