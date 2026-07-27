import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { definedTags } from "./internal.ts";

export interface DataIntegrationScheduleConfig {
  /**
   * The start date for objects to import, in ISO 8601 format,
   * e.g. `2024-01-01T00:00:00Z`.
   */
  firstExecutionFrom?: string;
  /**
   * The name of the object to pull from the data source.
   */
  object?: string;
  /**
   * How often the data should be pulled from the data source, e.g.
   * `rate(1 hours)`.
   */
  scheduleExpression: string;
}

export interface DataIntegrationProps {
  /**
   * Name of the data integration. If omitted, a unique name is generated
   * from the app, stage, and logical ID. The name can be updated in place.
   */
  name?: string;
  /**
   * Description of the data integration (1-1000 characters).
   */
  description?: string;
  /**
   * The ARN of the KMS key used to encrypt the data integration. Changing
   * the key replaces the data integration.
   */
  kmsKey: string;
  /**
   * The URI of the data source, e.g. `s3://my-bucket` or
   * `Salesforce://AppFlow/my-connector-profile`. Changing the source URI
   * replaces the data integration.
   */
  sourceURI: string;
  /**
   * The scheduling configuration for pulling data from the source. Required
   * for SaaS (AppFlow) sources; must be omitted for S3 sources. Changing it
   * replaces the data integration.
   */
  scheduleConfig?: DataIntegrationScheduleConfig;
  /**
   * The configuration for which files to pull from the source (folders and
   * filters). Changing it replaces the data integration.
   */
  fileConfiguration?: {
    /**
     * Identifiers for the source folders to pull all files from recursively.
     */
    folders: string[];
    /**
     * Restrictions for what files should be pulled from the source.
     */
    filters?: Record<string, string[]>;
  };
  /**
   * The configuration for which objects and fields to pull from the source.
   * Changing it replaces the data integration.
   */
  objectConfiguration?: Record<string, Record<string, string[]>>;
  /**
   * Tags to apply to the data integration. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface DataIntegration extends Resource<
  "AWS.AppIntegrations.DataIntegration",
  DataIntegrationProps,
  {
    dataIntegrationId: string;
    dataIntegrationArn: string;
    dataIntegrationName: string;
    kmsKey: string;
    sourceURI: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon AppIntegrations data integration. Data integrations reference an
 * external data source (an S3 bucket, or a SaaS application through Amazon
 * AppFlow) so services like Amazon Q in Connect can ingest its content.
 *
 * The KMS key, source URI, schedule, file configuration, and object
 * configuration are immutable; changing any of them replaces the data
 * integration. Only the name and description can be updated in place.
 * @resource
 * @section Creating a Data Integration
 * @example S3 Data Integration
 * ```typescript
 * import * as AppIntegrations from "alchemy/AWS/AppIntegrations";
 * import * as KMS from "alchemy/AWS/KMS";
 * import * as S3 from "alchemy/AWS/S3";
 *
 * const bucket = yield* S3.Bucket("Content");
 * const key = yield* KMS.Key("ContentKey");
 *
 * const integration = yield* AppIntegrations.DataIntegration("Content", {
 *   kmsKey: key.keyArn,
 *   sourceURI: Output.interpolate`s3://${bucket.bucketName}`,
 * });
 * ```
 *
 * @example Scheduled SaaS Data Integration
 * ```typescript
 * const integration = yield* AppIntegrations.DataIntegration("Salesforce", {
 *   kmsKey: key.keyArn,
 *   sourceURI: "Salesforce://AppFlow/my-connector-profile",
 *   scheduleConfig: {
 *     firstExecutionFrom: "2024-01-01T00:00:00Z",
 *     object: "Account",
 *     scheduleExpression: "rate(1 hours)",
 *   },
 * });
 * ```
 */
export const DataIntegration = Resource<DataIntegration>(
  "AWS.AppIntegrations.DataIntegration",
);

/**
 * Raised when the AppIntegrations API returns a data integration without
 * the fields required to build the resource attributes.
 */
export class DataIntegrationIncomplete extends Data.TaggedError(
  "DataIntegrationIncomplete",
)<{ message: string }> {}

export const DataIntegrationProvider = () =>
  Provider.effect(
    DataIntegration,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Get a single data integration by ARN or ID; undefined if absent. */
      const observe = (arnOrId: string) =>
        appintegrations
          .getDataIntegration({ Identifier: arnOrId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      /** Find a data integration ARN by name via list enumeration. */
      const findByName = (name: string) =>
        appintegrations.listDataIntegrations.items({}).pipe(
          Stream.filter((item) => item.Name === name),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]?.Arn),
        );

      const toAttrs = Effect.fn(function* (
        live: appintegrations.GetDataIntegrationResponse,
      ) {
        if (
          live.Arn === undefined ||
          live.Id === undefined ||
          live.Name === undefined ||
          live.KmsKey === undefined ||
          live.SourceURI === undefined
        ) {
          return yield* new DataIntegrationIncomplete({
            message: `data integration '${live.Name}' is missing Arn, Id, Name, KmsKey, or SourceURI`,
          });
        }
        return {
          dataIntegrationId: live.Id,
          dataIntegrationArn: live.Arn,
          dataIntegrationName: live.Name,
          kmsKey: live.KmsKey,
          sourceURI: live.SourceURI,
        };
      });

      const toScheduleConfiguration = (
        config: DataIntegrationScheduleConfig,
      ): appintegrations.ScheduleConfiguration => ({
        ScheduleExpression: config.scheduleExpression,
        ...(config.firstExecutionFrom !== undefined
          ? { FirstExecutionFrom: config.firstExecutionFrom }
          : {}),
        ...(config.object !== undefined ? { Object: config.object } : {}),
      });

      return DataIntegration.Provider.of({
        stables: [
          "dataIntegrationId",
          "dataIntegrationArn",
          "kmsKey",
          "sourceURI",
        ],

        // The list API only returns Arn/Name/SourceURI summaries — hydrate
        // each into the full attributes shape, tolerating per-item NotFound
        // races.
        list: () =>
          Effect.gen(function* () {
            const arns = yield* appintegrations.listDataIntegrations
              .items({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((item) =>
                    item.Arn !== undefined ? [item.Arn] : [],
                  ),
                ),
              );
            const items = yield* Effect.forEach(
              arns,
              (arn) =>
                observe(arn).pipe(
                  Effect.flatMap((live) =>
                    live === undefined
                      ? Effect.succeed(undefined)
                      : toAttrs(live),
                  ),
                ),
              { concurrency: 10 },
            );
            return items.filter(
              (item): item is DataIntegration["Attributes"] =>
                item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          let identifier: string | undefined = output?.dataIntegrationId;
          if (identifier === undefined) {
            const name = yield* createName(id, olds ?? {});
            identifier = yield* findByName(name);
          }
          if (identifier === undefined) return undefined;
          const live = yield* observe(identifier);
          if (live === undefined) return undefined;
          const attrs = yield* toAttrs(live);
          const tags = definedTags(live.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          if (
            olds.kmsKey !== news.kmsKey ||
            olds.sourceURI !== news.sourceURI ||
            JSON.stringify(olds.scheduleConfig) !==
              JSON.stringify(news.scheduleConfig) ||
            JSON.stringify(olds.fileConfiguration) !==
              JSON.stringify(news.fileConfiguration) ||
            JSON.stringify(olds.objectConfiguration) !==
              JSON.stringify(news.objectConfiguration)
          ) {
            return { action: "replace" } as const;
          }
          // fall through: default update path (name, description, tags)
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — prefer the cached ID; fall back to enumerating by
          //    name so a lost-state re-run converges.
          let identifier: string | undefined = output?.dataIntegrationId;
          let live =
            identifier === undefined ? undefined : yield* observe(identifier);
          if (live === undefined) {
            identifier = yield* findByName(name);
            live =
              identifier === undefined ? undefined : yield* observe(identifier);
          }

          // 2. Ensure — create if missing.
          if (live === undefined) {
            const created = yield* appintegrations.createDataIntegration({
              Name: name,
              Description: news.description,
              KmsKey: news.kmsKey,
              SourceURI: news.sourceURI,
              ScheduleConfig: news.scheduleConfig
                ? toScheduleConfiguration(news.scheduleConfig)
                : undefined,
              FileConfiguration: news.fileConfiguration
                ? {
                    Folders: news.fileConfiguration.folders,
                    ...(news.fileConfiguration.filters
                      ? { Filters: news.fileConfiguration.filters }
                      : {}),
                  }
                : undefined,
              ObjectConfiguration: news.objectConfiguration,
              Tags: desiredTags,
            });
            if (created.Arn === undefined) {
              return yield* new DataIntegrationIncomplete({
                message: `createDataIntegration for '${name}' returned no Arn`,
              });
            }
            live = yield* appintegrations.getDataIntegration({
              Identifier: created.Arn,
            });
          }
          const attrs = yield* toAttrs(live);

          // 3. Sync mutable aspects — only the name and description can be
          //    updated in place. The API cannot clear a description (min
          //    length 1), so only push a defined value that differs.
          const update: Omit<
            appintegrations.UpdateDataIntegrationRequest,
            "Identifier"
          > = {};
          if (live.Name !== name) {
            update.Name = name;
          }
          if (
            news.description !== undefined &&
            news.description !== live.Description
          ) {
            update.Description = news.description;
          }
          if (Object.keys(update).length > 0) {
            yield* appintegrations.updateDataIntegration({
              Identifier: attrs.dataIntegrationId,
              ...update,
            });
          }

          // 4. Sync tags — diff against OBSERVED cloud tags so adoption
          //    converges.
          const observedTags = definedTags(live.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* appintegrations.tagResource({
              resourceArn: attrs.dataIntegrationArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* appintegrations.untagResource({
              resourceArn: attrs.dataIntegrationArn,
              tagKeys: removed,
            });
          }

          yield* session.note(name);
          return { ...attrs, dataIntegrationName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appintegrations
            .deleteDataIntegration({
              DataIntegrationIdentifier: output.dataIntegrationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
