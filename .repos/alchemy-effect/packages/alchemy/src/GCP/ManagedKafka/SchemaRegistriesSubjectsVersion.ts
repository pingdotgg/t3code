import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  getSchemaVersion,
  hasAlchemyLabelMap,
  listSchemaRegistries,
  normalizeLocation,
  OWNERSHIP_SUBJECT,
  parseHttpJson,
  parseName,
  replaceOnIdentity,
  retryTransient,
  schemaRegistryOwnership,
  subjectParent,
  toSubjectId,
  versionName,
} from "./internal.ts";

export type SchemaReference = {
  /** Name of the referenced schema. */
  name?: string;
  /** Subject of the referenced schema. */
  subject?: string;
  /** Version of the referenced schema. */
  version?: number;
};

export type SchemaRegistriesSubjectsVersionProps = {
  /**
   * Parent schema registry. Full name
   * `projects/{project}/locations/{location}/schemaRegistries/{id}` or
   * the registry id (combined with `location`). Immutable — changing it
   * replaces the version.
   */
  schemaRegistry: string;
  /**
   * Region used when `schemaRegistry` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Subject name. If omitted, a unique name is generated. Immutable —
   * changing it replaces the version.
   */
  subject?: string;
  /**
   * Version number. If omitted, the server assigns the next id.
   * Immutable — changing it replaces the version.
   */
  version?: number;
  /**
   * Schema payload. Immutable — changing it replaces the version.
   */
  schema: string;
  /**
   * Schema type.
   * @default "AVRO"
   */
  schemaType?: kafka.CreateVersionRequestSchemaTypeEnum | (string & {});
  /**
   * Normalize the schema before storing.
   * @default false
   */
  normalize?: boolean;
  /**
   * Explicit schema id. Must not collide with a different schema.
   */
  id?: number;
  /**
   * Schema references.
   */
  references?: SchemaReference[];
};

export type SchemaRegistriesSubjectsVersion = Resource<
  "GCP.ManagedKafka.SchemaRegistriesSubjectsVersion",
  SchemaRegistriesSubjectsVersionProps,
  {
    /** Full resource name `.../subjects/{subject}/versions/{version}`. */
    name: string;
    /** Parent schema registry resource name. */
    schemaRegistry: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Subject name. */
    subject: string;
    /** Version number. */
    version: number;
    /** Schema id. */
    schemaId: number | undefined;
    /** Schema payload. */
    schema: string | undefined;
    /** Schema type. */
    schemaType: string | undefined;
    /** Schema references. */
    references: SchemaReference[];
  },
  never,
  Providers
>;

/**
 * A schema version under a subject in a Managed Kafka schema registry
 * (default context).
 *
 * Versions are immutable. Changing subject, registry, schema, type, or
 * version replaces the resource.
 *
 * ### Creating a Version
 * **Example:** Avro record
 * ```typescript
 * const version = yield* GCP.ManagedKafka.SchemaRegistriesSubjectsVersion(
 *   "OrderSchema",
 *   {
 *     schemaRegistry: registry.name,
 *     subject: "orders",
 *     schemaType: "AVRO",
 *     schema: JSON.stringify({
 *       type: "record",
 *       name: "Order",
 *       fields: [{ name: "id", type: "string" }],
 *     }),
 *   },
 * );
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const SchemaRegistriesSubjectsVersion =
  Resource<SchemaRegistriesSubjectsVersion>(
    "GCP.ManagedKafka.SchemaRegistriesSubjectsVersion",
  );

export class SchemaRegistriesSubjectsVersionNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.SchemaRegistriesSubjectsVersionNotResolved",
)<{
  name: string;
}> {}

const registryOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "schemaRegistries");

const toAttrs = (
  version: kafka.SchemaVersion,
  schemaRegistry: string,
  project: string,
  location: string,
  name: string,
) => {
  const parsed = parseName(schemaRegistry, "schemaRegistries");
  return {
    name,
    schemaRegistry,
    project: parsed.project || project,
    location: parsed.location || location,
    subject: version.subject ?? "",
    version: version.version ?? 0,
    schemaId: version.id,
    schema: version.schema,
    schemaType: version.schemaType,
    references: version.references ?? [],
  };
};

const parseVersionList = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "number") return item;
      if (typeof item === "string") return Number(item);
      if (item && typeof item === "object" && "version" in item) {
        return Number((item as { version?: unknown }).version);
      }
      return Number.NaN;
    })
    .filter((item) => Number.isFinite(item));
};

export const SchemaRegistriesSubjectsVersionProvider = () =>
  Provider.succeed(SchemaRegistriesSubjectsVersion, {
    stables: [
      "name",
      "schemaRegistry",
      "project",
      "location",
      "subject",
      "version",
      "schemaId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const schemaChanged =
        (olds?.schema ?? output?.schema ?? "") !== news.schema ||
        (olds?.schemaType ?? output?.schemaType ?? "") !==
          (news.schemaType ?? olds?.schemaType ?? output?.schemaType ?? "");
      return replaceOnIdentity({
        previousId:
          olds?.subject !== undefined && olds.version !== undefined
            ? `${olds.subject}/${olds.version}`
            : output !== undefined
              ? `${output.subject}/${output.version}`
              : undefined,
        nextId:
          news.subject !== undefined && news.version !== undefined
            ? `${news.subject}/${news.version}`
            : undefined,
        previousParent: olds?.schemaRegistry ?? output?.schemaRegistry,
        nextParent: registryOf(news.schemaRegistry, env.project, location),
        extra: schemaChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const subject = yield* toSubjectId(id, olds?.subject, output?.subject);
      const schemaRegistry =
        olds?.schemaRegistry !== undefined
          ? registryOf(olds.schemaRegistry, env.project, location)
          : (output?.schemaRegistry ?? "");
      const version = olds?.version ?? output?.version ?? "latest";
      const name =
        output?.name ??
        (schemaRegistry.length > 0
          ? versionName(subjectParent(schemaRegistry, subject), version)
          : "");
      const existing = yield* getSchemaVersion(name);
      if (existing === undefined) return undefined;
      const resolvedName = versionName(
        subjectParent(schemaRegistry, existing.subject ?? subject),
        existing.version ?? version,
      );
      const attrs = toAttrs(
        existing,
        schemaRegistry,
        env.project,
        location,
        resolvedName,
      );
      return output !== undefined || olds !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const registries = yield* listSchemaRegistries(env.project, env.region);
        const owned = yield* Effect.forEach(
          registries.filter((registry) => (registry.name ?? "").length > 0),
          (registry) =>
            schemaRegistryOwnership(registry.name!).pipe(
              Effect.map((labels) =>
                hasAlchemyLabelMap(labels) ? registry : undefined,
              ),
            ),
          { concurrency: 4 },
        );
        const versions = yield* Effect.forEach(
          owned.filter(
            (registry): registry is kafka.SchemaRegistry =>
              registry !== undefined,
          ),
          (registry) =>
            Effect.gen(function* () {
              const body = yield* kafka
                .listProjectsLocationsSchemaRegistriesSubjects({
                  parent: registry.name!,
                })
                .pipe(
                  Effect.catchTag(
                    ["NotFound", "SchemaRegistryRequiresCluster"],
                    () => Effect.succeed<kafka.HttpBody>({}),
                  ),
                );
              const subjects = (yield* parseHttpJson(body)) as unknown;
              const names = Array.isArray(subjects)
                ? subjects.filter(
                    (item): item is string =>
                      typeof item === "string" && item !== OWNERSHIP_SUBJECT,
                  )
                : [];
              return yield* Effect.forEach(
                names,
                (subject) =>
                  Effect.gen(function* () {
                    const listed = yield* kafka
                      .listProjectsLocationsSchemaRegistriesSubjectsVersions({
                        parent: subjectParent(registry.name!, subject),
                      })
                      .pipe(
                        Effect.catchTag(
                          ["NotFound", "SchemaRegistryRequiresCluster"],
                          () => Effect.succeed<kafka.HttpBody>({}),
                        ),
                      );
                    const ids = parseVersionList(yield* parseHttpJson(listed));
                    return yield* Effect.forEach(
                      ids,
                      (version) =>
                        getSchemaVersion(
                          versionName(
                            subjectParent(registry.name!, subject),
                            version,
                          ),
                        ).pipe(
                          Effect.map((item) =>
                            item
                              ? toAttrs(
                                  item,
                                  registry.name!,
                                  env.project,
                                  parseName(registry.name!, "schemaRegistries")
                                    .location,
                                  versionName(
                                    subjectParent(registry.name!, subject),
                                    version,
                                  ),
                                )
                              : undefined,
                          ),
                        ),
                      { concurrency: 4 },
                    );
                  }),
                { concurrency: 4 },
              );
            }),
          { concurrency: 2 },
        );
        return versions
          .flat(2)
          .filter(
            (item): item is NonNullable<typeof item> => item !== undefined,
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const schemaRegistry = registryOf(
        news.schemaRegistry,
        env.project,
        location,
      );
      const subject = yield* toSubjectId(id, news.subject, output?.subject);
      const parent = subjectParent(schemaRegistry, subject);
      const versionHint = news.version ?? output?.version;
      const name = output?.name ?? versionName(parent, versionHint ?? "latest");

      let current = yield* getSchemaVersion(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          kafka
            .createProjectsLocationsSchemaRegistriesSubjectsVersions({
              parent,
              body: {
                schemaType: news.schemaType,
                version: news.version,
                normalize: news.normalize,
                id: news.id,
                schema: news.schema,
                references: news.references,
              },
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined))),
        );
        const lookedUp = yield* kafka
          .lookupVersionProjectsLocationsSchemaRegistriesSubjects({
            parent,
            body: {
              schema: news.schema,
              schemaType: news.schemaType,
              normalize: news.normalize,
              references: news.references,
            },
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        current =
          lookedUp ??
          (yield* getSchemaVersion(
            versionName(parent, news.version ?? "latest"),
          ));
        void created;
      }

      if (current === undefined) {
        return yield* new SchemaRegistriesSubjectsVersionNotResolved({
          name,
        });
      }

      const resolved = versionName(
        subjectParent(schemaRegistry, current.subject ?? subject),
        current.version ?? versionHint ?? "latest",
      );
      return toAttrs(current, schemaRegistry, env.project, location, resolved);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kafka
        .deleteProjectsLocationsSchemaRegistriesSubjectsVersions({
          name: output.name,
          permanent: false,
        })
        .pipe(
          Effect.catchTag(
            [
              "NotFound",
              "SchemaRegistryRequiresCluster",
              "SchemaRegistryPathNotFound",
            ],
            () => Effect.void,
          ),
        );
      yield* kafka
        .deleteProjectsLocationsSchemaRegistriesSubjectsVersions({
          name: output.name,
          permanent: true,
        })
        .pipe(
          Effect.catchTag(
            [
              "NotFound",
              "SchemaRegistryRequiresCluster",
              "SchemaRegistryPathNotFound",
            ],
            () => Effect.void,
          ),
        );
    }),
  });
