import type * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import {
  ProviderNativeHistoryError,
  type ProviderNativeHistory,
  type ProviderNativeHistoryItem,
  type ProviderNativeHistoryThread,
} from "@t3tools/provider-core/server/nativeHistory";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_ITEMS = 20;
const MAX_CURSOR_CHARS = 16_000;
const INTERACTIVE_SOURCES = ["cli", "vscode", "appServer"] as const;

/** Only these read methods are available to the history reader. */
interface CodexHistoryClient {
  readonly homePath: string;
  readonly list: (
    input: CodexSchema.V2ThreadListParams,
  ) => Effect.Effect<CodexSchema.V2ThreadListResponse, CodexErrors.CodexAppServerError>;
  readonly read: (
    input: CodexSchema.V2ThreadReadParams,
  ) => Effect.Effect<CodexSchema.V2ThreadReadResponse, CodexErrors.CodexAppServerError>;
  readonly items: (
    input: CodexSchema.V2ThreadItemsListParams,
  ) => Effect.Effect<CodexSchema.V2ThreadItemsListResponse, CodexErrors.CodexAppServerError>;
}

const SourceLocator = Schema.Struct({
  version: Schema.Literal(1),
  history: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  filterTurnId: Schema.NullOr(Schema.String),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_ITEMS })),
});
const decodeLocator = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceLocator));
const encodeLocator = Schema.encodeSync(Schema.fromJsonString(SourceLocator));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isHistoryError = Schema.is(ProviderNativeHistoryError);
const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
type Operation = ProviderNativeHistoryError["operation"];
type NativeItem = CodexSchema.V2ThreadItemsListResponse__ThreadItem;
type NativeEntry = CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry;

const failure = (
  operation: Operation,
  reason: ProviderNativeHistoryError["reason"],
  cause?: unknown,
) =>
  new ProviderNativeHistoryError({ operation, reason, ...(cause === undefined ? {} : { cause }) });

function mapFailure(operation: Operation, cause: unknown): ProviderNativeHistoryError {
  if (isHistoryError(cause))
    return cause.operation === operation ? cause : failure(operation, cause.reason, cause.cause);
  if (isRequestError(cause)) {
    if (cause.code === -32601 || cause.operation === "decode-payload")
      return failure(operation, "unsupported", cause);
    if (cause.code === -32600 && cause.errorMessage.startsWith("thread not found:"))
      return failure(operation, "missing", cause);
  }
  return failure(operation, "unavailable", cause);
}

const bounded = (value: number | undefined, fallback: number, max: number, min = 1) =>
  Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value!)) : fallback;

function boundary(text: string, offset: number): boolean {
  return (
    offset === 0 ||
    offset === text.length ||
    !(
      text.charCodeAt(offset - 1) >= 0xd800 &&
      text.charCodeAt(offset - 1) <= 0xdbff &&
      text.charCodeAt(offset) >= 0xdc00 &&
      text.charCodeAt(offset) <= 0xdfff
    )
  );
}

function excerpt(text: string, start: number, maxChars: number) {
  const end = Math.min(text.length, start + maxChars);
  return text.slice(start, boundary(text, end) ? end : end - 1);
}

const iso = (milliseconds: number): string => DateTime.formatIso(DateTime.makeUnsafe(milliseconds));

function threadMetadata(
  thread: CodexSchema.V2ThreadReadResponse["thread"],
): ProviderNativeHistoryThread {
  return {
    nativeThreadId: thread.id,
    cwd: thread.cwd,
    title: excerpt(thread.name?.trim() || thread.preview || thread.id, 0, 512),
    preview: excerpt(thread.preview, 0, 1_000),
    createdAt: iso(thread.createdAt * 1_000),
    updatedAt: iso(thread.updatedAt * 1_000),
    source:
      typeof thread.source === "string"
        ? thread.source
        : "subAgent" in thread.source
          ? "subAgent"
          : thread.source.custom,
    originator: thread.originator ?? null,
    ephemeral: thread.ephemeral,
  };
}

function textContent(content: ReadonlyArray<Schema.Json>): ReadonlyArray<string> {
  return content.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("type" in entry))
      return [];
    if (
      (entry.type === "text" || entry.type === "input_text" || entry.type === "output_text") &&
      "text" in entry &&
      typeof entry.text === "string"
    )
      return [entry.text];
    if (entry.type !== "resource" || !("resource" in entry)) return [];
    const resource = entry.resource;
    return typeof resource === "object" &&
      resource !== null &&
      "text" in resource &&
      typeof resource.text === "string"
      ? [resource.text]
      : [];
  });
}

function toolText(
  kind: string,
  fields: Record<string, unknown>,
  body: ReadonlyArray<string> = [],
): string {
  return [
    `Tool evidence: ${kind}`,
    ...Object.entries(fields).flatMap(([label, value]) =>
      value === undefined
        ? []
        : [`${label}: ${typeof value === "string" ? value : encodeJson(value)}`],
    ),
    ...(body.length === 0 ? [] : ["", ...body]),
  ].join("\n");
}

/** Normalize visible evidence once; native reasoning and binary/media payloads stay out. */
function evidence(
  item: NativeItem,
): { readonly text: string; readonly role: ProviderNativeHistoryItem["role"] } | null {
  if ("status" in item && item.status === "inProgress") return null;
  switch (item.type) {
    case "userMessage":
      return {
        role: "user",
        text: item.content
          .map((entry) =>
            entry.type === "text"
              ? entry.text
              : entry.type === "skill" || entry.type === "mention"
                ? `[${entry.type}: ${entry.name}]`
                : `[${entry.type} attachment]`,
          )
          .join("\n"),
      };
    case "agentMessage":
      return { role: "assistant", text: item.text };
    case "plan":
      return { role: "assistant", text: item.text };
    case "commandExecution":
      return {
        role: "tool",
        text: toolText(
          item.type,
          {
            Status: item.status,
            Command: item.command,
            Directory: item.cwd,
            "Exit code": item.exitCode ?? null,
          },
          [`Output:\n${item.aggregatedOutput ?? ""}`],
        ),
      };
    case "fileChange":
      return {
        role: "tool",
        text: toolText(
          item.type,
          { Status: item.status },
          item.changes.map((change) =>
            [
              `File: ${change.path}`,
              `Change: ${change.kind.type}`,
              ...(change.kind.type === "update" && change.kind.move_path
                ? [`Moved to: ${change.kind.move_path}`]
                : []),
              `Diff:\n${change.diff}`,
            ].join("\n"),
          ),
        ),
      };
    case "mcpToolCall":
      return {
        role: "tool",
        text: toolText(
          item.type,
          {
            Status: item.status,
            Server: item.server,
            Tool: item.tool,
            "Arguments (JSON)": encodeJson(item.arguments),
            Error: item.error?.message,
          },
          item.result
            ? [
                "Output:",
                ...textContent(item.result.content),
                ...(item.result.structuredContent === undefined
                  ? []
                  : [`Structured output (JSON):\n${encodeJson(item.result.structuredContent)}`]),
              ]
            : [],
        ),
      };
    case "dynamicToolCall":
      return {
        role: "tool",
        text: toolText(
          item.type,
          {
            Status: item.status,
            Tool: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
            "Arguments (JSON)": encodeJson(item.arguments),
            Success: item.success ?? null,
          },
          [
            "Output:",
            ...(item.contentItems?.flatMap((entry) =>
              entry.type === "inputText" ? [entry.text] : [],
            ) ?? []),
          ],
        ),
      };
    case "functionCallOutput":
      return {
        role: "tool",
        text: toolText(
          item.type,
          { Tool: item.namespace ? `${item.namespace}.${item.name}` : item.name },
          [
            "Output:",
            ...(typeof item.output === "string" ? [item.output] : textContent(item.output)),
          ],
        ),
      };
    case "collabAgentToolCall":
      return {
        role: "tool",
        text: toolText(
          item.type,
          {
            Status: item.status,
            Tool: item.tool,
            Prompt: item.prompt,
            "Receiver threads": item.receiverThreadIds,
          },
          Object.entries(item.agentsStates).map(
            ([threadId, agent]) => `Agent ${threadId}: ${agent.status}\n${agent.message ?? ""}`,
          ),
        ),
      };
    case "webSearch":
      return {
        role: "tool",
        text: toolText(
          item.type,
          { Query: item.query, "Action (JSON)": item.action },
          item.results == null ? [] : [`Results (JSON):\n${encodeJson(item.results)}`],
        ),
      };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { role: "tool", text: item.review };
    default:
      return null;
  }
}

export const makeCodexNativeHistory = Effect.fn("CodexHistory.make")(function* <E>(input: {
  readonly enabled: boolean;
  readonly homePath: string;
  readonly identity: ProviderContinuationIdentity;
  readonly withClient: <A>(
    cwd: string,
    use: (
      client: CodexHistoryClient,
    ) => Effect.Effect<A, ProviderNativeHistoryError | CodexErrors.CodexAppServerError>,
  ) => Effect.Effect<A, E>;
}) {
  const crypto = yield* Digest.Digest;
  const fs = yield* FileSystem.FileSystem;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError((cause) => failure("items", "unavailable", cause)),
    );
  const identity = yield* digest(encodeJson(input.identity));
  const run = <A>(
    operation: Operation,
    cwd: string,
    use: (
      client: CodexHistoryClient,
    ) => Effect.Effect<A, ProviderNativeHistoryError | CodexErrors.CodexAppServerError>,
  ) =>
    input.enabled
      ? input
          .withClient(cwd, (client) =>
            Effect.gen(function* () {
              // The provider's reported home must match the continuation identity's store.
              // Resolve aliases only when needed; an unavailable or different store fails closed.
              if (
                normalizeProjectPathForComparison(client.homePath) !==
                normalizeProjectPathForComparison(input.homePath)
              ) {
                const paths = yield* Effect.all([
                  fs.realPath(client.homePath),
                  fs.realPath(input.homePath),
                ]).pipe(Effect.mapError((cause) => failure(operation, "unavailable", cause)));
                if (
                  normalizeProjectPathForComparison(paths[0]) !==
                  normalizeProjectPathForComparison(paths[1])
                )
                  return yield* failure(
                    operation,
                    "unavailable",
                    "Codex reported another history directory.",
                  );
              }
              return yield* use(client);
            }),
          )
          .pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError((cause) => mapFailure(operation, cause)),
          )
      : Effect.fail(failure(operation, "unsupported"));
  const checkResponse = <A>(operation: Operation, value: A, count: number, limit: number) =>
    Effect.try({
      try: () => {
        if (count > limit || Buffer.byteLength(encodeJson(value)) > MAX_RESPONSE_BYTES)
          throw failure(operation, "limit_exceeded");
        return value;
      },
      catch: (cause) => mapFailure(operation, cause),
    });
  const checkCursor = (operation: Operation, cursor: string | undefined) =>
    cursor !== undefined && cursor.length > MAX_CURSOR_CHARS
      ? Effect.fail(failure(operation, "invalid_cursor"))
      : Effect.void;
  const continuation = (
    operation: Operation,
    previous: string | undefined,
    next: string | null | undefined,
  ) => {
    if (
      next !== undefined &&
      next !== null &&
      (next === previous || next.length > MAX_CURSOR_CHARS)
    )
      return Effect.fail(failure(operation, "invalid_cursor"));
    return Effect.succeed(next ?? null);
  };
  const metadata = Effect.fn("CodexHistory.metadata")(function* (
    client: CodexHistoryClient,
    nativeThreadId: string,
    operation: Operation,
  ) {
    const response = yield* client.read({ threadId: nativeThreadId, includeTurns: false });
    yield* checkResponse(operation, response, 1, 1);
    if (response.thread.id !== nativeThreadId) return yield* failure(operation, "changed");
    return yield* Effect.try({
      try: () => threadMetadata(response.thread),
      catch: (cause) => failure(operation, "unsupported", cause),
    });
  });
  const makeItem = Effect.fn("CodexHistory.makeItem")(function* (
    nativeThreadId: string,
    entry: NativeEntry,
    locator: typeof SourceLocator.Type,
    text: string,
    role: ProviderNativeHistoryItem["role"],
    textOffset: number,
    maxChars: number,
    match: ProviderNativeHistoryItem["match"],
  ) {
    const selected = excerpt(text, textOffset, maxChars);
    const readCursor = encodeLocator(locator);
    if (readCursor.length > MAX_CURSOR_CHARS) return yield* failure("items", "limit_exceeded");
    return {
      nativeThreadId,
      nativeTurnId: entry.turnId,
      nativeItemId: entry.item.id,
      kind: entry.item.type,
      role,
      status: "status" in entry.item ? entry.item.status : null,
      createdAt:
        entry.startedAtMs == null ||
        !Number.isFinite(entry.startedAtMs) ||
        Math.abs(entry.startedAtMs) > 8.64e15
          ? null
          : iso(entry.startedAtMs),
      digest: yield* digest(`codex-visible-evidence-v1\n${entry.item.type}\n${text}`),
      readCursor,
      text: selected,
      textOffset,
      totalChars: text.length,
      truncated: textOffset !== 0 || selected.length !== text.length,
      match,
    } satisfies ProviderNativeHistoryItem;
  });

  const list: ProviderNativeHistory["list"] = Effect.fn("CodexHistory.list")(function* (request) {
    yield* checkCursor("list", request.cursor);
    const limit = bounded(request.limit, 20, 50);
    return yield* run("list", request.cwd, (client) =>
      Effect.gen(function* () {
        const response = yield* client.list({
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.filterCwd === undefined ? {} : { cwd: request.filterCwd }),
          archived: request.archived ?? false,
          limit,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: [...INTERACTIVE_SOURCES],
          modelProviders: [],
          useStateDbOnly: true,
        });
        yield* checkResponse("list", response, response.data.length, limit);
        const threads = yield* Effect.try({
          try: () =>
            response.data
              .filter(
                (thread) =>
                  !thread.ephemeral &&
                  typeof thread.source === "string" &&
                  INTERACTIVE_SOURCES.some((source) => source === thread.source) &&
                  (request.filterCwd === undefined ||
                    normalizeProjectPathForComparison(thread.cwd) ===
                      normalizeProjectPathForComparison(request.filterCwd)),
              )
              .map(threadMetadata),
          catch: (cause) => failure("list", "unsupported", cause),
        });
        return {
          threads,
          nextCursor: yield* continuation("list", request.cursor, response.nextCursor),
        };
      }),
    );
  });

  const items: ProviderNativeHistory["items"] = Effect.fn("CodexHistory.items")(
    function* (request) {
      yield* checkCursor("items", request.cursor);
      if ((request.query?.length ?? 0) > 256) return yield* failure("items", "limit_exceeded");
      const limit = bounded(request.limit, MAX_PAGE_ITEMS, MAX_PAGE_ITEMS);
      const maxChars = bounded(request.maxCharsPerItem, 1_000, 2_000, 256);
      const query = request.query?.trim();
      const matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : null;
      return yield* run("items", request.cwd, (client) =>
        Effect.gen(function* () {
          const thread = yield* metadata(client, request.nativeThreadId, "items");
          const response = yield* client.items({
            threadId: request.nativeThreadId,
            ...(request.nativeTurnId === undefined ? {} : { turnId: request.nativeTurnId }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            sortDirection: "asc",
            limit,
          });
          yield* checkResponse("items", response, response.data.length, limit);
          const selected: Array<ProviderNativeHistoryItem> = [];
          for (const entry of response.data) {
            if (request.nativeTurnId !== undefined && entry.turnId !== request.nativeTurnId)
              return yield* failure("items", "changed");
            const source = evidence(entry.item);
            if (source === null || source.text === "") continue;
            const found = matcher?.exec(source.text);
            if (matcher !== null && !found) continue;
            const match = found ? { start: found.index, end: found.index + found[0].length } : null;
            let start = match === null ? 0 : Math.max(0, match.start - 128);
            if (!boundary(source.text, start)) start--;
            selected.push(
              yield* makeItem(
                request.nativeThreadId,
                entry,
                {
                  version: 1,
                  history: identity,
                  threadId: request.nativeThreadId,
                  turnId: entry.turnId,
                  itemId: entry.item.id,
                  cursor: request.cursor ?? null,
                  filterTurnId: request.nativeTurnId ?? null,
                  limit,
                },
                source.text,
                source.role,
                start,
                maxChars,
                match,
              ),
            );
          }
          return {
            thread,
            items: selected,
            examinedItems: response.data.length,
            nextCursor: yield* continuation("items", request.cursor, response.nextCursor),
          };
        }),
      );
    },
  );

  const readSource: ProviderNativeHistory["readSource"] = Effect.fn("CodexHistory.readSource")(
    function* (request) {
      yield* checkCursor("readSource", request.readCursor);
      const locator = yield* decodeLocator(request.readCursor).pipe(
        Effect.mapError((cause) => failure("readSource", "invalid_cursor", cause)),
      );
      if (
        locator.history !== identity ||
        locator.threadId !== request.nativeThreadId ||
        (locator.filterTurnId !== null && locator.filterTurnId !== locator.turnId)
      )
        return yield* failure("readSource", "invalid_cursor");
      const maxChars = bounded(request.maxChars, 12_000, 48_000, 2);
      return yield* run("readSource", request.cwd, (client) =>
        Effect.gen(function* () {
          const thread = yield* metadata(client, request.nativeThreadId, "readSource");
          const response = yield* client.items({
            threadId: request.nativeThreadId,
            ...(locator.filterTurnId === null ? {} : { turnId: locator.filterTurnId }),
            ...(locator.cursor === null ? {} : { cursor: locator.cursor }),
            sortDirection: "asc",
            limit: locator.limit,
          });
          yield* checkResponse("readSource", response, response.data.length, locator.limit);
          const entry = response.data.find(
            (entry) => entry.turnId === locator.turnId && entry.item.id === locator.itemId,
          );
          if (entry === undefined) return yield* failure("readSource", "changed");
          const source = evidence(entry.item);
          if (source === null) return yield* failure("readSource", "changed");
          const start = request.textOffset ?? 0;
          if (
            !Number.isSafeInteger(start) ||
            start < 0 ||
            start > source.text.length ||
            !boundary(source.text, start)
          )
            return yield* failure("readSource", "invalid_cursor");
          const item = yield* makeItem(
            request.nativeThreadId,
            entry,
            locator,
            source.text,
            source.role,
            start,
            maxChars,
            null,
          );
          if (item.digest !== request.digest) return yield* failure("readSource", "changed");
          const end = start + item.text.length;
          return { thread, item, nextTextOffset: end === source.text.length ? null : end };
        }),
      );
    },
  );

  return { list, items, readSource } satisfies ProviderNativeHistory;
});
