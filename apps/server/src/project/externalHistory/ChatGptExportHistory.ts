import {
  ExternalHistoryError,
  type ExternalHistoryMatch,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { createTranscriptJsonReader, TranscriptJsonLimitError } from "../AgentSessionJson.ts";
import {
  boundedTextEnd,
  isTextBoundary,
} from "../conversationSummaries/conversationSummarySources.ts";

const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const PAGE_ITEMS = 20;
const MAX_EXCERPT_CHARS = 2_000;
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Message = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  author: Schema.Struct({ role: Schema.String }),
  content: Schema.Struct({
    parts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    text: Schema.optionalKey(Schema.String),
  }),
  metadata: Schema.optionalKey(
    Schema.Struct({
      is_visually_hidden_from_conversation: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const Conversation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  conversation_id: Schema.optionalKey(Schema.String),
  title: Schema.String,
  current_node: Schema.NullOr(Schema.String),
  mapping: Schema.Record(
    Schema.String,
    Schema.Struct({
      parent: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Message),
    }),
  ),
});
const SearchCursor = Schema.Struct({
  version: Schema.Literal(1),
  sourceId: Schema.String,
  file: Schema.String,
  query: Schema.String,
  conversation: Index,
  message: Index,
});
const ReadCursor = Schema.Struct({
  version: Schema.Literal(1),
  sourceId: Schema.String,
  file: Schema.String,
  conversation: Index,
  threadId: Schema.String,
  itemId: Schema.String,
});
const decodeConversation = Schema.decodeUnknownEffect(Conversation);
const decodeSearchCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchCursor));
const encodeSearchCursor = Schema.encodeSync(Schema.fromJsonString(SearchCursor));
const decodeReadCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(ReadCursor));
const encodeReadCursor = Schema.encodeSync(Schema.fromJsonString(ReadCursor));
const isHistoryError = Schema.is(ExternalHistoryError);
const isTranscriptJsonLimitError = Schema.is(TranscriptJsonLimitError);
const encodeFileIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      size: Schema.String,
      dev: Schema.String,
      ino: Schema.NullOr(Schema.String),
      mtime: Schema.NullOr(Schema.Number),
      birthtime: Schema.NullOr(Schema.Number),
    }),
  ),
);

interface VisibleMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
}

function visibleBranch(conversation: typeof Conversation.Type): ReadonlyArray<VisibleMessage> {
  const seen = new Set<string>();
  const messageIds = new Set<string>();
  const messages: Array<VisibleMessage> = [];
  let nodeId = conversation.current_node;
  if (nodeId === null && Object.keys(conversation.mapping).length > 0)
    throw new ExternalHistoryError({ reason: "unsupported" });
  while (nodeId !== null) {
    if (seen.has(nodeId)) throw new ExternalHistoryError({ reason: "unsupported" });
    seen.add(nodeId);
    const node = Object.hasOwn(conversation.mapping, nodeId)
      ? conversation.mapping[nodeId]
      : undefined;
    if (!node) throw new ExternalHistoryError({ reason: "unsupported" });
    const message = node.message;
    if (message && !message.metadata?.is_visually_hidden_from_conversation) {
      const role = message.author.role;
      if (role === "user" || role === "assistant" || role === "tool") {
        const text =
          message.content.text ??
          message.content.parts
            ?.filter((part): part is string => typeof part === "string")
            .join("\n") ??
          "";
        if (text.length > 0) {
          if (messageIds.has(message.id)) throw new ExternalHistoryError({ reason: "unsupported" });
          messageIds.add(message.id);
          messages.push({ id: message.id, role, text });
        }
      }
    }
    nodeId = node.parent;
  }
  return messages.reverse();
}

// Select text and branch links before assembly. Media objects and unrelated conversations
// never become a second in-memory copy of the export.
function selectExportPath(path: ReadonlyArray<string | number | null>, index: number): boolean {
  if (path.length === 0) return true;
  if (path[0] !== index) return false;
  if (path.length === 1) return true;
  const field = path[1];
  if (field !== "mapping")
    return (
      path.length === 2 &&
      (field === "id" ||
        field === "conversation_id" ||
        field === "title" ||
        field === "current_node")
    );
  if (path.length <= 3) return true;
  if (path[3] === "parent") return path.length === 4;
  if (path[3] !== "message") return false;
  if (path.length === 4) return true;
  if (path[4] === "id") return path.length === 5;
  if (path[4] === "author") return path.length === 5 || (path.length === 6 && path[5] === "role");
  if (path[4] === "metadata")
    return (
      path.length === 5 || (path.length === 6 && path[5] === "is_visually_hidden_from_conversation")
    );
  if (path[4] !== "content") return false;
  return (
    path.length === 5 ||
    (path[5] === "text" && path.length === 6) ||
    (path[5] === "parts" && path.length <= 7)
  );
}

function fileIdentity(info: FileSystem.File.Info) {
  return encodeFileIdentity({
    size: String(info.size),
    dev: String(info.dev),
    ino: Option.map(info.ino, String).pipe(Option.getOrNull),
    mtime: Option.map(info.mtime, (date) => date.getTime()).pipe(Option.getOrNull),
    birthtime: Option.map(info.birthtime, (date) => date.getTime()).pipe(Option.getOrNull),
  });
}

type SearchRequest = Extract<ExternalHistoryRequest, { operation: "search" }>;
type ReadRequest = Extract<ExternalHistoryRequest, { operation: "read" }>;

export const makeChatGptExportHistory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Digest.Digest;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError((cause) => new ExternalHistoryError({ reason: "unavailable", cause })),
    );
  const mapError = (cause: unknown) =>
    isHistoryError(cause)
      ? cause
      : new ExternalHistoryError({
          reason: isTranscriptJsonLimitError(cause)
            ? "limit_exceeded"
            : PlatformError.isPlatformError(cause) && cause.reason._tag === "NotFound"
              ? "missing"
              : "unavailable",
          cause,
        });

  const readConversation = Effect.fn("ChatGptExportHistory.readConversation")(function* (
    filePath: string,
    index: number,
    expected?: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath, { flag: "r" });
        const stat = yield* file.stat;
        if (stat.type !== "File") return yield* new ExternalHistoryError({ reason: "unsupported" });
        const identity = fileIdentity(stat);
        const version = yield* digest(identity);
        if (expected !== undefined && expected !== version)
          return yield* new ExternalHistoryError({ reason: "changed" });
        let value: unknown;
        let found = false;
        let allocated = 0;
        const reader = createTranscriptJsonReader(
          (bytes) => {
            allocated += bytes;
            if (allocated > MAX_CONVERSATION_BYTES)
              throw new TranscriptJsonLimitError({ message: "Export conversation limit" });
          },
          (path) => selectExportPath(path, index),
          {
            onArrayItem: (current, record) => {
              allocated = 0;
              if (current !== index) return true;
              value = record;
              found = true;
              return false;
            },
          },
        );
        const decoder = new TextDecoder("utf-8", { fatal: true });
        while (!reader.stopped) {
          const bytes = yield* file.readAlloc(CHUNK_BYTES);
          if (Option.isNone(bytes)) break;
          yield* Effect.try({
            try: () => reader.write(decoder.decode(bytes.value, { stream: true })),
            catch: mapError,
          });
        }
        if (!reader.stopped) {
          const finished = yield* Effect.try({
            try: () => {
              reader.write(decoder.decode());
              return reader.finish();
            },
            catch: mapError,
          });
          if (!Array.isArray(finished))
            return yield* new ExternalHistoryError({ reason: "unsupported" });
        }
        if (
          identity !== fileIdentity(yield* file.stat) ||
          identity !== fileIdentity(yield* fs.stat(filePath))
        )
          return yield* new ExternalHistoryError({ reason: "changed" });
        if (!found) return { file: version, conversation: null };
        const conversation = yield* decodeConversation(value).pipe(
          Effect.mapError(() => new ExternalHistoryError({ reason: "unsupported" })),
        );
        const threadId = conversation.id ?? conversation.conversation_id;
        if (!threadId || threadId.length > 512)
          return yield* new ExternalHistoryError({ reason: "unsupported" });
        const messages = yield* Effect.try({
          try: () => visibleBranch(conversation),
          catch: mapError,
        });
        return {
          file: version,
          conversation: { threadId, title: conversation.title.slice(0, 512), messages },
        };
      }),
    ).pipe(Effect.mapError(mapError));
  });

  const search = Effect.fn("ChatGptExportHistory.search")(function* (
    filePath: string,
    input: SearchRequest,
  ) {
    if (input.filterCwd) return yield* new ExternalHistoryError({ reason: "unsupported" });
    const cursor =
      input.cursor === undefined
        ? undefined
        : yield* decodeSearchCursor(input.cursor).pipe(
            Effect.mapError(() => new ExternalHistoryError({ reason: "invalid_cursor" })),
          );
    if (cursor && (cursor.sourceId !== input.sourceId || cursor.query !== input.query))
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const index = cursor?.conversation ?? 0;
    const result = yield* readConversation(filePath, index, cursor?.file);
    if (!result.conversation)
      return {
        operation: "search",
        matches: [],
        examinedItems: 0,
        nextCursor: null,
      } satisfies ExternalHistoryResponse;
    const { threadId, title, messages } = result.conversation;
    const offset = cursor?.message ?? 0;
    if (offset > messages.length)
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const end = Math.min(messages.length, offset + PAGE_ITEMS);
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    const matches: Array<ExternalHistoryMatch> = [];
    for (const message of messages.slice(offset, end)) {
      const match = pattern.exec(message.text);
      if (!match) continue;
      let start = Math.max(0, match.index - 200);
      if (!isTextBoundary(message.text, start)) start--;
      matches.push({
        ref: {
          sourceId: input.sourceId,
          threadId,
          readCursor: encodeReadCursor({
            version: 1,
            sourceId: input.sourceId,
            file: result.file,
            conversation: index,
            threadId,
            itemId: message.id,
          }),
          digest: yield* digest(`chatgpt-visible-evidence-v1\n${message.role}\n${message.text}`),
        },
        threadTitle: title,
        itemId: message.id,
        role: message.role,
        excerpt: message.text.slice(start, boundedTextEnd(message.text, start, MAX_EXCERPT_CHARS)),
        textOffset: start,
        totalChars: message.text.length,
      });
    }
    return {
      operation: "search",
      matches,
      examinedItems: end - offset,
      nextCursor: encodeSearchCursor({
        version: 1,
        sourceId: input.sourceId,
        file: result.file,
        query: input.query,
        conversation: end < messages.length ? index : index + 1,
        message: end < messages.length ? end : 0,
      }),
    } satisfies ExternalHistoryResponse;
  });

  const read = Effect.fn("ChatGptExportHistory.read")(function* (
    filePath: string,
    input: ReadRequest,
  ) {
    const cursor = yield* decodeReadCursor(input.ref.readCursor).pipe(
      Effect.mapError(() => new ExternalHistoryError({ reason: "invalid_cursor" })),
    );
    if (cursor.sourceId !== input.ref.sourceId || cursor.threadId !== input.ref.threadId)
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const result = yield* readConversation(filePath, cursor.conversation, cursor.file);
    if (result.conversation?.threadId !== cursor.threadId)
      return yield* new ExternalHistoryError({ reason: "changed" });
    const message = result.conversation.messages.find((entry) => entry.id === cursor.itemId);
    if (
      !message ||
      (yield* digest(`chatgpt-visible-evidence-v1\n${message.role}\n${message.text}`)) !==
        input.ref.digest
    )
      return yield* new ExternalHistoryError({ reason: "changed" });
    const start = input.textOffset ?? 0;
    if (start > message.text.length || !isTextBoundary(message.text, start))
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const end = boundedTextEnd(message.text, start, input.maxChars ?? 12_000);
    return {
      operation: "read",
      ref: input.ref,
      threadTitle: result.conversation.title,
      role: message.role,
      text: message.text.slice(start, end),
      textOffset: start,
      totalChars: message.text.length,
      nextTextOffset: end < message.text.length ? end : null,
    } satisfies ExternalHistoryResponse;
  });
  return { search, read };
});
