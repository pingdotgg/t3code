import {
  type ChatAttachment,
  COMPOSER_CONTEXT_MAX_RECORDS,
  getProviderAttachmentLimitError,
  type OrchestrationMessageContext,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

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

export type QueuedMessageMerge =
  | {
      readonly _tag: "Merged";
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      readonly context: OrchestrationMessageContext | undefined;
    }
  | { readonly _tag: "Blocked"; readonly reason: string };

const ULTRATHINK_PREFIX = /^Ultrathink:\s*/i;

function partBlockedReason(
  part: QueuedMessageMergePart,
  first: QueuedMessageMergePart,
): string | null {
  const { run, message } = part;
  if (message === undefined) return "Some queued messages are still loading.";
  if (message.context?.guest !== undefined) {
    return "A guest's message can't be combined with others.";
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
    return "Messages from agents and automations are sent on their own.";
  }
  if (isSlashCommandText(message.text)) return "Commands are sent on their own.";
  if (run.freshContext === true) {
    return "A message that starts a fresh session is sent on its own.";
  }
  if (
    run.sourcePlanRef !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    run.usageLimitContinuationOfRunId !== undefined
  ) {
    return "Plan and continuation messages are sent on their own.";
  }
  if (!modelSelectionsEqual(run.modelSelection, first.run.modelSelection)) {
    return "Queued messages use different models.";
  }
  return null;
}

export function mergeQueuedMessages(
  parts: ReadonlyArray<QueuedMessageMergePart>,
): QueuedMessageMerge {
  const first = parts[0];
  if (first === undefined || parts.length < 2) {
    return { _tag: "Blocked", reason: "Queue two or more messages to send them as one." };
  }
  for (const part of parts) {
    const reason = partBlockedReason(part, first);
    if (reason !== null) return { _tag: "Blocked", reason };
  }
  const messages = parts.flatMap(({ message }) => (message === undefined ? [] : [message]));
  const attachments = messages.flatMap((message) => message.attachments);
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
    return { _tag: "Blocked", reason: "Queued messages share an attachment." };
  }
  const attachmentLimitError = getProviderAttachmentLimitError(attachments);
  if (attachmentLimitError !== undefined) return { _tag: "Blocked", reason: attachmentLimitError };
  const records = [
    ...new Map(
      messages
        .flatMap((message) => message.context?.records ?? [])
        .map((record) => [record.contextId, record] as const),
    ).values(),
  ];
  if (records.length > COMPOSER_CONTEXT_MAX_RECORDS) {
    return { _tag: "Blocked", reason: "Queued messages carry too much context to send as one." };
  }
  const ultrathink = messages.some((message) => ULTRATHINK_PREFIX.test(message.text));
  const body = messages
    .map((message) => message.text.replace(ULTRATHINK_PREFIX, ""))
    .map((text) => (isAttachmentOnlyBootstrapPrompt(text) ? "" : text.trim()))
    .filter((text) => text.length > 0)
    .join("\n\n");
  return {
    _tag: "Merged",
    text: restoreAttachmentOnlyBootstrapPrompt(
      ultrathink ? `Ultrathink:\n${body}` : body,
      attachments.length > 0,
    ),
    attachments,
    context: messages.some((message) => message.context !== undefined)
      ? { version: 1, records }
      : undefined,
  };
}
