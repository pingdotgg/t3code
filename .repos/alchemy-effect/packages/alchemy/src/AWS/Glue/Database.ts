import * as glue from "@distilled.cloud/aws/glue";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  cleanMap,
  databaseArn,
  retryWhileConcurrentModification,
} from "./internal.ts";

export interface DatabaseProps {
  /**
   * Name of the database. Glue lowercases database names, so provide a
   * lowercase name. If omitted, a unique lowercase name is generated.
   * Changing the name replaces the database.
   * @default a generated lowercase physical name
   */
  databaseName?: string;
  /**
   * A description of the database.
   */
  description?: string;
  /**
   * The location of the database (for example, an S3 path) used as the
   * default for tables that do not specify their own location.
   */
  locationUri?: string;
  /**
   * Free-form key/value properties stored on the database. Alchemy adds its
   * own `alchemy::*` ownership markers to this map (Glue databases are not
   * ARN-taggable) — user keys are preserved alongside them.
   */
  parameters?: Record<string, string>;
  /**
   * The AWS account ID of the Data Catalog the database lives in. Changing it
   * replaces the database.
   * @default the caller's account (the default Data Catalog)
   */
  catalogId?: string;
}

export interface Database extends Resource<
  "AWS.Glue.Database",
  DatabaseProps,
  {
    /** The (lowercase) name of the database. */
    databaseName: string;
    /** The ARN of the database. */
    databaseArn: string;
    /** The AWS account ID of the Data Catalog the database lives in. */
    catalogId: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue Data Catalog database — the top-level container for Glue tables
 * that Athena, EMR, Redshift Spectrum, and Glue jobs query. Databases are free
 * and instant to create.
 * @resource
 * @section Creating Databases
 * @example Basic Database
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const database = yield* AWS.Glue.Database("Analytics", {
 *   databaseName: "analytics",
 * });
 * ```
 *
 * @example Database with a Default S3 Location
 * ```typescript
 * const database = yield* AWS.Glue.Database("Analytics", {
 *   databaseName: "analytics",
 *   description: "Curated analytics tables",
 *   locationUri: "s3://my-data-lake/analytics/",
 *   parameters: { classification: "parquet" },
 * });
 * ```
 */
export const Database = Resource<Database>("AWS.Glue.Database");

export const DatabaseProvider = () =>
  Provider.effect(
    Database,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { databaseName?: string | undefined },
      ) {
        return (
          props.databaseName ??
          (yield* createPhysicalName({ id, maxLength: 255, lowercase: true }))
        );
      });

      const observe = Effect.fn(function* (
        name: string,
        catalogId: string | undefined,
      ) {
        return yield* glue
          .getDatabase({ Name: name, CatalogId: catalogId })
          .pipe(
            Effect.map((r) => r.Database),
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Database.Provider.of({
        stables: ["databaseName", "databaseArn", "catalogId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* glue.getDatabases
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.DatabaseList ?? [])
              .map((db) => ({
                databaseName: db.Name,
                databaseArn: databaseArn(
                  region,
                  db.CatalogId ?? accountId,
                  db.Name,
                ),
                catalogId: db.CatalogId ?? accountId,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const catalogId = output?.catalogId ?? olds?.catalogId ?? accountId;
          const name =
            output?.databaseName ?? (yield* createName(id, olds ?? {}));
          const db = yield* observe(name, catalogId);
          if (db === undefined) return undefined;
          const attrs = {
            databaseName: db.Name,
            databaseArn: databaseArn(
              region,
              db.CatalogId ?? catalogId,
              db.Name,
            ),
            catalogId: db.CatalogId ?? catalogId,
          };
          // Glue databases are not ARN-taggable — ownership markers live in
          // the database Parameters map.
          return (yield* hasAlchemyTags(id, cleanMap(db.Parameters)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if ((olds.catalogId ?? undefined) !== (news.catalogId ?? undefined)) {
            return { action: "replace" } as const;
          }
          // description / locationUri / parameters → update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const catalogId = news.catalogId ?? output?.catalogId ?? accountId;
          const name = output?.databaseName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredParameters = { ...news.parameters, ...internalTags };

          const databaseInput = {
            Name: name,
            Description: news.description,
            LocationUri: news.locationUri,
            Parameters: desiredParameters,
          };

          // 1. OBSERVE
          let db = yield* observe(name, catalogId);

          // 2. ENSURE
          if (db === undefined) {
            yield* glue
              .createDatabase({
                CatalogId: catalogId,
                DatabaseInput: databaseInput,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () => Effect.void),
                retryWhileConcurrentModification,
              );
            db = yield* observe(name, catalogId);
          } else {
            // 3. SYNC — UpdateDatabase replaces the full DatabaseInput.
            yield* glue
              .updateDatabase({
                CatalogId: catalogId,
                Name: name,
                DatabaseInput: databaseInput,
              })
              .pipe(retryWhileConcurrentModification);
            db = yield* observe(name, catalogId);
          }

          yield* session.note(name);
          return {
            databaseName: name,
            databaseArn: databaseArn(region, db?.CatalogId ?? catalogId, name),
            catalogId: db?.CatalogId ?? catalogId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* glue
            .deleteDatabase({
              Name: output.databaseName,
              CatalogId: output.catalogId,
            })
            .pipe(
              retryWhileConcurrentModification,
              Effect.catchTag("EntityNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
