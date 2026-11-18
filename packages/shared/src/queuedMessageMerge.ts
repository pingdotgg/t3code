import {
  type ChatAttachment,
  COMPOSER_CONTEXT_MAX_RECORDS,
  type ComposerContextRecord,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationMessageContext,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import {
  isAttachmentOnlyBootstrapPrompt,
  restoreAttachmentOnlyBootstrapPrompt,
} from "./composerContextReferences.ts";
import { isSlashCommandText, modelSelectionsEqual } from "./model.ts";

export interface QueuedMessageMergePart {
  readonly run: Pick<
    OrchestrationV2Run,
    | "modelSelection"
    | "freshContext"
    | "sourcePlanRef"
    | "restartContinuationOfRunId"
    | "usageLimitContinuationOfRunId"
    | "delegatedTaskId"
  >;
  readonly message?:
    | Pick<
        OrchestrationV2ConversationMessage,
        | "text"
        | "attachments"
        | "context"
        | "createdBy"
        | "scheduledTaskId"
        | "senderThreadId"
        | "idleCompaction"
        | "workflowScript"
        | "delegatedCompletion"
        | "notification"
      >
    | undefined;
}

export type QueuedMessageMergeBlockedKind =
  | "tooFew"
  | "loading"
  | "guest"
  | "automated"
  | "command"
  | "freshContext"
  | "continuation"
  | "delegatedFollowup"
  | "modelMismatch"
  | "sharedAttachment"
  | "tooManyAttachments"
  | "imagesTooLarge"
  | "conflictingContext"
  | "tooMuchContext"
  | "tooLong";

interface QueuedMessageMergeBlocked {
  readonly _tag: "Blocked";
  readonly kind: QueuedMessageMergeBlockedKind;
  readonly reason: string;
}

export type QueuedMessageMerge =
  | {
      readonly _tag: "Merged";
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      readonly context: OrchestrationMessageContext | undefined;
    }
  | QueuedMessageMergeBlocked;

const ULTRATHINK_PREFIX = /^Ultrathink:\s*/i;

const blocked = (
  kind: QueuedMessageMergeBlockedKind,
  reason: string,
): QueuedMessageMergeBlocked => ({
  _tag: "Blocked",
  kind,
  reason,
});

function partBlocked(
  part: QueuedMessageMergePart,
  first: QueuedMessageMergePart,
): QueuedMessageMergeBlocked | null {
  const { run, message } = part;
  if (message === undefined) return blocked("loading", "Some queued messages are still loading.");
  if (message.context?.guest !== undefined) {
    return blocked("guest", "A guest's message can't be combined with others.");
  }
  if (
    message.createdBy !== "user" ||
    message.scheduledTaskId !== undefined ||
    message.senderThreadId !== undefined ||
    message.idleCompaction !== undefined ||
    message.workflowScript === true ||
    message.delegatedCompletion !== undefined ||
    message.notification !== undefined
  ) {
    return blocked("automated", "Messages from agents and automations are sent on their own.");
  }
  if (isSlashCommandText(message.text)) {
    return blocked("command", "Commands are sent on their own.");
  }
  if (run.freshContext === true) {
    return blocked("freshContext", "A message that starts a fresh session is sent on its own.");
  }
  if (
    run.sourcePlanRef !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    run.usageLimitContinuationOfRunId !== undefined
  ) {
    return blocked("continuation", "Plan and continuation messages are sent on their own.");
  }
  // Absorbed runs are cancelled, which would settle their task while its words still run in the first.
  if (part !== first && run.delegatedTaskId !== undefined) {
    return blocked("delegatedFollowup", "Follow-ups to a delegated task are sent on their own.");
  }
  if (!modelSelectionsEqual(run.modelSelection, first.run.modelSelection)) {
    return blocked("modelMismatch", "Queued messages use different models.");
  }
  return null;
}

export function mergeQueuedMessages(
  parts: ReadonlyArray<QueuedMessageMergePart>,
): QueuedMessageMerge {
  const first = parts[0];
  if (first === undefined || parts.length < 2) {
    return blocked("tooFew", "Queue two or more messages to send them as one.");
  }
  for (const part of parts) {
    const partResult = partBlocked(part, first);
    if (partResult !== null) return partResult;
  }
  const messages = parts.flatMap(({ message }) => (message === undefined ? [] : [message]));
  const attachments = messages.flatMap((message) => message.attachments);
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
    return blocked("sharedAttachment", "Queued messages share an attachment.");
  }
  const attachmentLimitError = getProviderAttachmentLimitError(attachments);
  if (attachmentLimitError !== undefined) {
    return blocked(
      attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ? "tooManyAttachments"
        : "imagesTooLarge",
      attachmentLimitError,
    );
  }
  const recordsById = new Map<ComposerContextRecord["contextId"], ComposerContextRecord>();
  for (const record of messages.flatMap((message) => message.context?.records ?? [])) {
    const previous = recordsById.get(record.contextId);
    if (previous !== undefined && !Equal.equals(previous, record)) {
      return blocked("conflictingContext", "Queued messages have conflicting context.");
    }
    recordsById.set(record.contextId, record);
  }
  const records = [...recordsById.values()];
  if (records.length > COMPOSER_CONTEXT_MAX_RECORDS) {
    return blocked("tooMuchContext", "Queued messages carry too much context to send as one.");
  }
  const ultrathink = messages.some((message) => ULTRATHINK_PREFIX.test(message.text));
  const body = messages
    .map((message) => message.text.replace(ULTRATHINK_PREFIX, ""))
    .map((text) => (isAttachmentOnlyBootstrapPrompt(text) ? "" : text.trim()))
    .filter((text) => text.length > 0)
    .join("\n\n");
  const text = restoreAttachmentOnlyBootstrapPrompt(
    ultrathink ? `Ultrathink:\n${body}` : body,
    attachments.length > 0,
  );
  if (text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
    return blocked("tooLong", "Queued messages are too long to send as one.");
  }
  return {
    _tag: "Merged",
    text,
    attachments,
    context: messages.some((message) => message.context !== undefined)
      ? { version: 1, records }
      : undefined,
  };
}
