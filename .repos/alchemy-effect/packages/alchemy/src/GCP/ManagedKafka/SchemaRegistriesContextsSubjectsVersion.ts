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
  getContextSchemaVersion,
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

export type ContextSchemaReference = {
  /** Name of the referenced schema. */
  name?: string;
  /** Subject of the referenced schema. */
  subject?: string;
  /** Version of the referenced schema. */
  version?: number;
};

export type SchemaRegistriesContextsSubjectsVersionProps = {
  /**
   * Parent schema registry. Full name
   * `projects/{project}/locations/{location}/schemaRegistries/{id}` or
   * the registry id (combined with `location`). Immutable — changing it
   * replaces the version.
   */
  schemaRegistry: string;
  /**
   * Schema context. Immutable — changing it replaces the version.
   */
  context: string;
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
  references?: ContextSchemaReference[];
};

export type SchemaRegistriesContextsSubjectsVersion = Resource<
  "GCP.ManagedKafka.SchemaRegistriesContextsSubjectsVersion",
  SchemaRegistriesContextsSubjectsVersionProps,
  {
    /** Full resource name `.../contexts/{context}/subjects/{subject}/versions/{version}`. */
    name: string;
    /** Parent schema registry resource name. */
    schemaRegistry: string;
    /** Context id. */
    context: string;
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
    references: ContextSchemaReference[];
  },
  never,
  Providers
>;

/**
 * A schema version under a subject in a named context of a Managed Kafka
 * schema registry.
 *
 * Versions are immutable. Changing context, subject, registry, schema,
 * type, or version replaces the resource.
 *
 * ### Creating a Version
 * **Example:** Avro record in a context
 * ```typescript
 * const version =
 *   yield* GCP.ManagedKafka.SchemaRegistriesContextsSubjectsVersion(
 *     "OrderSchema",
 *     {
 *       schemaRegistry: registry.name,
 *       context: "prod",
 *       subject: "orders",
 *       schemaType: "AVRO",
 *       schema: JSON.stringify({
 *         type: "record",
 *         name: "Order",
 *         fields: [{ name: "id", type: "string" }],
 *       }),
 *     },
 *   );
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const SchemaRegistriesContextsSubjectsVersion =
  Resource<SchemaRegistriesContextsSubjectsVersion>(
    "GCP.ManagedKafka.SchemaRegistriesContextsSubjectsVersion",
  );

export class SchemaRegistriesContextsSubjectsVersionNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.SchemaRegistriesContextsSubjectsVersionNotResolved",
)<{
  name: string;
}> {}

const registryOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "schemaRegistries");

/**
 * Context-scoped subjects come back qualified as `:.{context}:{subject}`;
 * resource paths and attributes use the bare subject.
 */
const unqualifySubject = (subject: string | undefined, context: string) =>
  subject?.replace(`:.${context}:`, "");

const toAttrs = (
  version: kafka.SchemaVersion,
  schemaRegistry: string,
  context: string,
  project: string,
  location: string,
  name: string,
) => {
  const parsed = parseName(schemaRegistry, "schemaRegistries");
  return {
    name,
    schemaRegistry,
    context,
    project: parsed.project || project,
    location: parsed.location || location,
    subject: unqualifySubject(version.subject, context) ?? "",
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

export const SchemaRegistriesContextsSubjectsVersionProvider = () =>
  Provider.succeed(SchemaRegistriesContextsSubjectsVersion, {
    stables: [
      "name",
      "schemaRegistry",
      "context",
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
          (news.schemaType ?? olds?.schemaType ?? output?.schemaType ?? "") ||
        (olds?.context ?? output?.context ?? "") !== news.context;
      return replaceOnIdentity({
        previousId:
          olds?.subject !== undefined && olds.version !== undefined
            ? `${olds.context}/${olds.subject}/${olds.version}`
            : output !== undefined
              ? `${output.context}/${output.subject}/${output.version}`
              : undefined,
        nextId:
          news.subject !== undefined && news.version !== undefined
            ? `${news.context}/${news.subject}/${news.version}`
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
      const context = olds?.context ?? output?.context ?? "";
      const schemaRegistry =
        olds?.schemaRegistry !== undefined
          ? registryOf(olds.schemaRegistry, env.project, location)
          : (output?.schemaRegistry ?? "");
      const version = olds?.version ?? output?.version ?? "latest";
      const name =
        output?.name ??
        (schemaRegistry.length > 0 && context.length > 0
          ? versionName(
              subjectParent(schemaRegistry, subject, context),
              version,
            )
          : "");
      const existing = yield* getContextSchemaVersion(name);
      if (existing === undefined) return undefined;
      const resolvedName = versionName(
        subjectParent(schemaRegistry, existing.subject ?? subject, context),
        existing.version ?? version,
      );
      const attrs = toAttrs(
        existing,
        schemaRegistry,
        context,
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
              const contexts = (registry.contexts ?? []).filter(
                (context) => context.length > 0 && context !== ".",
              );
              return yield* Effect.forEach(
                contexts,
                (context) =>
                  Effect.gen(function* () {
                    const contextName = context.includes("/")
                      ? context
                      : `${registry.name}/contexts/${context}`;
                    const body = yield* kafka
                      .listProjectsLocationsSchemaRegistriesContextsSubjects({
                        parent: contextName,
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
                            typeof item === "string" &&
                            item !== OWNERSHIP_SUBJECT,
                        )
                      : [];
                    const contextId = parseName(contextName, "contexts").id;
                    return yield* Effect.forEach(
                      names,
                      (subject) =>
                        Effect.gen(function* () {
                          const listed = yield* kafka
                            .listProjectsLocationsSchemaRegistriesContextsSubjectsVersions(
                              {
                                parent: subjectParent(
                                  registry.name!,
                                  subject,
                                  contextId,
                                ),
                              },
                            )
                            .pipe(
                              Effect.catchTag(
                                ["NotFound", "SchemaRegistryRequiresCluster"],
                                () => Effect.succeed<kafka.HttpBody>({}),
                              ),
                            );
                          const ids = parseVersionList(
                            yield* parseHttpJson(listed),
                          );
                          return yield* Effect.forEach(
                            ids,
                            (version) =>
                              getContextSchemaVersion(
                                versionName(
                                  subjectParent(
                                    registry.name!,
                                    subject,
                                    contextId,
                                  ),
                                  version,
                                ),
                              ).pipe(
                                Effect.map((item) =>
                                  item
                                    ? toAttrs(
                                        item,
                                        registry.name!,
                                        contextId,
                                        env.project,
                                        parseName(
                                          registry.name!,
                                          "schemaRegistries",
                                        ).location,
                                        versionName(
                                          subjectParent(
                                            registry.name!,
                                            subject,
                                            contextId,
                                          ),
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
            }),
          { concurrency: 2 },
        );
        return versions
          .flat(3)
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
      const context = news.context;
      const parent = subjectParent(schemaRegistry, subject, context);
      const versionHint = news.version ?? output?.version;
      const name = output?.name ?? versionName(parent, versionHint ?? "latest");

      let current = yield* getContextSchemaVersion(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          kafka
            .createProjectsLocationsSchemaRegistriesContextsSubjectsVersions({
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
          .lookupVersionProjectsLocationsSchemaRegistriesContextsSubjects({
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
          (yield* getContextSchemaVersion(
            versionName(parent, news.version ?? "latest"),
          ));
        void created;
      }

      if (current === undefined) {
        return yield* new SchemaRegistriesContextsSubjectsVersionNotResolved({
          name,
        });
      }

      const resolved = versionName(
        subjectParent(
          schemaRegistry,
          unqualifySubject(current.subject, context) ?? subject,
          context,
        ),
        current.version ?? versionHint ?? "latest",
      );
      return toAttrs(
        current,
        schemaRegistry,
        context,
        env.project,
        location,
        resolved,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kafka
        .deleteProjectsLocationsSchemaRegistriesContextsSubjectsVersions({
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
        .deleteProjectsLocationsSchemaRegistriesContextsSubjectsVersions({
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
