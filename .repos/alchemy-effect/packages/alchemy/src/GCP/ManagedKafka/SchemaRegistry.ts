import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getSchemaRegistry,
  hasAlchemyLabelMap,
  hasSchemaRegistryOwnership,
  listSchemaRegistries,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryTransient,
  schemaRegistryIdOf,
  schemaRegistryOwnership,
  stampSchemaRegistryOwnership,
  toSchemaRegistryId,
} from "./internal.ts";

export type SchemaRegistryProps = {
  /**
   * Schema registry id. Letters, numbers, and underscores; max 63
   * characters; must not start with a number. If omitted, a unique id is
   * generated. Immutable — changing it replaces the registry.
   */
  schemaRegistryId?: string;
  /**
   * Region (`us-central1`, …). Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
};

export type SchemaRegistry = Resource<
  "GCP.ManagedKafka.SchemaRegistry",
  SchemaRegistryProps,
  {
    /** Full resource name `.../schemaRegistries/{schemaRegistry}`. */
    name: string;
    /** Schema registry id. */
    schemaRegistryId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Contexts currently present. */
    contexts: string[];
  },
  never,
  Providers
>;

/**
 * A Managed Kafka schema registry instance.
 *
 * Schema registries have no labels field, so Alchemy stamps ownership on
 * a reserved `alchemy_ownership` subject. Name and location are identity
 * — changing either replaces the registry.
 *
 * ### Creating a Schema Registry
 * **Example:** Generated name
 * ```typescript
 * const registry = yield* GCP.ManagedKafka.SchemaRegistry("Schemas", {});
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const registry = yield* GCP.ManagedKafka.SchemaRegistry("Schemas", {
 *   schemaRegistryId: "app_schemas",
 *   location: "us-central1",
 * });
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const SchemaRegistry = Resource<SchemaRegistry>(
  "GCP.ManagedKafka.SchemaRegistry",
);

export class SchemaRegistryNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.SchemaRegistryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  schemaRegistryId: string,
) =>
  `projects/${project}/locations/${location}/schemaRegistries/${schemaRegistryId}`;

const toAttrs = (registry: kafka.SchemaRegistry, project: string) => {
  const name = registry.name ?? "";
  const parsed = parseName(name, "schemaRegistries");
  return {
    name,
    schemaRegistryId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    contexts: registry.contexts ?? [],
  };
};

export const SchemaRegistryProvider = () =>
  Provider.succeed(SchemaRegistry, {
    stables: ["name", "schemaRegistryId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.schemaRegistryId ?? output?.schemaRegistryId,
        nextId: news.schemaRegistryId
          ? schemaRegistryIdOf(news.schemaRegistryId)
          : (olds?.schemaRegistryId ?? output?.schemaRegistryId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaRegistryId = yield* toSchemaRegistryId(
        id,
        olds?.schemaRegistryId,
        output?.schemaRegistryId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, schemaRegistryId);
      const existing = yield* getSchemaRegistry(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasSchemaRegistryOwnership(id, name))
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
                hasAlchemyLabelMap(labels)
                  ? toAttrs(registry, env.project)
                  : undefined,
              ),
            ),
          { concurrency: 4 },
        );
        return owned.filter(
          (attrs): attrs is NonNullable<typeof attrs> => attrs !== undefined,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaRegistryId = yield* toSchemaRegistryId(
        id,
        news.schemaRegistryId,
        output?.schemaRegistryId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, schemaRegistryId);
      const labels = yield* createInternalLabels(id);

      let current = yield* getSchemaRegistry(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          kafka
            .createProjectsLocationsSchemaRegistries({
              parent: locationParent(env.project, location),
              body: {
                schemaRegistryId,
                schemaRegistry: {},
              },
            })
            .pipe(Effect.catchTag("Conflict", () => getSchemaRegistry(name))),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SchemaRegistryNotResolved({ name });
      }

      yield* stampSchemaRegistryOwnership(current.name ?? name, labels);
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kafka
        .deleteProjectsLocationsSchemaRegistries({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "SchemaRegistryRequiresCluster"],
            () => Effect.void,
          ),
        );
    }),
  });
