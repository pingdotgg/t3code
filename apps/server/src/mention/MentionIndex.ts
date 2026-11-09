import type {
  MentionIndexFigmaPayload,
  MentionIndexHit,
  MentionIndexIssuePayload,
  MentionIndexJiraPayload,
  MentionIndexProviderId,
  MentionIndexPullRequestPayload,
  MentionIndexSearchInput,
  MentionIndexSearchResult,
  MentionIndexSyncStatus,
  MentionIndexThreadPayload,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

import * as ServerConfig from "../config.ts";

const SCOPE_PREFIX = "scope:";
const META_PREFIX = "meta:";
const THUMB_PREFIX = "thumb:";
const MAX_ROWS_PER_SCOPE = 2_000;
const MAX_THUMB_BASE64_CHARS = 350_000;

const ThumbnailBlob = Schema.fromJsonString(
  Schema.Struct({
    mimeType: Schema.String,
    dataBase64: Schema.String,
  }),
);
const encodeThumbnail = Schema.encodeSync(ThumbnailBlob);
const decodeThumbnail = Schema.decodeUnknownOption(ThumbnailBlob);

export interface MentionIndexRow {
  readonly providerId: MentionIndexProviderId;
  readonly itemKey: string;
  readonly label: string;
  readonly description: string;
  readonly url: string;
  readonly tokens: string;
  readonly pullRequest?: MentionIndexPullRequestPayload;
  readonly thread?: MentionIndexThreadPayload;
  readonly jira?: MentionIndexJiraPayload;
  readonly issue?: MentionIndexIssuePayload;
  readonly figma?: MentionIndexFigmaPayload;
  readonly updatedAt: number;
}

export interface MentionIndexThumbnailBlob {
  readonly mimeType: string;
  readonly dataBase64: string;
}

interface ScopeMeta {
  readonly syncedAt: number;
  readonly status: MentionIndexSyncStatus;
  readonly detail?: string;
}

interface ScopeState {
  readonly rows: ReadonlyArray<MentionIndexRow>;
  readonly meta: ScopeMeta;
}

const ScopeBlob = Schema.fromJsonString(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Struct({
        providerId: Schema.Literals(["pull-request", "thread", "jira", "issue", "figma"]),
        itemKey: Schema.String,
        label: Schema.String,
        description: Schema.String,
        url: Schema.String,
        tokens: Schema.String,
        pullRequest: Schema.optionalKey(
          Schema.Struct({
            number: Schema.Number,
            title: Schema.String,
            url: Schema.String,
            headBranch: Schema.String,
            baseBranch: Schema.String,
            state: Schema.Literals(["open", "closed", "merged"]),
            isDraft: Schema.Boolean,
            projectId: Schema.String,
            repository: Schema.String,
          }),
        ),
        thread: Schema.optionalKey(
          Schema.Struct({
            environmentId: Schema.String,
            threadId: Schema.String,
            title: Schema.String,
            projectId: Schema.String,
          }),
        ),
        jira: Schema.optionalKey(
          Schema.Struct({
            key: Schema.String,
            summary: Schema.String,
            url: Schema.String,
            projectKey: Schema.optionalKey(Schema.String),
            status: Schema.optionalKey(Schema.String),
          }),
        ),
        issue: Schema.optionalKey(
          Schema.Struct({
            number: Schema.Number,
            title: Schema.String,
            url: Schema.String,
            repository: Schema.String,
            state: Schema.Literals(["open", "closed"]),
            projectId: Schema.String,
          }),
        ),
        figma: Schema.optionalKey(
          Schema.Struct({
            fileKey: Schema.String,
            name: Schema.String,
            url: Schema.String,
            hasThumbnail: Schema.Boolean,
          }),
        ),
        updatedAt: Schema.Number,
      }),
    ),
    meta: Schema.Struct({
      syncedAt: Schema.Number,
      status: Schema.Literals(["ready", "syncing", "empty", "error"]),
      detail: Schema.optionalKey(Schema.String),
    }),
  }),
);
const encodeScope = Schema.encodeSync(ScopeBlob);
const decodeScope = Schema.decodeUnknownOption(ScopeBlob);
const MetaBlob = Schema.fromJsonString(
  Schema.Struct({
    syncedAt: Schema.Number,
    status: Schema.Literals(["ready", "syncing", "empty", "error"]),
  }),
);
const encodeMeta = Schema.encodeSync(MetaBlob);

export function mentionIndexScopeKey(
  providerId: MentionIndexProviderId,
  projectId: ProjectId,
): string {
  return `${providerId}:${projectId}`;
}

function fold(value: string): string {
  return value.trim().toLowerCase();
}

function scoreRow(row: MentionIndexRow, query: string): number {
  const q = fold(query);
  if (q.length === 0) return row.updatedAt / 1e13;
  const tokens = row.tokens;
  if (tokens === q || row.label.toLowerCase() === q || row.itemKey === q) return 1_000;
  if (tokens.startsWith(q) || row.itemKey.startsWith(q)) return 800;
  if (tokens.includes(q)) return 400 + Math.min(200, q.length * 10);
  const words = q.split(/\s+/u).filter(Boolean);
  if (words.length > 1 && words.every((word) => tokens.includes(word))) return 300;
  return 0;
}

export class MentionIndex extends Context.Service<
  MentionIndex,
  {
    readonly search: (input: MentionIndexSearchInput) => Effect.Effect<MentionIndexSearchResult>;
    readonly replaceScope: (
      scopeKey: string,
      rows: ReadonlyArray<MentionIndexRow>,
      meta?: Partial<ScopeMeta>,
    ) => Effect.Effect<void>;
    readonly markSyncing: (scopeKey: string) => Effect.Effect<void>;
    readonly markError: (scopeKey: string, detail: string) => Effect.Effect<void>;
    readonly scopeMeta: (scopeKey: string) => Effect.Effect<ScopeMeta | null>;
    readonly upsertRows: (
      scopeKey: string,
      rows: ReadonlyArray<MentionIndexRow>,
    ) => Effect.Effect<void>;
    readonly putThumbnail: (
      thumbKey: string,
      blob: MentionIndexThumbnailBlob,
    ) => Effect.Effect<void>;
    readonly getThumbnail: (thumbKey: string) => Effect.Effect<MentionIndexThumbnailBlob | null>;
  }
>()("t3/mention/MentionIndex") {}

export function mentionIndexThumbKey(
  providerId: "figma",
  projectId: ProjectId,
  itemKey: string,
): string {
  return `${providerId}:${projectId}:${itemKey}`;
}

export const make = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const hot = yield* Ref.make(new Map<string, ScopeState>());

  const readDisk = Effect.fn("MentionIndex.readDisk")(function* (scopeKey: string) {
    const raw = yield* store
      .get(`${SCOPE_PREFIX}${scopeKey}`)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (raw === undefined) return null;
    const decoded = decodeScope(raw);
    if (Option.isNone(decoded)) return null;
    return {
      rows: decoded.value.rows as ReadonlyArray<MentionIndexRow>,
      meta: decoded.value.meta as ScopeMeta,
    } satisfies ScopeState;
  });

  const writeDisk = Effect.fn("MentionIndex.writeDisk")(function* (
    scopeKey: string,
    state: ScopeState,
  ) {
    const ignoreStoreError = (cause: unknown) =>
      Effect.logWarning("Failed to persist mention index scope", { scopeKey, cause });
    yield* store
      .set(
        `${SCOPE_PREFIX}${scopeKey}`,
        encodeScope({
          rows: state.rows.slice(0, MAX_ROWS_PER_SCOPE),
          meta: state.meta,
        }),
      )
      .pipe(Effect.catch(ignoreStoreError));
    yield* store
      .set(
        `${META_PREFIX}${scopeKey}`,
        encodeMeta({ syncedAt: state.meta.syncedAt, status: state.meta.status }),
      )
      .pipe(Effect.catch(ignoreStoreError));
  });

  const loadScope = Effect.fn("MentionIndex.loadScope")(function* (scopeKey: string) {
    const current = yield* Ref.get(hot);
    const cached = current.get(scopeKey);
    if (cached) return cached;
    const fromDisk = yield* readDisk(scopeKey);
    if (fromDisk) {
      // Retain an already-published newer scope if another writer won the race.
      const published = yield* Ref.modify(hot, (map) => {
        const existing = map.get(scopeKey);
        if (existing !== undefined && existing.meta.syncedAt >= fromDisk.meta.syncedAt) {
          return [existing, map];
        }
        const next = new Map(map);
        next.set(scopeKey, fromDisk);
        return [fromDisk, next];
      });
      return published;
    }
    // Disk miss can race a concurrent markSyncing/replaceScope; prefer any hot publish.
    const raced = (yield* Ref.get(hot)).get(scopeKey);
    if (raced) return raced;
    return {
      rows: [],
      meta: { syncedAt: 0, status: "empty" },
    } satisfies ScopeState;
  });

  const setScope = Effect.fn("MentionIndex.setScope")(function* (
    scopeKey: string,
    state: ScopeState,
  ) {
    yield* Ref.update(hot, (map) => {
      const next = new Map(map);
      next.set(scopeKey, state);
      return next;
    });
    yield* writeDisk(scopeKey, state);
  });

  return MentionIndex.of({
    search: Effect.fn("MentionIndex.search")(function* (input: MentionIndexSearchInput) {
      const providers = input.providers ?? (["pull-request"] as const);
      const limit = input.limit ?? 20;
      const hits: MentionIndexHit[] = [];
      let status: MentionIndexSyncStatus = "empty";
      let syncedAt: number | undefined;
      let detail: string | undefined;

      for (const providerId of providers) {
        const scopeKey = mentionIndexScopeKey(providerId, input.projectId);
        const scope = yield* loadScope(scopeKey);
        if (scope.meta.status === "syncing") status = "syncing";
        else if (scope.meta.status === "error" && status === "empty") {
          status = "error";
          detail = scope.meta.detail;
        } else if (scope.meta.status === "ready") status = "ready";
        if (scope.meta.syncedAt > 0) {
          syncedAt = Math.max(syncedAt ?? 0, scope.meta.syncedAt);
        }
        for (const row of scope.rows) {
          const score = scoreRow(row, input.query);
          if (score <= 0 && fold(input.query).length > 0) continue;
          hits.push({
            providerId: row.providerId,
            itemKey: row.itemKey,
            label: row.label,
            description: row.description,
            url: row.url,
            score,
            ...(row.pullRequest ? { pullRequest: row.pullRequest } : {}),
            ...(row.thread ? { thread: row.thread } : {}),
            ...(row.jira ? { jira: row.jira } : {}),
            ...(row.issue ? { issue: row.issue } : {}),
            ...(row.figma ? { figma: row.figma } : {}),
          });
        }
      }

      hits.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
      if (hits.length > 0 && status === "empty") status = "ready";

      return {
        hits: hits.slice(0, limit),
        status,
        ...(syncedAt !== undefined ? { syncedAt } : {}),
        ...(detail !== undefined ? { detail } : {}),
      } satisfies MentionIndexSearchResult;
    }),

    replaceScope: Effect.fn("MentionIndex.replaceScope")(function* (scopeKey, rows, meta = {}) {
      const previous = yield* loadScope(scopeKey);
      const now = yield* Clock.currentTimeMillis;
      const next: ScopeState = {
        rows: rows.slice(0, MAX_ROWS_PER_SCOPE),
        meta: {
          syncedAt: meta.syncedAt ?? now,
          status: meta.status ?? (rows.length === 0 ? "empty" : "ready"),
          ...(meta.detail !== undefined
            ? { detail: meta.detail }
            : previous.meta.detail !== undefined && meta.status === "error"
              ? { detail: previous.meta.detail }
              : {}),
        },
      };
      yield* setScope(scopeKey, next);
    }),

    markSyncing: Effect.fn("MentionIndex.markSyncing")(function* (scopeKey) {
      const previous = yield* loadScope(scopeKey);
      yield* setScope(scopeKey, {
        rows: previous.rows,
        meta: { ...previous.meta, status: "syncing" },
      });
    }),

    markError: Effect.fn("MentionIndex.markError")(function* (scopeKey, detail) {
      const previous = yield* loadScope(scopeKey);
      const bounded = detail.trim().slice(0, 500) || "Mention index sync failed";
      const now = yield* Clock.currentTimeMillis;
      yield* setScope(scopeKey, {
        rows: previous.rows,
        meta: {
          // Stamp failure time so ensureIndexed can honor the freshness window.
          syncedAt: now,
          status: previous.rows.length > 0 ? "ready" : "error",
          detail: bounded,
        },
      });
    }),

    scopeMeta: Effect.fn("MentionIndex.scopeMeta")(function* (scopeKey) {
      const scope = yield* loadScope(scopeKey);
      return scope.meta.syncedAt === 0 && scope.rows.length === 0 ? null : scope.meta;
    }),

    upsertRows: Effect.fn("MentionIndex.upsertRows")(function* (scopeKey, rows) {
      const previous = yield* loadScope(scopeKey);
      const byKey = new Map(previous.rows.map((row) => [row.itemKey, row]));
      for (const row of rows) byKey.set(row.itemKey, row);
      const merged = [...byKey.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_ROWS_PER_SCOPE);
      // Keep syncedAt so a one-row write-through does not look like a full scope replace.
      yield* setScope(scopeKey, {
        rows: merged,
        meta: {
          syncedAt: previous.meta.syncedAt,
          status: merged.length === 0 ? "empty" : "ready",
          ...(previous.meta.detail !== undefined ? { detail: previous.meta.detail } : {}),
        },
      });
    }),

    putThumbnail: Effect.fn("MentionIndex.putThumbnail")(function* (thumbKey, blob) {
      if (blob.dataBase64.length === 0 || blob.dataBase64.length > MAX_THUMB_BASE64_CHARS) return;
      yield* store
        .set(
          `${THUMB_PREFIX}${thumbKey}`,
          encodeThumbnail({ mimeType: blob.mimeType, dataBase64: blob.dataBase64 }),
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to persist mention thumbnail", { thumbKey, cause }),
          ),
        );
    }),

    getThumbnail: Effect.fn("MentionIndex.getThumbnail")(function* (thumbKey) {
      const raw = yield* store
        .get(`${THUMB_PREFIX}${thumbKey}`)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (raw === undefined) return null;
      const decoded = decodeThumbnail(raw);
      if (Option.isNone(decoded)) return null;
      if (decoded.value.dataBase64.length > MAX_THUMB_BASE64_CHARS) return null;
      return decoded.value;
    }),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const directory = path.join(config.providerStatusCacheDir, "mention-index");
    return Layer.effect(MentionIndex, make).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(directory).pipe(
          Layer.catch(() =>
            Layer.effectDiscard(
              Effect.logWarning("Mention index directory unavailable; using memory store"),
            ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
