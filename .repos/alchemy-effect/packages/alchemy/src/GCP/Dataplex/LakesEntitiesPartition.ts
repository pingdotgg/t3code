import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  listChildResources,
  listEntities,
  listLakes,
  listPartitions,
  listZones,
  parseResourceName,
  replaceIfChanged,
  hasAlchemyLabelMap,
} from "./shared.ts";

export type LakesEntitiesPartitionProps = {
  /**
   * Parent entity. Full name
   * `projects/{project}/locations/{location}/lakes/{lake}/zones/{zone}/entities/{entity}`.
   * Immutable — changing it replaces the partition.
   */
  entity: string;
  /**
   * Ordered partition values matching the parent entity's partition
   * schema. Immutable — changing them replaces the partition.
   */
  values: string[];
  /**
   * Location of the partition data (`gs://bucket/path/key=value` or a
   * BigQuery table). Immutable — changing it replaces the partition.
   */
  location: string;
};

export type LakesEntitiesPartition = Resource<
  "GCP.Dataplex.LakesEntitiesPartition",
  LakesEntitiesPartitionProps,
  {
    /** Full resource name `.../entities/{entity}/partitions/{values}`. */
    name: string;
    /** Parent entity resource name. */
    entity: string;
    /** Project id. */
    project: string;
    /** Region id. */
    region: string;
    /** Ordered partition values. */
    values: string[];
    /** Data location. */
    location: string;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex metadata partition under a zone entity.
 *
 * Partitions have no labels or description field: `read` reports a
 * partition it finds without prior state as unowned, and `list` returns
 * the partitions of entities in Alchemy-labeled lakes. Identity is the parent entity plus `values`; changing
 * `entity`, `values`, or `location` replaces the partition.
 *
 * ### Creating a Partition
 * **Example:** Hive-style date partition
 * ```typescript
 * const partition = yield* GCP.Dataplex.LakesEntitiesPartition("Day", {
 *   entity: entity.name,
 *   values: ["2024-01-01"],
 *   location: `gs://${bucket.bucketName}/events/dt=2024-01-01`,
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const LakesEntitiesPartition = Resource<LakesEntitiesPartition>(
  "GCP.Dataplex.LakesEntitiesPartition",
);

export class LakesEntitiesPartitionNotResolved extends Data.TaggedError(
  "GCP.Dataplex.LakesEntitiesPartitionNotResolved",
)<{
  name: string;
}> {}

const encodeValue = (value: string) =>
  encodeURIComponent(encodeURIComponent(value));

const resourceNameOf = (entity: string, values: readonly string[]) =>
  `${entity}/partitions/${values.map(encodeValue).join("/")}`;

const toAttrs = (
  partition: dataplex.GoogleCloudDataplexV1Partition,
  project: string,
  entity: string,
) => {
  const name = partition.name ?? "";
  const parsed = parseResourceName(name, "partitions");
  return {
    name,
    entity: parsed.parent || entity,
    project: parsed.project || project,
    region: parsed.location,
    values: partition.values ?? [],
    location: partition.location ?? "",
    etag: partition.etag,
  };
};

const getByName = (name: string) =>
  dataplex
    .getProjectsLocationsLakesZonesEntitiesPartitions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedEntityNames = (project: string, region: string) =>
  Effect.gen(function* () {
    const lakes = (yield* listLakes(project, region)).filter((lake) =>
      hasAlchemyLabelMap(lake.labels),
    );
    const zones = yield* listChildResources(lakes, listZones);
    const named = zones.filter((zone) => (zone.name ?? "").length > 0);
    const tables = yield* Effect.forEach(
      named,
      (zone) => listEntities(zone.name!, "TABLES"),
      { concurrency: 4 },
    );
    const filesets = yield* Effect.forEach(
      named,
      (zone) => listEntities(zone.name!, "FILESETS"),
      { concurrency: 4 },
    );
    return [...tables.flat(), ...filesets.flat()]
      .map((entity) => entity.name)
      .filter((name): name is string => (name ?? "").length > 0);
  });

export const LakesEntitiesPartitionProvider = () =>
  Provider.succeed(LakesEntitiesPartition, {
    stables: ["name", "entity", "project", "region", "values"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEntity = olds?.entity ?? output?.entity;
      const nextEntity = news.entity ?? previousEntity;
      const previousValues = olds?.values ?? output?.values;
      const nextValues = news.values ?? previousValues;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (
        replaceIfChanged(previousEntity, nextEntity) ||
        (previousValues !== undefined &&
          nextValues !== undefined &&
          JSON.stringify(previousValues) !== JSON.stringify(nextValues)) ||
        replaceIfChanged(previousLocation, nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousEntity === nextEntity &&
            previousLocation === nextLocation &&
            previousValues !== undefined &&
            nextValues !== undefined &&
            JSON.stringify(previousValues) === JSON.stringify(nextValues),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const entity = olds?.entity ?? output?.entity ?? "";
      const values = olds?.values ?? output?.values ?? [];
      const name =
        output?.name ?? (entity ? resourceNameOf(entity, values) : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, entity);
      // No labels field: without prior state the partition may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const entities = yield* listOwnedEntityNames(env.project, env.region);
        const groups = yield* Effect.forEach(
          entities,
          (entity) =>
            listPartitions(entity).pipe(
              Effect.map((partitions) =>
                partitions.map((partition) =>
                  toAttrs(partition, env.project, entity),
                ),
              ),
            ),
          { concurrency: 4 },
        );
        return groups.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const entity = news.entity;
      const name = output?.name ?? resourceNameOf(entity, news.values);
      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsLakesZonesEntitiesPartitions({
            parent: entity,
            body: {
              values: news.values,
              location: news.location,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* getByName(name);
        }
      }

      if (current === undefined) {
        return yield* new LakesEntitiesPartitionNotResolved({ name });
      }

      return toAttrs(current, env.project, entity);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dataplex
        .deleteProjectsLocationsLakesZonesEntitiesPartitions({
          name: output.name,
          etag: output.etag,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
