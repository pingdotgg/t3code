import * as personalize from "@distilled.cloud/aws/personalize";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface SchemaProps {
  /**
   * Name of the schema. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing the name replaces the schema.
   */
  name?: string;
  /**
   * The Avro schema definition, as a JSON string, describing the fields of the
   * dataset this schema applies to. Immutable — changing it replaces the
   * schema.
   *
   * @example
   * ```json
   * {
   *   "type": "record",
   *   "name": "Interactions",
   *   "namespace": "com.amazonaws.personalize.schema",
   *   "fields": [
   *     { "name": "USER_ID", "type": "string" },
   *     { "name": "ITEM_ID", "type": "string" },
   *     { "name": "TIMESTAMP", "type": "long" }
   *   ],
   *   "version": "1.0"
   * }
   * ```
   */
  schema: string;
  /**
   * The domain of a domain-specific dataset group this schema belongs to
   * (`ECOMMERCE` or `VIDEO_ON_DEMAND`). Omit for a custom (non-domain) schema.
   * Immutable — changing it replaces the schema.
   */
  domain?: string;
}

export interface Schema extends Resource<
  "AWS.Personalize.Schema",
  SchemaProps,
  {
    /**
     * ARN of the schema.
     */
    schemaArn: string;
    /**
     * Name of the schema.
     */
    name: string;
    /**
     * Avro schema definition as a JSON string.
     */
    schema: string;
    /**
     * Domain of the schema (`ECOMMERCE` or `VIDEO_ON_DEMAND`) when it is a
     * domain schema.
     */
    domain: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Personalize schema — an Avro definition that describes the fields
 * of a dataset (Interactions, Items, Users, …). Schemas are immutable once
 * created; changing any property replaces the schema.
 *
 * @resource
 * @section Creating a Schema
 * @example Interactions Schema
 * ```typescript
 * const schema = yield* Personalize.Schema("Interactions", {
 *   schema: JSON.stringify({
 *     type: "record",
 *     name: "Interactions",
 *     namespace: "com.amazonaws.personalize.schema",
 *     fields: [
 *       { name: "USER_ID", type: "string" },
 *       { name: "ITEM_ID", type: "string" },
 *       { name: "TIMESTAMP", type: "long" },
 *     ],
 *     version: "1.0",
 *   }),
 * });
 * ```
 */
export const Schema = Resource<Schema>("AWS.Personalize.Schema");

export const SchemaProvider = () =>
  Provider.effect(
    Schema,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: SchemaProps) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 63 }));
      });

      /** Describe a schema by ARN; typed not-found → undefined. */
      const describe = Effect.fn(function* (schemaArn: string) {
        const response = yield* personalize
          .describeSchema({ schemaArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.schema;
      });

      /** Find an existing schema's ARN by its (deterministic) name. */
      const findArnByName = Effect.fn(function* (name: string) {
        const pages = yield* personalize.listSchemas
          .pages({})
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.schemas ?? [])
          .find((summary) => summary.name === name)?.schemaArn;
      });

      return {
        stables: ["schemaArn", "name"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // Schemas are entirely immutable — any change replaces.
          if (
            oldName !== newName ||
            (olds.schema ?? undefined) !== (news.schema ?? undefined) ||
            (olds.domain ?? undefined) !== (news.domain ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.schemaArn) return undefined;
          const schema = yield* describe(output.schemaArn);
          if (schema === undefined) return undefined;
          return {
            schemaArn: schema.schemaArn!,
            name: schema.name!,
            schema: schema.schema!,
            domain: schema.domain,
          };
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);

          // 1. Observe — cloud state is authoritative; output is an ARN cache.
          let schema =
            output?.schemaArn !== undefined
              ? yield* describe(output.schemaArn)
              : undefined;

          // 2. Ensure — schemas are immutable, so only create when missing.
          //    A crashed prior run may have left a same-named schema behind
          //    with no persisted state — adopt it by name.
          if (schema === undefined) {
            const arn = yield* personalize
              .createSchema({
                name,
                schema: news.schema,
                domain: news.domain,
              })
              .pipe(
                Effect.map((created) => created.schemaArn!),
                Effect.catchTag("ResourceAlreadyExistsException", (error) =>
                  findArnByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.fail(error)
                        : Effect.succeed(existing),
                    ),
                  ),
                ),
              );
            schema = yield* describe(arn);
          }

          yield* session.note(schema!.schemaArn!);
          return {
            schemaArn: schema!.schemaArn!,
            name: schema!.name!,
            schema: schema!.schema!,
            domain: schema!.domain,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* personalize.deleteSchema({ schemaArn: output.schemaArn }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A schema still referenced by a dataset rejects deletion. The
            // engine deletes dependent datasets first, but dataset deletion is
            // asynchronous (DELETE PENDING) and may be draining concurrently
            // (e.g. via a dataset group's child cascade) — retry bounded while
            // the referencing datasets finish deleting.
            Effect.retry({
              while: (e) => e._tag === "ResourceInUseException",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(40),
              ]),
            }),
          );
        }),

        list: () =>
          personalize.listSchemas.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.schemas ?? []),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.schemaArn!).pipe(
                    Effect.map((s) =>
                      s
                        ? {
                            schemaArn: s.schemaArn!,
                            name: s.name!,
                            schema: s.schema!,
                            domain: s.domain,
                          }
                        : undefined,
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
