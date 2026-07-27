import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord } from "./internal.ts";

export interface PlaceIndexProps {
  /**
   * Name of the place index. Immutable — changing it replaces the index.
   * @default ${app}-${stage}-${id}
   */
  indexName?: string;
  /**
   * Data provider for geocoding/search. Immutable — changing it replaces the
   * index. One of `Esri`, `Grab`, or `Here`.
   */
  dataSource: string;
  /**
   * How results of the operations that use this index will be stored.
   * `SingleUse` results can't be stored; `Storage` results can be cached.
   * @default "SingleUse"
   */
  intendedUse?: string;
  /**
   * Optional description of the place index resource.
   */
  description?: string;
  /**
   * Tags to associate with the place index.
   */
  tags?: Record<string, string>;
}

export interface PlaceIndex extends Resource<
  "AWS.Location.PlaceIndex",
  PlaceIndexProps,
  {
    /** Physical name of the place index. */
    indexName: string;
    /** ARN of the place index. */
    indexArn: string;
    /** Data provider backing the index. */
    dataSource: string;
    /** Intended use of the index results. */
    intendedUse: string | undefined;
    /** Description of the place index. */
    description: string | undefined;
    /** Tags currently associated with the index. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Location Service place index. A place index geocodes text and
 * positions against a chosen data provider. The data source is immutable;
 * the intended use and description can be updated in place.
 *
 * @resource
 * @section Creating Place Indexes
 * @example Basic Place Index
 * ```typescript
 * import * as Location from "alchemy/AWS/Location";
 *
 * const index = yield* Location.PlaceIndex("Places", {
 *   dataSource: "Esri",
 * });
 * ```
 *
 * @example Storage-Intent Place Index
 * ```typescript
 * const index = yield* Location.PlaceIndex("Geocoder", {
 *   dataSource: "Here",
 *   intendedUse: "Storage",
 *   description: "Cacheable geocoding index",
 * });
 * ```
 */
export const PlaceIndex = Resource<PlaceIndex>("AWS.Location.PlaceIndex");

const createIndexName = (
  id: string,
  props: { indexName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.indexName) return props.indexName;
    return yield* createPhysicalName({ id, maxLength: 100 });
  });

const readIndex = Effect.fn(function* (indexName: string) {
  const found = yield* location
    .describePlaceIndex({ IndexName: indexName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!found) return undefined;
  return {
    indexName: found.IndexName,
    indexArn: found.IndexArn,
    dataSource: found.DataSource,
    intendedUse: found.DataSourceConfiguration?.IntendedUse,
    description: found.Description ? found.Description : undefined,
    tags: toTagRecord(found.Tags),
  } satisfies PlaceIndex["Attributes"];
});

export const PlaceIndexProvider = () =>
  Provider.effect(
    PlaceIndex,
    Effect.gen(function* () {
      return {
        stables: ["indexName", "indexArn"],
        list: () =>
          Effect.gen(function* () {
            const names = yield* location.listPlaceIndexes.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Entries ?? []).map((entry) => entry.IndexName),
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              names,
              (name) => readIndex(name),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (attrs): attrs is PlaceIndex["Attributes"] => attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const indexName =
            output?.indexName ?? (yield* createIndexName(id, olds ?? {}));
          const state = yield* readIndex(indexName);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createIndexName(id, olds);
          const newName = yield* createIndexName(id, news);
          // Name and data source are immutable — either change forces a replace.
          if (oldName !== newName || olds.dataSource !== news.dataSource) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const indexName =
            output?.indexName ?? (yield* createIndexName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          let state = yield* readIndex(indexName);

          if (state === undefined) {
            yield* location
              .createPlaceIndex({
                IndexName: indexName,
                DataSource: news.dataSource,
                Description: news.description,
                DataSourceConfiguration: news.intendedUse
                  ? { IntendedUse: news.intendedUse }
                  : undefined,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            state = yield* readIndex(indexName);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created place index ${indexName}`),
              );
            }
          }

          if (
            state.description !== (news.description ?? undefined) ||
            (news.intendedUse !== undefined &&
              state.intendedUse !== news.intendedUse)
          ) {
            yield* location.updatePlaceIndex({
              IndexName: indexName,
              Description: news.description,
              DataSourceConfiguration: news.intendedUse
                ? { IntendedUse: news.intendedUse }
                : undefined,
            });
          }

          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* location.untagResource({
              ResourceArn: state.indexArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* location.tagResource({
              ResourceArn: state.indexArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }

          yield* session.note(state.indexArn);

          const final = yield* readIndex(indexName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled place index ${indexName}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* location
            .deletePlaceIndex({ IndexName: output.indexName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
