import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type SchemaType = "AVRO" | "PROTOCOL_BUFFER";

export type SchemaProps = {
  /**
   * Schema id (the `{schema}` segment of `projects/{project}/schemas/{schema}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must start with a letter and be 3-255 characters.
   * Immutable — changing it replaces the schema.
   */
  schemaId?: string;
  /**
   * Schema definition language. Immutable — changing it replaces the schema.
   */
  type: SchemaType;
  /**
   * Schema definition. Must be a valid Avro JSON schema or Protocol Buffer
   * file matching `type`. Updates commit a new revision (Pub/Sub allows
   * up to 20 revisions per schema).
   */
  definition: string;
};

export type Schema = Resource<
  "GCP.PubSub.Schema",
  SchemaProps,
  {
    /** Full resource name `projects/{project}/schemas/{schema}`. */
    name: string;
    /** Schema id (last path segment). */
    schemaId: string;
    /** Project id. */
    project: string;
    /** Schema definition language. */
    type: string | undefined;
    /** Schema definition (latest revision). */
    definition: string | undefined;
    /** Latest revision id. */
    revisionId: string | undefined;
    /** RFC3339 timestamp when the latest revision was created. */
    revisionCreateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Pub/Sub schema used to validate published messages.
 *
 * Pub/Sub schemas have no labels field. Ownership is by resource name;
 * `list` returns every schema in the project so `pnpm nuke:gcp` can
 * clean leaked test schemas.
 *
 * ### Creating a Schema
 * **Example:** Generated name (Avro)
 * ```typescript
 * const schema = yield* GCP.PubSub.Schema("Events", {
 *   type: "AVRO",
 *   definition: JSON.stringify({
 *     type: "record",
 *     name: "Event",
 *     fields: [{ name: "id", type: "string" }],
 *   }),
 * });
 * ```
 *
 * **Example:** Explicit id and Protocol Buffer definition
 * ```typescript
 * const schema = yield* GCP.PubSub.Schema("Events", {
 *   schemaId: "order-events",
 *   type: "PROTOCOL_BUFFER",
 *   definition: 'syntax = "proto3";\nmessage Event { string id = 1; }',
 * });
 * ```
 *
 * ### Updating a Schema
 * Change `definition` on the same logical id; the schema keeps its name and
 * a new revision is committed.
 *
 * **Example:** Commit a compatible Avro revision
 * ```typescript
 * const schema = yield* GCP.PubSub.Schema("Events", {
 *   type: "AVRO",
 *   definition: JSON.stringify({
 *     type: "record",
 *     name: "Event",
 *     fields: [
 *       { name: "id", type: "string" },
 *       { name: "count", type: "int", default: 0 },
 *     ],
 *   }),
 * });
 * ```
 *
 * @resource
 * @category PubSub
 */
export const Schema = Resource<Schema>("GCP.PubSub.Schema");

export class SchemaNotResolved extends Data.TaggedError(
  "GCP.PubSub.SchemaNotResolved",
)<{
  name: string;
}> {}

const canonicalName = (name: string) => name.split("@")[0] ?? name;

const schemaIdOf = (name: string) => {
  const withoutRevision = canonicalName(name);
  return withoutRevision.split("/").pop() ?? withoutRevision;
};

const resourceName = (project: string, schemaId: string) =>
  `projects/${project}/schemas/${schemaId}`;

const toId = (id: string, schemaId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (schemaId !== undefined) return schemaId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 255,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `s${generated}`.slice(0, 255);
  });

const toAttrs = (schema: pubsub.Pubsub_Schema, project: string) => {
  const name = canonicalName(schema.name ?? "");
  return {
    name,
    schemaId: schemaIdOf(name),
    project,
    type: schema.type,
    definition: schema.definition,
    revisionId: schema.revisionId,
    revisionCreateTime: schema.revisionCreateTime,
  };
};

const getByName = (name: string) =>
  pubsub
    .getProjectsSchemas({ name: canonicalName(name), view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const definitionsEqual = (
  left: string | undefined,
  right: string | undefined,
) => {
  const a = (left ?? "").trim();
  const b = (right ?? "").trim();
  if (a === b) return true;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
};

export const SchemaProvider = () =>
  Provider.succeed(Schema, {
    stables: ["name", "schemaId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.schemaId ?? output?.schemaId;
      const nextId = news.schemaId ?? previousId;
      const nameChanged =
        previousId !== undefined &&
        news.schemaId !== undefined &&
        news.schemaId !== previousId;
      const previousType = olds?.type ?? output?.type;
      const typeChanged =
        previousType !== undefined && previousType !== news.type;
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (typeChanged) {
        return {
          action: "replace" as const,
          deleteFirst: nextId !== undefined && nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = yield* toId(id, olds?.schemaId, output?.schemaId);
      const name = canonicalName(
        output?.name ?? resourceName(env.project, schemaId),
      );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* pubsub.listProjectsSchemas
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
            view: "FULL",
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.schemas ?? [])),
            Stream.map((schema) => toAttrs(schema, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = yield* toId(id, news.schemaId, output?.schemaId);
      const name = resourceName(env.project, schemaId);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* pubsub
          .createProjectsSchemas({
            parent: `projects/${env.project}`,
            schemaId,
            body: {
              type: news.type,
              definition: news.definition,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SchemaNotResolved({ name });
      }

      if (!definitionsEqual(current.definition, news.definition)) {
        current = yield* pubsub.commitProjectsSchemas({
          name,
          body: {
            schema: {
              name,
              type: news.type,
              definition: news.definition,
            },
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* pubsub
        .deleteProjectsSchemas({ name: canonicalName(output.name) })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
