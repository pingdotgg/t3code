import {
  ExternalHistoryError,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
} from "@t3tools/contracts";
import type {
  ProviderNativeHistory,
  ProviderNativeHistoryError,
} from "@t3tools/provider-core/server/nativeHistory";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { makeChatGptExportHistory } from "./ChatGptExportHistory.ts";

export class ExternalHistory extends Context.Service<
  ExternalHistory,
  {
    readonly query: (
      input: ExternalHistoryRequest,
    ) => Effect.Effect<ExternalHistoryResponse, ExternalHistoryError>;
  }
>()("t3/project/externalHistory/ExternalHistory") {}

const NativeCursor = Schema.Struct({
  version: Schema.Literal(1),
  sourceId: Schema.String,
  query: Schema.String,
  filterCwd: Schema.NullOr(Schema.String),
  includeArchived: Schema.Boolean,
  archived: Schema.Boolean,
  listCursor: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  itemCursor: Schema.NullOr(Schema.String),
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeCursor));
const encodeCursorValue = Schema.encodeSync(Schema.fromJsonString(NativeCursor));
const encodeCursor = (cursor: typeof NativeCursor.Type) =>
  Effect.suspend(() => {
    const encoded = encodeCursorValue(cursor);
    return encoded.length <= 16_384
      ? Effect.succeed(encoded)
      : Effect.fail(new ExternalHistoryError({ reason: "limit_exceeded" }));
  });
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      driverKind: Schema.String,
      continuationKey: Schema.String,
    }),
  ),
);

type Source = {
  readonly id: string;
  readonly label: string;
} & (
  | { readonly kind: "codex"; readonly native: ProviderNativeHistory; readonly readers: number }
  | { readonly kind: "chatgpt_export"; readonly filePath: string }
);

// A signed-out or older instance must not hide a shared home that another enabled instance
// can read. Retry only availability/capability failures, never evidence or cursor mismatches.
function alternateNativeReader(
  first: ProviderNativeHistory,
  second: ProviderNativeHistory,
): ProviderNativeHistory {
  const fallback = <A>(
    primary: Effect.Effect<A, ProviderNativeHistoryError>,
    secondary: () => Effect.Effect<A, ProviderNativeHistoryError>,
  ) =>
    primary.pipe(
      Effect.catchIf(
        (error) => error.reason === "unavailable" || error.reason === "unsupported",
        () => secondary(),
      ),
    );
  return {
    list: (input) => fallback(first.list(input), () => second.list(input)),
    items: (input) => fallback(first.items(input), () => second.items(input)),
    readSource: (input) => fallback(first.readSource(input), () => second.readSource(input)),
  };
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Digest.Digest;
  const path = yield* Path.Path;
  const exports = yield* makeChatGptExportHistory;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError((cause) => new ExternalHistoryError({ reason: "unavailable", cause })),
    );

  const sources = Effect.fn("ExternalHistory.sources")(function* () {
    const value = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new ExternalHistoryError({ reason: "unavailable", cause })),
    );
    if (!value.externalHistory.enabled) return { enabled: false, sources: [] as Array<Source> };
    const result = new Map<string, Source>();
    for (const instance of yield* registry.listInstances) {
      if (!instance.enabled || instance.driverKind !== "codex" || !instance.nativeHistory) continue;
      const id = `codex:${yield* digest(encodeIdentity(instance.continuationIdentity))}`;
      const existing = result.get(id);
      if (existing?.kind === "codex" && existing.readers < 3) {
        result.set(id, {
          ...existing,
          native: alternateNativeReader(existing.native, instance.nativeHistory),
          readers: existing.readers + 1,
        });
      } else if (existing === undefined)
        result.set(id, {
          id,
          label: instance.displayName ?? "Codex",
          kind: "codex",
          native: instance.nativeHistory,
          readers: 1,
        });
    }
    for (const configured of value.externalHistory.chatGptExportPaths) {
      const filePath = path.resolve(config.cwd, configured);
      const id = `chatgpt:${yield* digest(filePath)}`;
      result.set(id, {
        id,
        label: `ChatGPT · ${path.basename(filePath)}`,
        kind: "chatgpt_export",
        filePath,
      });
    }
    return { enabled: true, sources: [...result.values()] };
  });

  const nativeSearch = Effect.fn("ExternalHistory.nativeSearch")(function* (
    source: Extract<Source, { kind: "codex" }>,
    input: Extract<ExternalHistoryRequest, { operation: "search" }>,
  ) {
    const decoded =
      input.cursor === undefined
        ? undefined
        : yield* decodeCursor(input.cursor).pipe(
            Effect.mapError(() => new ExternalHistoryError({ reason: "invalid_cursor" })),
          );
    let cursor: typeof NativeCursor.Type = decoded ?? {
      version: 1,
      sourceId: source.id,
      query: input.query,
      filterCwd: input.filterCwd ?? null,
      includeArchived: input.includeArchived ?? false,
      archived: false,
      listCursor: null,
      threadId: null,
      itemCursor: null,
    };
    if (
      cursor.sourceId !== source.id ||
      cursor.query !== input.query ||
      cursor.filterCwd !== (input.filterCwd ?? null) ||
      cursor.includeArchived !== (input.includeArchived ?? false) ||
      (cursor.archived && !cursor.includeArchived)
    )
      return yield* new ExternalHistoryError({ reason: "invalid_cursor" });
    const afterPhase = () =>
      cursor.includeArchived && !cursor.archived
        ? encodeCursor({
            ...cursor,
            archived: true,
            listCursor: null,
            threadId: null,
            itemCursor: null,
          })
        : Effect.succeed(null);
    if (cursor.threadId === null) {
      const page = yield* source.native
        .list({
          cwd: config.cwd,
          archived: cursor.archived,
          limit: 1,
          ...(cursor.filterCwd === null ? {} : { filterCwd: cursor.filterCwd }),
          ...(cursor.listCursor === null ? {} : { cursor: cursor.listCursor }),
        })
        .pipe(
          Effect.mapError((cause) => new ExternalHistoryError({ reason: cause.reason, cause })),
        );
      if (page.threads.length > 1)
        return yield* new ExternalHistoryError({ reason: "unsupported" });
      const thread = page.threads[0];
      if (!thread)
        return {
          operation: "search",
          matches: [],
          examinedItems: 0,
          nextCursor: yield* page.nextCursor === null
            ? afterPhase()
            : encodeCursor({ ...cursor, listCursor: page.nextCursor }),
        } satisfies ExternalHistoryResponse;
      cursor = { ...cursor, threadId: thread.nativeThreadId, listCursor: page.nextCursor };
    }
    const page = yield* source.native
      .items({
        cwd: config.cwd,
        nativeThreadId: cursor.threadId!,
        query: input.query,
        limit: 20,
        maxCharsPerItem: 2_000,
        ...(cursor.itemCursor === null ? {} : { cursor: cursor.itemCursor }),
      })
      .pipe(Effect.mapError((cause) => new ExternalHistoryError({ reason: cause.reason, cause })));
    const nextCursor = yield* page.nextCursor !== null
      ? encodeCursor({ ...cursor, itemCursor: page.nextCursor })
      : cursor.listCursor !== null
        ? encodeCursor({ ...cursor, threadId: null, itemCursor: null })
        : afterPhase();
    return {
      operation: "search",
      examinedItems: page.examinedItems,
      nextCursor,
      matches: page.items.map((item) => ({
        ref: {
          sourceId: source.id,
          threadId: page.thread.nativeThreadId,
          readCursor: item.readCursor,
          digest: item.digest,
        },
        threadTitle: page.thread.title,
        itemId: item.nativeItemId,
        role: item.role,
        excerpt: item.text,
        textOffset: item.textOffset,
        totalChars: item.totalChars,
      })),
    } satisfies ExternalHistoryResponse;
  });

  const query = Effect.fn("ExternalHistory.query")(function* (
    input: ExternalHistoryRequest,
  ): Effect.fn.Return<ExternalHistoryResponse, ExternalHistoryError> {
    const current = yield* sources();
    if (input.operation === "sources")
      return {
        operation: "sources",
        enabled: current.enabled,
        sources: current.sources.map(({ id, label, kind }) => ({ id, label, kind })),
      };
    if (!current.enabled) return yield* new ExternalHistoryError({ reason: "disabled" });
    const source = current.sources.find(
      (entry) => entry.id === (input.operation === "read" ? input.ref.sourceId : input.sourceId),
    );
    if (!source) return yield* new ExternalHistoryError({ reason: "missing" });
    if (source.kind === "chatgpt_export")
      return yield* input.operation === "search"
        ? exports.search(source.filePath, input)
        : exports.read(source.filePath, input);
    if (input.operation === "search") return yield* nativeSearch(source, input);
    const result = yield* source.native
      .readSource({
        cwd: config.cwd,
        nativeThreadId: input.ref.threadId,
        readCursor: input.ref.readCursor,
        digest: input.ref.digest,
        ...(input.textOffset === undefined ? {} : { textOffset: input.textOffset }),
        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
      })
      .pipe(Effect.mapError((cause) => new ExternalHistoryError({ reason: cause.reason, cause })));
    return {
      operation: "read",
      ref: input.ref,
      threadTitle: result.thread.title,
      role: result.item.role,
      text: result.item.text,
      textOffset: result.item.textOffset,
      totalChars: result.item.totalChars,
      nextTextOffset: result.nextTextOffset,
    };
  });
  return { query };
});

export const layer = Layer.effect(ExternalHistory, make);
