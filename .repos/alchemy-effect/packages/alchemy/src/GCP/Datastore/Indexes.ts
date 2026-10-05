import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_ANCESTOR,
  desiredBody,
  getById,
  IndexNotResolved,
  indexIdFromOperation,
  listIndexes,
  matchesDesired,
  normalizeEnum,
  propertiesKey,
  toAttrs,
  toKind,
  waitForOperation,
  waitUntilDeletable,
  waitUntilExists,
  waitUntilGone,
  type IndexedProperty,
} from "./internal.ts";

export type IndexAncestor =
  | datastore.GoogleDatastoreAdminV1IndexAncestorEnum
  | (string & {});

export type { IndexedProperty };

export type IndexProps = {
  /**
   * Entity kind this composite index applies to. If omitted, a unique
   * kind is generated from the stack, stage, and logical id. Immutable
   * — changing it replaces the index.
   */
  kind?: string;
  /**
   * Ancestor mode (`NONE` or `ALL_ANCESTORS`). Immutable — changing it
   * replaces the index.
   * @default "NONE"
   */
  ancestor?: IndexAncestor;
  /**
   * Ordered indexed properties. Composite indexes need 2–100
   * properties; single-property indexes are built automatically and
   * cannot be created here. Immutable — changing properties replaces
   * the index.
   */
  properties: IndexedProperty[];
};

export type Index = Resource<
  "GCP.Datastore.Index",
  IndexProps,
  {
    /** Resource name `projects/{project}/indexes/{indexId}`. */
    name: string;
    /** Server-assigned index id. */
    indexId: string;
    /** Project id. */
    project: string;
    /** Entity kind. */
    kind: string;
    /** Ancestor mode. */
    ancestor: string | undefined;
    /** Serving state (`CREATING`, `READY`, `DELETING`, `ERROR`). */
    state: string | undefined;
    /** Indexed properties. */
    properties: IndexedProperty[];
  },
  never,
  Providers
>;

/**
 * A Cloud Datastore composite index.
 *
 * Indexes apply to the project's default Datastore-mode database.
 * The index id is assigned by the API. Kind, ancestor mode, and
 * properties are immutable — changing them replaces the index.
 * Indexes have no labels field, so Alchemy tracks an index by the id in
 * state; without state an index with the same definition is adopted when
 * its kind is the generated one and reported as unowned otherwise.
 *
 * ### Creating an Index
 * **Example:** Composite index on a kind
 * ```typescript
 * const index = yield* GCP.Datastore.Index("TasksByDone", {
 *   kind: "Task",
 *   ancestor: "NONE",
 *   properties: [
 *     { name: "done", direction: "ASCENDING" },
 *     { name: "priority", direction: "DESCENDING" },
 *   ],
 * });
 * ```
 *
 * **Example:** Ancestor index
 * ```typescript
 * const index = yield* GCP.Datastore.Index("CommentsByCreated", {
 *   kind: "Comment",
 *   ancestor: "ALL_ANCESTORS",
 *   properties: [
 *     { name: "created", direction: "DESCENDING" },
 *     { name: "author", direction: "ASCENDING" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Datastore
 */
export const Index = Resource<Index>("GCP.Datastore.Index");

export { IndexNotResolved, IndexStillExists } from "./internal.ts";

const replaceOnIdentity = (input: {
  previousKind: string;
  nextKind: string;
  previousAncestor: string;
  nextAncestor: string;
  previousProperties: string;
  nextProperties: string;
}) => {
  if (
    (input.previousKind.length > 0 && input.previousKind !== input.nextKind) ||
    (input.previousAncestor.length > 0 &&
      input.previousAncestor !== input.nextAncestor) ||
    (input.previousProperties.length > 0 &&
      input.previousProperties !== input.nextProperties)
  ) {
    return { action: "replace" as const };
  }
  return undefined;
};

export const IndexProvider = () =>
  Provider.succeed(Index, {
    stables: ["name", "indexId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousKind: olds?.kind ?? output?.kind ?? "",
        nextKind: news.kind ?? output?.kind ?? "",
        previousAncestor: normalizeEnum(
          olds?.ancestor ?? output?.ancestor,
          DEFAULT_ANCESTOR,
        ),
        nextAncestor: normalizeEnum(news.ancestor, DEFAULT_ANCESTOR),
        previousProperties: propertiesKey(
          olds?.properties ?? output?.properties,
        ),
        nextProperties: propertiesKey(news.properties),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (output?.indexId !== undefined && output.indexId.length > 0) {
        const existing = yield* getById(env.project, output.indexId);
        return existing === undefined
          ? undefined
          : toAttrs(existing, env.project);
      }
      if (olds === undefined) return undefined;
      // Indexes have no labels; an index is identified by its definition.
      const generatedKind = yield* toKind(id, undefined, undefined);
      const kind = olds.kind ?? generatedKind;
      const found = (yield* listIndexes(env.project)).find((index) =>
        matchesDesired(index, {
          kind,
          ancestor: olds.ancestor,
          properties: olds.properties,
        }),
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      // A generated kind is unique to this stack, stage and id.
      return kind === generatedKind ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const kind = yield* toKind(id, news.kind, output?.kind);
      const ancestor = normalizeEnum(news.ancestor, DEFAULT_ANCESTOR);
      const body = desiredBody({
        kind,
        ancestor,
        properties: news.properties,
      });
      let current =
        output?.indexId !== undefined && output.indexId.length > 0
          ? yield* getById(env.project, output.indexId)
          : undefined;

      if (current === undefined) {
        current = (yield* listIndexes(env.project)).find((index) =>
          matchesDesired(index, {
            kind,
            ancestor,
            properties: news.properties,
          }),
        );
      }

      if (current === undefined) {
        const created = yield* datastore
          .createProjectsIndexes({
            projectId: env.project,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          let indexId = indexIdFromOperation(created);
          if (indexId === undefined && created.name !== undefined) {
            const operation = yield* waitForOperation(created);
            indexId = indexIdFromOperation(operation);
          }
          if (indexId !== undefined) {
            current = yield* waitUntilExists(env.project, indexId);
          }
        }
        if (current === undefined) {
          current = (yield* listIndexes(env.project)).find((index) =>
            matchesDesired(index, {
              kind,
              ancestor,
              properties: news.properties,
            }),
          );
        }
      }

      if (current === undefined || current.indexId === undefined) {
        return yield* new IndexNotResolved({
          indexId: output?.indexId ?? "",
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      if (output.indexId.length > 0) {
        yield* waitUntilDeletable(env.project, output.indexId).pipe(
          Effect.catchTag("GCP.Datastore.IndexNotResolved", () => Effect.void),
        );
        yield* datastore
          .deleteProjectsIndexes({
            projectId: env.project,
            indexId: output.indexId,
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "Conflict" || error._tag === "BadRequest",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        yield* waitUntilGone(env.project, output.indexId);
      }
    }),
  });
