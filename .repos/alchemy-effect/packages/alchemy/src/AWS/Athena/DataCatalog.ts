import * as athena from "@distilled.cloud/aws/athena";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type DataCatalogArn =
  `arn:aws:athena:${RegionID}:${AccountID}:datacatalog/${string}`;

export interface DataCatalogProps {
  /**
   * Name of the data catalog. This is the catalog's identity — changing it
   * replaces the resource. Up to 256 characters.
   */
  name: string;
  /**
   * Catalog type. Changing this replaces the resource.
   * - `LAMBDA` — a federated connector backed by a Lambda metadata function.
   * - `GLUE` — an AWS Glue Data Catalog (typically in another account).
   * - `HIVE` — an external Apache Hive metastore via a Lambda function.
   * - `FEDERATED` — a managed federated connector.
   */
  type: "LAMBDA" | "GLUE" | "HIVE" | "FEDERATED";
  /**
   * Optional description.
   */
  description?: string;
  /**
   * Type-specific parameters. For `LAMBDA`/`HIVE` this carries the
   * `metadata-function` / `record-function` (or `function`) ARNs; for `GLUE`
   * the `catalog-id`.
   */
  parameters?: Record<string, string>;
  /**
   * User-defined tags to apply to the data catalog.
   */
  tags?: Record<string, string>;
}

export interface DataCatalog extends Resource<
  "AWS.Athena.DataCatalog",
  DataCatalogProps,
  {
    /**
     * Name of the data catalog.
     */
    name: string;
    /**
     * ARN of the data catalog.
     */
    dataCatalogArn: DataCatalogArn;
    /**
     * Catalog type (`LAMBDA`, `GLUE`, or `HIVE`).
     */
    type: string;
    /**
     * Type-specific connection parameters.
     */
    parameters: Record<string, string>;
    /**
     * Description of the data catalog.
     */
    description: string | undefined;
    /**
     * Tags on the data catalog.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Athena data catalog — registers an external metadata source (a
 * federated Lambda connector, an external Hive metastore, or a cross-account
 * Glue Data Catalog) that Athena queries can reference as a `catalog`.
 *
 * @resource
 * @section Registering Catalogs
 * @example A federated Lambda-backed catalog
 * ```typescript
 * const catalog = yield* AWS.Athena.DataCatalog("Cmdb", {
 *   name: "cmdb_connector",
 *   type: "LAMBDA",
 *   parameters: {
 *     "metadata-function": connector.functionArn,
 *     "record-function": connector.functionArn,
 *   },
 * });
 * ```
 */
export const DataCatalog = Resource<DataCatalog>("AWS.Athena.DataCatalog");

const observedTagsOf = (tags: readonly athena.Tag[] | undefined) =>
  Object.fromEntries(
    (tags ?? []).flatMap((t) =>
      t.Key !== undefined && t.Value !== undefined ? [[t.Key, t.Value]] : [],
    ),
  );

const paramsOf = (params: { [key: string]: string | undefined } | undefined) =>
  Object.fromEntries(
    Object.entries(params ?? {}).flatMap((e) =>
      typeof e[1] === "string" ? [[e[0], e[1]]] : [],
    ),
  ) as Record<string, string>;

export const DataCatalogProvider = () =>
  Provider.effect(
    DataCatalog,
    Effect.gen(function* () {
      const getOne = (name: string) =>
        // GetDataCatalog resolves catalogs through a workgroup — without one it
        // reports even existing catalogs as not-found, so scope to `primary`.
        athena.getDataCatalog({ Name: name, WorkGroup: "primary" }).pipe(
          Effect.map((res) => res.DataCatalog),
          Effect.catchTag("DataCatalogNotFound", () =>
            Effect.succeed(undefined),
          ),
        );

      const fetchTags = (arn: string) =>
        athena.listTagsForResource.items({ ResourceARN: arn }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => observedTagsOf(Array.from(chunk))),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      return {
        stables: ["name", "dataCatalogArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if ((olds?.name ?? undefined) !== news.name) {
            return { action: "replace" } as const;
          }
          if ((olds?.type ?? undefined) !== news.type) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.name ?? olds?.name;
          if (!name) return undefined;
          const dc = yield* getOne(name);
          if (!dc) return undefined;
          const arn =
            `arn:aws:athena:${region}:${accountId}:datacatalog/${name}` as DataCatalogArn;
          return {
            name,
            dataCatalogArn: arn,
            type: dc.Type,
            parameters: paramsOf(dc.Parameters),
            description: dc.Description,
            tags: yield* fetchTags(arn),
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* athena.listDataCatalogs
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.DataCatalogsSummary ?? [])
              .flatMap((dc) =>
                dc.CatalogName
                  ? [
                      {
                        name: dc.CatalogName,
                        dataCatalogArn:
                          `arn:aws:athena:${region}:${accountId}:datacatalog/${dc.CatalogName}` as DataCatalogArn,
                        type: dc.Type ?? "LAMBDA",
                        parameters: {} as Record<string, string>,
                        description: undefined,
                        tags: {} as Record<string, string>,
                      },
                    ]
                  : [],
              );
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = news.name ?? output?.name!;
          const arn =
            `arn:aws:athena:${region}:${accountId}:datacatalog/${name}` as DataCatalogArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredParams = news.parameters ?? {};

          // Observe — cloud state is authoritative.
          let dc = yield* getOne(name);

          // Ensure — create if missing.
          if (!dc) {
            yield* athena.createDataCatalog({
              Name: name,
              Type: news.type,
              Description: news.description,
              Parameters: desiredParams,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            dc = yield* getOne(name);
          } else {
            // Sync — AWS derives extra parameter keys (e.g. `catalog`) beyond
            // what we sent, so only update when a DESIRED key is missing or
            // differs from the observed value (ignore AWS-added keys).
            const observedParams = paramsOf(dc.Parameters);
            const paramsDrift = Object.entries(desiredParams).some(
              ([k, v]) => observedParams[k] !== v,
            );
            const descDrift =
              news.description !== undefined &&
              dc.Description !== news.description;
            if (paramsDrift || descDrift) {
              yield* athena.updateDataCatalog({
                Name: name,
                Type: news.type,
                Description: news.description,
                Parameters: desiredParams,
              });
            }
          }

          // Sync tags — diff against OBSERVED cloud tags.
          const observed = yield* fetchTags(arn);
          const { upsert, removed } = diffTags(observed, desiredTags);
          if (upsert.length > 0) {
            yield* athena.tagResource({
              ResourceARN: arn,
              Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* athena.untagResource({ ResourceARN: arn, TagKeys: removed });
          }

          const final = (yield* getOne(name)) ?? dc;
          yield* session.note(arn);
          return {
            name,
            dataCatalogArn: arn,
            type: final?.Type ?? news.type,
            parameters: paramsOf(final?.Parameters),
            description: final?.Description ?? news.description,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* athena
            .deleteDataCatalog({ Name: output.name })
            .pipe(Effect.catchTag("DataCatalogNotFound", () => Effect.void));
        }),
      };
    }),
  );
