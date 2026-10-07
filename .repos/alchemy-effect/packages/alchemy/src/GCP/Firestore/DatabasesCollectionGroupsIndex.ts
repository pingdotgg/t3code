import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  databaseIdOf,
  databaseNameOf,
  jsonEqual,
  lastSegment,
  parseDatabaseName,
  stringFromMap,
} from "./internal.ts";

const DEFAULT_QUERY_SCOPE = "COLLECTION";
const DEFAULT_API_SCOPE = "ANY_API";

export type IndexQueryScope =
  | firestore.GoogleFirestoreAdminV1IndexQueryScopeEnum
  | (string & {});
export type IndexApiScope =
  | firestore.GoogleFirestoreAdminV1IndexApiScopeEnum
  | (string & {});
export type IndexDensity =
  | firestore.GoogleFirestoreAdminV1IndexDensityEnum
  | (string & {});
export type IndexFieldOrder =
  | firestore.GoogleFirestoreAdminV1IndexFieldOrderEnum
  | (string & {});
export type IndexFieldArrayConfig =
  | firestore.GoogleFirestoreAdminV1IndexFieldArrayConfigEnum
  | (string & {});

export type IndexVectorConfig = {
  /** Vector dimension this configuration applies to. */
  dimension?: number;
  /** Flat (exhaustive) vector index. */
  flat?: Record<string, never>;
};

export type IndexField = {
  /**
   * Field path to index. `__name__` is valid. For composite indexes
   * the API appends `__name__` when it is omitted as the last field.
   */
  fieldPath?: string;
  /** Order for inequality / sort (`ASCENDING`, `DESCENDING`). */
  order?: IndexFieldOrder;
  /** Array-contains indexing (`CONTAINS`). */
  arrayConfig?: IndexFieldArrayConfig;
  /** Vector nearest-neighbor configuration. */
  vectorConfig?: IndexVectorConfig;
};

export type DatabasesCollectionGroupsIndexProps = {
  /**
   * Parent database. Full name `projects/{project}/databases/{database}`
   * or the database id. Immutable — changing it replaces the index.
   */
  database: string;
  /**
   * Collection group id (`users`, `posts`, …). Immutable — changing it
   * replaces the index.
   */
  collectionGroup: string;
  /**
   * Indexed fields. Composite indexes need 2–100 fields. Immutable —
   * changing fields replaces the index.
   */
  fields: IndexField[];
  /**
   * Query scope.
   * @default "COLLECTION"
   */
  queryScope?: IndexQueryScope;
  /**
   * API scope.
   * @default "ANY_API"
   */
  apiScope?: IndexApiScope;
  /**
   * Index density. Immutable — changing it replaces the index.
   */
  density?: IndexDensity;
  /**
   * Unique index. Immutable — changing it replaces the index.
   * @default false
   */
  unique?: boolean;
  /**
   * Multikey index (MongoDB-compatible API). Immutable.
   * @default false
   */
  multikey?: boolean;
  /**
   * Shard count. Immutable — changing it replaces the index.
   */
  shardCount?: number;
};

export type DatabasesCollectionGroupsIndex = Resource<
  "GCP.Firestore.DatabasesCollectionGroupsIndex",
  DatabasesCollectionGroupsIndexProps,
  {
    /** Full resource name `.../collectionGroups/{collection}/indexes/{index}`. */
    name: string;
    /** Server-assigned index id. */
    indexId: string;
    /** Parent collection group resource name. */
    collectionGroup: string;
    /** Collection group id. */
    collectionGroupId: string;
    /** Parent database resource name. */
    database: string;
    /** Parent database id. */
    databaseId: string;
    /** Project id. */
    project: string;
    /** Query scope. */
    queryScope: string | undefined;
    /** API scope. */
    apiScope: string | undefined;
    /** Density. */
    density: string | undefined;
    /** Serving state (`CREATING`, `READY`, `NEEDS_REPAIR`). */
    state: string | undefined;
    /** Indexed fields. */
    fields: IndexField[];
    /** Whether the index is unique. */
    unique: boolean;
    /** Whether the index is multikey. */
    multikey: boolean;
    /** Shard count, if set. */
    shardCount: number | undefined;
  },
  never,
  Providers
>;

/**
 * A composite Firestore index on a collection group.
 *
 * The index id is assigned by the API. Indexes are immutable — changing
 * fields, scope, density, uniqueness, or the parent collection replaces
 * the index. Indexes have no labels field: `read` reports an index it
 * finds without prior state as unowned (adopt it with `--adopt`).
 *
 * ### Creating an Index
 * **Example:** Composite index on a collection
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {
 *   location: "us-central1",
 * });
 * const index = yield* GCP.Firestore.DatabasesCollectionGroupsIndex(
 *   "UsersByName",
 *   {
 *     database: database.name,
 *     collectionGroup: "users",
 *     queryScope: "COLLECTION",
 *     fields: [
 *       { fieldPath: "name", order: "ASCENDING" },
 *       { fieldPath: "created", order: "DESCENDING" },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @category Firestore
 */
export const DatabasesCollectionGroupsIndex =
  Resource<DatabasesCollectionGroupsIndex>(
    "GCP.Firestore.DatabasesCollectionGroupsIndex",
  );

export class IndexNotResolved extends Data.TaggedError(
  "GCP.Firestore.IndexNotResolved",
)<{
  name: string;
}> {}

export class IndexStillExists extends Data.TaggedError(
  "GCP.Firestore.IndexStillExists",
)<{
  name: string;
}> {}

const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

const fieldOf = (
  field: IndexField | firestore.GoogleFirestoreAdminV1IndexField,
): IndexField => ({
  fieldPath: field.fieldPath,
  order: field.order,
  arrayConfig: field.arrayConfig,
  vectorConfig:
    field.vectorConfig !== undefined
      ? {
          dimension: field.vectorConfig.dimension,
          flat: field.vectorConfig.flat !== undefined ? {} : undefined,
        }
      : undefined,
});

const canonicalizeFields = (
  fields: readonly (IndexField | firestore.GoogleFirestoreAdminV1IndexField)[],
) => {
  const mapped = fields.map(fieldOf);
  const last = mapped[mapped.length - 1];
  if (last !== undefined && last.fieldPath !== "__name__") {
    mapped.push({
      fieldPath: "__name__",
      order: last.order ?? "ASCENDING",
    });
  }
  return mapped;
};

const fieldsKey = (
  fields:
    | readonly (IndexField | firestore.GoogleFirestoreAdminV1IndexField)[]
    | undefined,
) =>
  JSON.stringify(
    canonicalizeFields(fields ?? []).map((field) => ({
      fieldPath: field.fieldPath ?? "",
      order: field.order?.toUpperCase(),
      arrayConfig: field.arrayConfig?.toUpperCase(),
      vectorConfig: field.vectorConfig,
    })),
  );

const collectionGroupParent = (
  project: string,
  database: string,
  collectionGroup: string,
) =>
  `${databaseNameOf(project, database)}/collectionGroups/${lastSegment(collectionGroup)}`;

const toAttrs = (
  index: firestore.GoogleFirestoreAdminV1Index,
  project: string,
): DatabasesCollectionGroupsIndex["Attributes"] => {
  const name = index.name ?? "";
  const parsed = parseDatabaseName(name);
  const database = databaseNameOf(parsed.project || project, parsed.databaseId);
  return {
    name,
    indexId: parsed.indexId || lastSegment(name),
    collectionGroup: `${database}/collectionGroups/${parsed.collectionGroup}`,
    collectionGroupId: parsed.collectionGroup,
    database,
    databaseId: parsed.databaseId,
    project: parsed.project || project,
    queryScope: index.queryScope,
    apiScope: index.apiScope,
    density: index.density,
    state: index.state,
    fields: (index.fields ?? []).map(fieldOf),
    unique: index.unique === true,
    multikey: index.multikey === true,
    shardCount: index.shardCount,
  };
};

const desiredBody = (news: DatabasesCollectionGroupsIndexProps) => ({
  queryScope: news.queryScope ?? DEFAULT_QUERY_SCOPE,
  apiScope: news.apiScope ?? DEFAULT_API_SCOPE,
  density: news.density,
  unique: news.unique === true ? true : undefined,
  multikey: news.multikey === true ? true : undefined,
  shardCount: news.shardCount,
  fields: news.fields.map(fieldOf),
});

const matchesDesired = (
  index: firestore.GoogleFirestoreAdminV1Index,
  news: DatabasesCollectionGroupsIndexProps,
) => {
  const desired = desiredBody(news);
  return (
    normalizeEnum(index.queryScope, DEFAULT_QUERY_SCOPE) ===
      normalizeEnum(desired.queryScope, DEFAULT_QUERY_SCOPE) &&
    normalizeEnum(index.apiScope, DEFAULT_API_SCOPE) ===
      normalizeEnum(desired.apiScope, DEFAULT_API_SCOPE) &&
    (index.unique === true) === (desired.unique === true) &&
    (index.multikey === true) === (desired.multikey === true) &&
    jsonEqual(index.shardCount, desired.shardCount) &&
    (desired.density === undefined ||
      normalizeEnum(index.density, desired.density) ===
        normalizeEnum(desired.density, desired.density)) &&
    fieldsKey(index.fields) === fieldsKey(desired.fields)
  );
};

const getByName = (name: string) =>
  firestore
    .getProjectsDatabasesCollectionGroupsIndexes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnParent = (parent: string) =>
  firestore.listProjectsDatabasesCollectionGroupsIndexes.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.indexes ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    // The parent database is gone: it has no indexes.
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as firestore.GoogleFirestoreAdminV1Index[]),
    ),
  );

const nameFromOperation = (
  operation: firestore.GoogleLongrunningOperation,
): string | undefined =>
  stringFromMap(operation.response, "name") ??
  stringFromMap(operation.metadata, "index") ??
  stringFromMap(operation.metadata, "name");

const resolveCreatedIndexName = (
  operation: firestore.GoogleLongrunningOperation | undefined,
  parent: string,
  news: DatabasesCollectionGroupsIndexProps,
) =>
  Effect.gen(function* () {
    if (operation !== undefined) {
      const immediate = nameFromOperation(operation);
      if (immediate !== undefined) return immediate;
      if (operation.name !== undefined) {
        const latest = yield* firestore
          .getProjectsDatabasesOperations({ name: operation.name })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation)));
        const fromOp = nameFromOperation(latest);
        if (fromOp !== undefined) return fromOp;
      }
    }
    const match = (yield* listOnParent(parent)).find((index) =>
      matchesDesired(index, news),
    );
    if (match?.name !== undefined) return match.name;
    return yield* new IndexNotResolved({ name: `${parent}/indexes` });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((index) =>
      index
        ? Effect.succeed(index)
        : Effect.fail(new IndexNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (index) => index === undefined,
      () => new IndexStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.IndexStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const DatabasesCollectionGroupsIndexProvider = () =>
  Provider.succeed(DatabasesCollectionGroupsIndex, {
    stables: [
      "name",
      "indexId",
      "collectionGroup",
      "collectionGroupId",
      "database",
      "databaseId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousDatabase = databaseIdOf(
        olds?.database ?? output?.database ?? output?.databaseId ?? "",
      );
      const nextDatabase = databaseIdOf(news.database);
      const previousGroup = lastSegment(
        olds?.collectionGroup ?? output?.collectionGroupId ?? "",
      );
      const nextGroup = lastSegment(news.collectionGroup);
      const previousFields = fieldsKey(olds?.fields ?? output?.fields);
      const nextFields = fieldsKey(news.fields);
      const previousScope = normalizeEnum(
        olds?.queryScope ?? output?.queryScope,
        DEFAULT_QUERY_SCOPE,
      );
      const nextScope = normalizeEnum(news.queryScope, DEFAULT_QUERY_SCOPE);
      const previousApi = normalizeEnum(
        olds?.apiScope ?? output?.apiScope,
        DEFAULT_API_SCOPE,
      );
      const nextApi = normalizeEnum(news.apiScope, DEFAULT_API_SCOPE);
      const previousUnique = olds?.unique === true || output?.unique === true;
      const nextUnique = news.unique === true;
      const previousMultikey =
        olds?.multikey === true || output?.multikey === true;
      const nextMultikey = news.multikey === true;
      const previousDensity = (
        olds?.density ??
        output?.density ??
        ""
      ).toUpperCase();
      const nextDensity = (news.density ?? previousDensity).toUpperCase();
      const previousShards = olds?.shardCount ?? output?.shardCount;
      const nextShards = news.shardCount ?? previousShards;
      if (
        (previousDatabase.length > 0 && previousDatabase !== nextDatabase) ||
        (previousGroup.length > 0 && previousGroup !== nextGroup) ||
        previousFields !== nextFields ||
        previousScope !== nextScope ||
        previousApi !== nextApi ||
        previousUnique !== nextUnique ||
        previousMultikey !== nextMultikey ||
        (news.density !== undefined && previousDensity !== nextDensity) ||
        previousShards !== nextShards
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const name = output?.name;
      if (name === undefined || name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = collectionGroupParent(
        env.project,
        news.database,
        news.collectionGroup,
      );
      const body = desiredBody(news);

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;

      if (current === undefined) {
        const existing = yield* listOnParent(parent);
        current = existing.find((index) => matchesDesired(index, news));
      }

      if (current === undefined) {
        const created = yield* firestore
          .createProjectsDatabasesCollectionGroupsIndexes({
            parent,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        const name = yield* resolveCreatedIndexName(created, parent, news);
        current = yield* waitUntilExists(name);
      } else if (current.name !== undefined) {
        current = yield* waitUntilExists(current.name);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new IndexNotResolved({ name: `${parent}/indexes` });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* firestore
        .deleteProjectsDatabasesCollectionGroupsIndexes({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(output.name);
    }),
  });
