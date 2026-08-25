import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

/**
 * Rendering configuration for a map. `style` selects the base map style and is
 * immutable — changing it replaces the map.
 */
export interface MapConfiguration {
  /**
   * The map style. Selecting a style determines the map's data provider
   * (Esri, HERE, or Grab). Immutable — changing the style replaces the map.
   *
   * Common values: `VectorEsriNavigation`, `VectorEsriStreets`,
   * `VectorHereExplore`, `RasterHereExploreSatellite`,
   * `VectorGrabStandardLight`.
   */
  style: string;
  /**
   * Political view (an ISO 3166-1 alpha-3 country code) applied to the map's
   * disputed borders and labels.
   */
  politicalView?: string;
}

export interface MapProps {
  /**
   * Name of the map resource. Immutable — changing it replaces the map.
   * @default ${app}-${stage}-${id}
   */
  mapName?: string;
  /**
   * Rendering configuration for the map (base style + political view).
   */
  configuration: MapConfiguration;
  /**
   * Optional description of the map resource.
   */
  description?: string;
  /**
   * Tags to associate with the map.
   */
  tags?: Record<string, string>;
}

export interface Map extends Resource<
  "AWS.Location.Map",
  MapProps,
  {
    /** Physical name of the map resource. */
    mapName: string;
    /** ARN of the map resource. */
    mapArn: string;
    /** The map style selected at creation. */
    style: string;
    /** Political view currently applied to the map, if any. */
    politicalView: string | undefined;
    /** Data provider backing the map, derived from the style. */
    dataSource: string;
    /** Description of the map resource. */
    description: string | undefined;
    /** Tags currently associated with the map. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Location Service map resource. A map exposes vector/raster tiles,
 * glyphs, and sprites for a chosen base style. The map style is immutable;
 * the political view and description can be updated in place.
 *
 * @resource
 * @section Creating Maps
 * @example Basic Map
 * ```typescript
 * import * as Location from "alchemy/AWS/Location";
 *
 * const map = yield* Location.Map("AppMap", {
 *   configuration: { style: "VectorEsriNavigation" },
 * });
 * ```
 *
 * @example Map with Political View
 * ```typescript
 * const map = yield* Location.Map("RegionMap", {
 *   configuration: { style: "VectorHereExplore", politicalView: "IND" },
 *   description: "Map with India political view",
 * });
 * ```
 */
export const Map = Resource<Map>("AWS.Location.Map");

const createMapName = (id: string, props: { mapName?: string | undefined }) =>
  Effect.gen(function* () {
    if (props.mapName) return props.mapName;
    return yield* createPhysicalName({ id, maxLength: 100 });
  });

const readMap = Effect.fn(function* (mapName: string) {
  const found = yield* location
    .describeMap({ MapName: mapName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!found) return undefined;
  return {
    mapName: found.MapName,
    mapArn: found.MapArn,
    style: found.Configuration.Style,
    politicalView: Redacted.isRedacted(found.Configuration.PoliticalView)
      ? Redacted.value(found.Configuration.PoliticalView)
      : found.Configuration.PoliticalView,
    dataSource: found.DataSource,
    description: found.Description ? found.Description : undefined,
    tags: toTagRecord(found.Tags),
  } satisfies Map["Attributes"];
});

export const MapProvider = () =>
  Provider.effect(
    Map,
    Effect.gen(function* () {
      return {
        stables: ["mapName", "mapArn"],
        list: () =>
          Effect.gen(function* () {
            const names = yield* location.listMaps.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Entries ?? []).map((entry) => entry.MapName),
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              names,
              (name) => readMap(name),
              {
                concurrency: 10,
              },
            );
            return hydrated.filter(
              (attrs): attrs is Map["Attributes"] => attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const mapName =
            output?.mapName ?? (yield* createMapName(id, olds ?? {}));
          const state = yield* readMap(mapName);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createMapName(id, olds);
          const newName = yield* createMapName(id, news);
          // Name and base style are immutable — either change forces a replace.
          if (
            oldName !== newName ||
            olds.configuration?.style !== news.configuration?.style
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const mapName = output?.mapName ?? (yield* createMapName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative; output is only a name cache.
          let state = yield* readMap(mapName);

          // Ensure — create if missing; tolerate a concurrent create.
          if (state === undefined) {
            yield* location
              .createMap({
                MapName: mapName,
                Configuration: {
                  Style: news.configuration.style,
                  PoliticalView: news.configuration.politicalView,
                },
                Description: news.description,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            state = yield* readMap(mapName);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created map ${mapName}`),
              );
            }
          }

          // Sync description + political view.
          if (
            state.description !== (news.description ?? undefined) ||
            state.politicalView !==
              (news.configuration.politicalView ?? undefined)
          ) {
            yield* location.updateMap({
              MapName: mapName,
              Description: news.description,
              ConfigurationUpdate: {
                PoliticalView: news.configuration.politicalView,
              },
            });
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* location.untagResource({
              ResourceArn: state.mapArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* location.tagResource({
              ResourceArn: state.mapArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }

          yield* session.note(state.mapArn);

          const final = yield* readMap(mapName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled map ${mapName}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* location
            .deleteMap({ MapName: output.mapName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
