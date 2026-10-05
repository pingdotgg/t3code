import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fingerprint,
  lastSegment,
  listChildResources,
  listEntities,
  listLakes,
  listZones,
  parseResourceName,
  replaceIfChanged,
  toPhysicalSnake,
  hasAlchemyLabelMap,
} from "./shared.ts";

export type EntitySchemaField = {
  /** Field name (letters, numbers, underscores). */
  name: string;
  /** Field description. */
  description?: string;
  /** Field type (`STRING`, `INT64`, …). */
  type: dataplex.GoogleCloudDataplexV1SchemaSchemaFieldTypeEnum | (string & {});
  /** Field mode (`REQUIRED`, `NULLABLE`, `REPEATED`). */
  mode: dataplex.GoogleCloudDataplexV1SchemaSchemaFieldModeEnum | (string & {});
  /** Nested fields for `RECORD` types. */
  fields?: EntitySchemaField[];
};

export type EntityPartitionField = {
  /** Partition field name. Immutable. */
  name: string;
  /** Partition field type. Immutable. */
  type:
    | dataplex.GoogleCloudDataplexV1SchemaPartitionFieldTypeEnum
    | (string & {});
};

export type EntitySchema = {
  /**
   * When true, Dataplex will not evolve the schema.
   * @default true
   */
  userManaged?: boolean;
  /** Sequence of data fields. */
  fields?: EntitySchemaField[];
  /** Partition keys. Immutable once set. */
  partitionFields?: EntityPartitionField[];
  /** Partition path style (`HIVE_COMPATIBLE`). */
  partitionStyle?:
    | dataplex.GoogleCloudDataplexV1SchemaPartitionStyleEnum
    | (string & {});
};

export type EntityStorageFormat = {
  /** File format (`PARQUET`, `CSV`, `JSON`, …). */
  format?:
    | dataplex.GoogleCloudDataplexV1StorageFormatFormatEnum
    | (string & {});
  /** Compression (`GZIP`, `BZIP2`). */
  compressionFormat?:
    | dataplex.GoogleCloudDataplexV1StorageFormatCompressionFormatEnum
    | (string & {});
  /**
   * MIME type. Derived from `format` for PARQUET, AVRO, ORC, CSV, and JSON
   * when omitted.
   */
  mimeType?: string;
};

// Dataplex requires `format.mimeType`; derive it from the file format when
// the caller only names the format.
const MIME_TYPES: Record<string, string> = {
  PARQUET: "application/x-parquet",
  AVRO: "application/x-avro",
  ORC: "application/x-orc",
  CSV: "text/csv",
  JSON: "application/json",
};

const withMimeType = (
  format: EntityStorageFormat | undefined,
): EntityStorageFormat | undefined => {
  if (format === undefined || format.mimeType !== undefined) return format;
  const mimeType = MIME_TYPES[(format.format ?? "").toUpperCase()];
  return mimeType === undefined ? format : { ...format, mimeType };
};

export type LakesEntityProps = {
  /**
   * Parent zone. Full name
   * `projects/{project}/locations/{location}/lakes/{lake}/zones/{zone}`.
   * Immutable — changing it replaces the entity.
   */
  zone: string;
  /**
   * Entity id used as the published table name. Letters, numbers, and
   * underscores; at most 256 characters. Immutable — changing it
   * replaces the entity.
   */
  entityId?: string;
  /**
   * User-friendly display name (at most 256 characters).
   */
  displayName?: string;
  /**
   * Description (at most 1024 characters).
   */
  description?: string;
  /**
   * Entity type. Immutable — changing it replaces the entity.
   * @default "TABLE"
   */
  type?: dataplex.GoogleCloudDataplexV1EntityTypeEnum | (string & {});
  /**
   * Asset id (not a full resource name) that stores the entity data.
   * Immutable — changing it replaces the entity.
   */
  asset: string;
  /**
   * Storage path (`gs://bucket/path` or a BigQuery table name). Immutable
   * — changing it replaces the entity.
   */
  dataPath: string;
  /**
   * Glob of objects that constitute the entity data.
   */
  dataPathPattern?: string;
  /**
   * Storage system. Immutable — changing it replaces the entity.
   * @default "CLOUD_STORAGE"
   */
  system?: dataplex.GoogleCloudDataplexV1EntitySystemEnum | (string & {});
  /**
   * Storage format. Required for Cloud Storage entities.
   */
  format?: EntityStorageFormat;
  /**
   * Schema. Defaults to a user-managed empty schema when omitted.
   */
  schema?: EntitySchema;
};

export type LakesEntity = Resource<
  "GCP.Dataplex.LakesEntity",
  LakesEntityProps,
  {
    /** Full resource name `.../zones/{zone}/entities/{entity}`. */
    name: string;
    /** Entity id. */
    entityId: string;
    /** Parent zone resource name. */
    zone: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Entity description. */
    description: string | undefined;
    /** Entity type (`TABLE` or `FILESET`). */
    type: string | undefined;
    /** Asset id. */
    asset: string | undefined;
    /** Storage path. */
    dataPath: string | undefined;
    /** Storage system. */
    system: string | undefined;
    /** Storage format. */
    format: string | undefined;
    /** Data Catalog entry name. */
    catalogEntry: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** Server-assigned uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex metadata entity — a table or fileset registered in a zone.
 *
 * Entities have no labels field: `read` reports an entity it finds
 * without prior state as unowned (adopt it with `--adopt`), and `list`
 * returns the entities of Alchemy-labeled lakes. Changing `zone`, `entityId`, `type`,
 * `asset`, `dataPath`, or `system` replaces the entity. Display name,
 * description, format, and schema update in place.
 *
 * ### Creating an Entity
 * **Example:** User-managed Parquet table
 * ```typescript
 * const entity = yield* GCP.Dataplex.LakesEntity("Events", {
 *   zone: zone.name,
 *   asset: asset.assetId,
 *   type: "TABLE",
 *   system: "CLOUD_STORAGE",
 *   dataPath: `gs://${bucket.bucketName}/events`,
 *   format: { format: "PARQUET" },
 *   schema: {
 *     userManaged: true,
 *     fields: [{ name: "id", type: "STRING", mode: "REQUIRED" }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const LakesEntity = Resource<LakesEntity>("GCP.Dataplex.LakesEntity");

export class LakesEntityNotResolved extends Data.TaggedError(
  "GCP.Dataplex.LakesEntityNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_TYPE = "TABLE";
const DEFAULT_SYSTEM = "CLOUD_STORAGE";

const resourceNameOf = (zone: string, entityId: string) =>
  `${zone}/entities/${entityId}`;

const assetIdOf = (asset: string) => lastSegment(asset);

const schemaBody = (
  schema: EntitySchema | undefined,
): dataplex.GoogleCloudDataplexV1Schema => ({
  userManaged: schema?.userManaged !== false,
  fields: schema?.fields,
  partitionFields: schema?.partitionFields,
  partitionStyle: schema?.partitionStyle,
});

const toAttrs = (
  entity: dataplex.GoogleCloudDataplexV1Entity,
  project: string,
) => {
  const name = entity.name ?? "";
  const parsed = parseResourceName(name, "entities");
  return {
    name,
    entityId: entity.id ?? parsed.id,
    zone: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: entity.displayName,
    description: entity.description,
    type: entity.type,
    asset: entity.asset,
    dataPath: entity.dataPath,
    system: entity.system,
    format: entity.format?.format,
    catalogEntry: entity.catalogEntry,
    etag: entity.etag,
    uid: entity.uid,
    createTime: entity.createTime,
    updateTime: entity.updateTime,
  };
};

const getByName = (name: string) =>
  dataplex
    .getProjectsLocationsLakesZonesEntities({ name, view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedEntities = (project: string, region: string) =>
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
    return [...tables.flat(), ...filesets.flat()];
  });

export const LakesEntityProvider = () =>
  Provider.succeed(LakesEntity, {
    stables: [
      "name",
      "entityId",
      "zone",
      "project",
      "location",
      "type",
      "asset",
      "system",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.entityId ?? output?.entityId;
      const nextId = news.entityId ?? previousId;
      const previousZone = olds?.zone ?? output?.zone;
      const nextZone = news.zone ?? previousZone;
      const previousType = (
        olds?.type ??
        output?.type ??
        DEFAULT_TYPE
      ).toUpperCase();
      const nextType = (news.type ?? previousType).toUpperCase();
      const previousAsset = assetIdOf(olds?.asset ?? output?.asset ?? "");
      const nextAsset = assetIdOf(news.asset);
      const previousPath = olds?.dataPath ?? output?.dataPath ?? "";
      const nextPath = news.dataPath;
      const previousSystem = (
        olds?.system ??
        output?.system ??
        DEFAULT_SYSTEM
      ).toUpperCase();
      const nextSystem = (news.system ?? previousSystem).toUpperCase();
      if (
        replaceIfChanged(previousId, nextId) ||
        replaceIfChanged(previousZone, nextZone) ||
        previousType !== nextType ||
        previousAsset !== nextAsset ||
        previousPath !== nextPath ||
        previousSystem !== nextSystem
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousZone === nextZone &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const zone = olds?.zone ?? output?.zone ?? "";
      const entityId = yield* toPhysicalSnake(
        id,
        olds?.entityId,
        output?.entityId,
      );
      const name = output?.name ?? resourceNameOf(zone, entityId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state the entity may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const entities = yield* listOwnedEntities(env.project, env.region);
        const resolved = yield* Effect.forEach(
          entities,
          (entity) =>
            entity.name
              ? getByName(entity.name).pipe(
                  Effect.map((full) => full ?? entity),
                )
              : Effect.succeed(entity),
          { concurrency: 4 },
        );
        return resolved.map((entity) => toAttrs(entity, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const zone = news.zone;
      const entityId = yield* toPhysicalSnake(
        id,
        news.entityId,
        output?.entityId,
      );
      const name = output?.name ?? resourceNameOf(zone, entityId);
      const description = news.description;
      const type = (news.type ?? DEFAULT_TYPE).toUpperCase();
      const system = (news.system ?? DEFAULT_SYSTEM).toUpperCase();
      const asset = assetIdOf(news.asset);
      const schema = schemaBody(news.schema);
      const format = withMimeType(news.format);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsLakesZonesEntities({
            parent: zone,
            body: {
              id: entityId,
              displayName: news.displayName,
              description,
              type,
              asset,
              dataPath: news.dataPath,
              dataPathPattern: news.dataPathPattern,
              system,
              format,
              schema,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LakesEntityNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== (description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const patternChanged =
        (current.dataPathPattern ?? "") !== (news.dataPathPattern ?? "");
      const formatChanged = fingerprint(current.format) !== fingerprint(format);
      const schemaChanged = fingerprint(current.schema) !== fingerprint(schema);

      if (
        descriptionChanged ||
        displayNameChanged ||
        patternChanged ||
        formatChanged ||
        schemaChanged
      ) {
        current = yield* dataplex.updateProjectsLocationsLakesZonesEntities({
          name: current.name ?? name,
          body: {
            id: entityId,
            etag: current.etag,
            displayName: news.displayName,
            description,
            type,
            asset,
            dataPath: news.dataPath,
            dataPathPattern: news.dataPathPattern,
            system,
            format,
            schema,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Delete requires the current etag, which moves while partitions are
      // removed and discovery runs, so re-read it on every attempt.
      yield* getByName(output.name).pipe(
        Effect.flatMap((existing) =>
          existing === undefined
            ? Effect.void
            : dataplex.deleteProjectsLocationsLakesZonesEntities({
                name: output.name,
                etag: existing.etag,
              }),
        ),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 10,
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
