// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatFileAttachment,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "./attachmentStore.ts";

const THREAD_FORK_TRANSCRIPT_NAME = "conversation-transcript.md";

export function threadForkCreateCommandId(sourceThreadId: ThreadId, threadId: ThreadId): CommandId {
  return CommandId.make(`thread-fork:${threadId}:from:${sourceThreadId}:create`);
}

export function threadForkMessageId(threadId: ThreadId): MessageId {
  return MessageId.make(`thread-fork:${threadId}:handoff`);
}

function deterministicUuid(value: string): string {
  const hex = NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function threadForkAttachmentId(threadId: ThreadId): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  return threadSegment === null
    ? null
    : `${threadSegment}-${deterministicUuid(`thread-fork:${threadId}`)}-md`;
}

export function findThreadForkTranscriptAttachment(
  source: OrchestrationThread,
): ChatFileAttachment | null {
  const message = source.messages.find(
    (candidate) => candidate.id === threadForkMessageId(source.id),
  );
  const expectedAttachmentId = threadForkAttachmentId(source.id);
  if (!message || expectedAttachmentId === null) return null;
  const attachment = (message.attachments ?? []).find(
    (candidate): candidate is ChatFileAttachment =>
      candidate.type === "file" &&
      candidate.id === expectedAttachmentId &&
      candidate.name === THREAD_FORK_TRANSCRIPT_NAME &&
      candidate.mimeType === "text/markdown",
  );
  return attachment ?? null;
}

export function makeThreadForkTranscript(
  source: OrchestrationThread,
  inheritedTranscript?: string,
): string {
  const generatedHandoffMessageId = threadForkMessageId(source.id);
  const messages = source.messages.filter(
    (message): message is OrchestrationMessage & { readonly role: "user" | "assistant" } =>
      (message.role === "user" || message.role === "assistant") &&
      (inheritedTranscript === undefined || message.id !== generatedHandoffMessageId),
  );
  const transcript = messages.map((message) => {
    const attachmentNames = (message.attachments ?? []).map((attachment) => attachment.name);
    return [
      `## ${message.role === "user" ? "USER" : "ASSISTANT"}`,
      message.text,
      ...(attachmentNames.length === 0
        ? []
        : [`[Attachments referenced but not copied: ${attachmentNames.join(", ")}]`]),
    ].join("\n\n");
  });

  return [
    "# T3 Code conversation transcript",
    "",
    `Source thread: ${source.title}`,
    `Source thread ID: ${source.id}`,
    "",
    "This handoff contains persisted user and assistant text in chronological order.",
    "Binary attachments, provider tool activity, hidden provider state, and checkpoints are not copied.",
    "",
    ...(inheritedTranscript === undefined
      ? []
      : [
          "## CONTEXT INHERITED BY THE SOURCE FORK",
          "",
          inheritedTranscript,
          "",
          "## CONTINUATION AFTER THAT FORK",
          "",
        ]),
    ...transcript,
  ].join("\n");
}

export function makeThreadForkAttachment(input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly transcript: string;
}): { readonly attachment: ChatFileAttachment; readonly path: string } | null {
  const id = threadForkAttachmentId(input.threadId);
  if (id === null) return null;
  const sizeBytes = Buffer.byteLength(input.transcript);
  if (sizeBytes === 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) return null;
  const attachment = {
    type: "file" as const,
    id,
    name: THREAD_FORK_TRANSCRIPT_NAME,
    mimeType: "text/markdown",
    sizeBytes,
  } satisfies ChatFileAttachment;
  const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
  return path === null ? null : { attachment, path };
}

export function makeThreadForkHandoffPrompt(source: Pick<OrchestrationThread, "id" | "title">) {
  return [
    `T3 source thread: ${source.id}.`,
    `This conversation was forked from "${source.title}".`,
    `Read the attached ${THREAD_FORK_TRANSCRIPT_NAME} as prior conversation context.`,
    "Do not continue any task yet. Wait for the user's next request.",
  ].join(" ");
}

export function isSameThreadForkModelSelection(
  left: ModelSelection,
  right: ModelSelection,
): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const normalize = (selection: ModelSelection) =>
    [...(selection.options ?? [])]
      .map((option) => `${option.id}:${typeof option.value}:${String(option.value)}`)
      .sort();
  const leftOptions = normalize(left);
  const rightOptions = normalize(right);
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every((option, index) => option === rightOptions[index])
  );
}
