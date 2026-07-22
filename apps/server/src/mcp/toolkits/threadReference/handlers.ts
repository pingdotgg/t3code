import {
  THREAD_REFERENCE_DEFAULT_MAX_CHARS,
  ThreadReferenceInvalidCursorError,
  ThreadReferenceNotFoundError,
  type ThreadReferenceReadInput,
  type ThreadReferenceReadResult,
  type ThreadReferenceTranscriptMessage,
  ThreadReferenceUnavailableError,
  type EnvironmentId,
  type OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import { collectComposerThreadReferences } from "@t3tools/shared/composerInlineTokens";
import { parseComposerThreadLink } from "@t3tools/shared/composerTrigger";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadReferenceToolkit } from "./tools.ts";

interface TranscriptPosition {
  readonly messageIndex: number;
  readonly textOffset: number;
}

function decodeCursor(
  input: ThreadReferenceReadInput,
  thread: OrchestrationThread,
): TranscriptPosition | null {
  if (!input.cursor) return { messageIndex: 0, textOffset: 0 };
  const cursorMatch = /^(\d+):(\d+)$/.exec(input.cursor);
  if (!cursorMatch) return null;
  const [, messageIndexText, textOffsetText] = cursorMatch;
  const messageIndex = Number(messageIndexText);
  const textOffset = Number(textOffsetText);
  const message = thread.messages[messageIndex];
  const validEndCursor = messageIndex === thread.messages.length && textOffset === 0;
  if (
    !Number.isSafeInteger(messageIndex) ||
    !Number.isSafeInteger(textOffset) ||
    messageIndex < 0 ||
    textOffset < 0 ||
    (!validEndCursor && (!message || textOffset > message.text.length))
  ) {
    return null;
  }
  return { messageIndex, textOffset };
}

export function buildThreadReferencePage(
  thread: OrchestrationThread,
  input: ThreadReferenceReadInput,
): ThreadReferenceReadResult | ThreadReferenceInvalidCursorError {
  const position = decodeCursor(input, thread);
  if (!position) {
    return new ThreadReferenceInvalidCursorError({
      threadId: input.threadId,
      cursor: input.cursor ?? "",
    });
  }

  const maxChars = input.maxChars ?? THREAD_REFERENCE_DEFAULT_MAX_CHARS;
  const messages: ThreadReferenceTranscriptMessage[] = [];
  let messageIndex = position.messageIndex;
  let textOffset = position.textOffset;
  let includedChars = 0;

  while (messageIndex < thread.messages.length && includedChars < maxChars) {
    const message = thread.messages[messageIndex];
    if (!message) break;
    const remainingChars = maxChars - includedChars;
    const text = message.text.slice(textOffset, textOffset + remainingChars);
    const textEnd = textOffset + text.length;
    const textComplete = textEnd >= message.text.length;
    messages.push({
      id: message.id,
      role: message.role,
      text,
      textStart: textOffset,
      textEnd,
      textComplete,
      attachments: [...(message.attachments ?? [])],
      createdAt: message.createdAt,
    });
    includedChars += text.length;
    if (!textComplete) {
      textOffset = textEnd;
      break;
    }
    messageIndex += 1;
    textOffset = 0;
  }

  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    messages,
    totalMessages: thread.messages.length,
    nextCursor: messageIndex < thread.messages.length ? `${messageIndex}:${textOffset}` : null,
  };
}

export function hasUserThreadReference(
  sourceThread: OrchestrationThread,
  environmentId: EnvironmentId,
  targetThreadId: ThreadId,
): boolean {
  return sourceThread.messages.some(
    (message) =>
      message.role === "user" &&
      collectComposerThreadReferences(message.text).some(
        (reference) =>
          reference.environmentId === environmentId && reference.threadId === targetThreadId,
      ),
  );
}

export function normalizeThreadReferenceThreadId(
  input: ThreadId,
  environmentId: EnvironmentId,
): ThreadId {
  const parsedLink = parseComposerThreadLink(input);
  if (parsedLink?.environmentId === environmentId) {
    return ThreadId.make(parsedLink.threadId);
  }

  const environmentPrefix = `${environmentId}/`;
  if (input.startsWith(environmentPrefix)) {
    const threadId = input.slice(environmentPrefix.length);
    if (threadId && !threadId.includes("/")) {
      try {
        return ThreadId.make(decodeURIComponent(threadId));
      } catch {
        return input;
      }
    }
  }

  return input;
}

export const threadRead = Effect.fn("ThreadReferenceToolkit.threadRead")(function* (
  input: ThreadReferenceReadInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const threadId = normalizeThreadReferenceThreadId(input.threadId, invocation.environmentId);
  const normalizedInput = { ...input, threadId };
  if (!invocation.capabilities.has("thread-reference")) {
    return yield* new ThreadReferenceUnavailableError({ threadId });
  }
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const sourceThreadOption = yield* snapshotQuery
    .getThreadDetailById(invocation.threadId)
    .pipe(Effect.mapError((cause) => new ThreadReferenceUnavailableError({ threadId, cause })));
  if (
    Option.isNone(sourceThreadOption) ||
    !hasUserThreadReference(sourceThreadOption.value, invocation.environmentId, threadId)
  ) {
    return yield* new ThreadReferenceUnavailableError({ threadId });
  }
  const threadOption = yield* snapshotQuery
    .getThreadDetailById(threadId)
    .pipe(Effect.mapError((cause) => new ThreadReferenceUnavailableError({ threadId, cause })));
  if (Option.isNone(threadOption)) {
    return yield* new ThreadReferenceNotFoundError({ threadId });
  }
  const page = buildThreadReferencePage(threadOption.value, normalizedInput);
  if ("_tag" in page) {
    return yield* page;
  }
  return page;
});

export const ThreadReferenceToolkitHandlersLive = ThreadReferenceToolkit.toLayer({
  thread_read: threadRead,
});
