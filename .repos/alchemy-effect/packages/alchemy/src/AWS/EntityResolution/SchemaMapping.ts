import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readEntityResolutionTags,
  syncEntityResolutionTags,
} from "./internal.ts";

export interface SchemaMappingProps {
  /**
   * Name of the schema mapping. Must be unique per account/region and match
   * `[a-zA-Z_0-9-]*`. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing the name replaces the schema mapping.
   */
  schemaName?: string;
  /**
   * A description of the schema mapping.
   */
  description?: string;
  /**
   * The columns of the input records table and how Entity Resolution should
   * interpret them: the attribute `type` (e.g. `UNIQUE_ID`, `EMAIL_ADDRESS`,
   * `NAME`, `PHONE_NUMBER`), an optional `matchKey` used by rule-based
   * matching, and optional `groupName`/`subType`/`hashed` metadata.
   *
   * Mutable in place — but a schema mapping becomes immutable while it is
   * referenced by a matching workflow.
   */
  mappedInputFields: entityresolution.SchemaInputAttribute[];
  /**
   * Tags to apply to the schema mapping. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface SchemaMapping extends Resource<
  "AWS.EntityResolution.SchemaMapping",
  SchemaMappingProps,
  {
    /**
     * The name of the schema mapping.
     */
    schemaName: string;
    /**
     * The ARN of the schema mapping.
     */
    schemaArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Entity Resolution schema mapping — the schema of an input customer
 * records table. It tells Entity Resolution the attribute type of each column
 * (name, email, phone, unique id, …) and which columns rule-based matching
 * compares via `matchKey`.
 *
 * @resource
 * @section Creating Schema Mappings
 * @example Customer records schema
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const schema = yield* AWS.EntityResolution.SchemaMapping("Customers", {
 *   mappedInputFields: [
 *     { fieldName: "id", type: "UNIQUE_ID" },
 *     { fieldName: "email", type: "EMAIL_ADDRESS", matchKey: "email" },
 *     { fieldName: "name", type: "NAME", matchKey: "name" },
 *   ],
 * });
 * ```
 *
 * @section Matching Workflows
 * @example Use the schema in a matching workflow input source
 * ```typescript
 * const workflow = yield* AWS.EntityResolution.MatchingWorkflow("Dedupe", {
 *   inputSourceConfig: [
 *     { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
 *   ],
 *   // ...
 * });
 * ```
 */
export const SchemaMapping = Resource<SchemaMapping>(
  "AWS.EntityResolution.SchemaMapping",
);

export const SchemaMappingProvider = () =>
  Provider.effect(
    SchemaMapping,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { schemaName?: string | undefined },
      ) {
        return (
          props.schemaName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Get a schema mapping by name; typed not-found → undefined. */
      const getByName = Effect.fn(function* (schemaName: string) {
        return yield* entityresolution
          .getSchemaMapping({ schemaName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["schemaName", "schemaArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.schemaName ?? (yield* createName(id, olds ?? {}));
          const mapping = yield* getByName(name);
          if (mapping === undefined) return undefined;
          const attrs = {
            schemaName: mapping.schemaName,
            schemaArn: mapping.schemaArn,
          };
          // getSchemaMapping does not return tags — read them via
          // listTagsForResource for the ownership check.
          const tags = yield* readEntityResolutionTags(mapping.schemaArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.schemaName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — names are unique, so the name IS the identity.
          let mapping = yield* getByName(name);

          // 2. Ensure — create when missing; tolerate the concurrent-create
          //    race, then re-observe: the create response is a structural
          //    subset of the Get shape (it omits createdAt/updatedAt/
          //    hasWorkflows).
          if (mapping === undefined) {
            yield* entityresolution
              .createSchemaMapping({
                schemaName: name,
                description: news.description,
                mappedInputFields: news.mappedInputFields,
                tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            mapping = yield* entityresolution.getSchemaMapping({
              schemaName: name,
            });
          }

          // 3. Sync — description and mapped fields update in place (fails
          //    with a typed ConflictException while a workflow references
          //    the schema). Only call the API on an actual delta.
          if (
            !deepEqual(mapping.mappedInputFields, news.mappedInputFields) ||
            (mapping.description || undefined) !==
              (news.description ?? undefined)
          ) {
            // The update response omits createdAt/updatedAt/hasWorkflows;
            // name and ARN are stable, so keep the observed Get shape.
            yield* entityresolution.updateSchemaMapping({
              schemaName: name,
              description: news.description,
              mappedInputFields: news.mappedInputFields,
            });
          }

          // 3b. Sync tags against OBSERVED cloud tags (adoption-safe).
          yield* syncEntityResolutionTags(mapping.schemaArn, desiredTags);

          yield* session.note(mapping.schemaArn);
          return {
            schemaName: mapping.schemaName,
            schemaArn: mapping.schemaArn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteSchemaMapping succeeds even when the mapping is already
          // gone; it conflicts while a matching workflow still references
          // the schema (the engine deletes dependents first — retry the
          // eventual-consistency window).
          yield* entityresolution
            .deleteSchemaMapping({ schemaName: output.schemaName })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),

        list: () =>
          entityresolution.listSchemaMappings.items({}).pipe(
            Stream.map((summary) => ({
              schemaName: summary.schemaName,
              schemaArn: summary.schemaArn,
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
