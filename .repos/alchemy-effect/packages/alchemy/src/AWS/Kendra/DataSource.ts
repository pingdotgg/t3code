import * as kendra from "@distilled.cloud/aws/kendra";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type DataSourceStatus = kendra.DataSourceStatus;
export type DataSourceType = kendra.DataSourceType;

export interface DataSourceProps {
  /**
   * The identifier of the Kendra index the data source connects to.
   * Changing it replaces the data source.
   */
  indexId: string;
  /**
   * Name of the data source.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The connector type (e.g. `S3`, `TEMPLATE`, `WEBCRAWLER`, `CUSTOM`).
   * Changing it replaces the data source.
   */
  type: DataSourceType;
  /**
   * Connector-specific configuration (e.g. `S3Configuration` or
   * `TemplateConfiguration`). Required for all types except `CUSTOM`.
   */
  configuration?: kendra.DataSourceConfiguration;
  /**
   * VPC configuration for connectors that reach into a VPC.
   */
  vpcConfiguration?: kendra.DataSourceVpcConfiguration;
  /**
   * A description of the data source.
   */
  description?: string;
  /**
   * Sync schedule as a cron expression (e.g. `cron(0 12 * * ? *)`). When
   * omitted, syncs run only on demand.
   */
  schedule?: string;
  /**
   * ARN of the IAM role Kendra assumes to access the source content.
   * Required for all types except `CUSTOM`.
   */
  roleArn?: string;
  /**
   * The code for a language the source documents are in.
   * @default "en"
   */
  languageCode?: string;
  /**
   * Alter document metadata/content during ingestion.
   */
  customDocumentEnrichmentConfiguration?: kendra.CustomDocumentEnrichmentConfiguration;
  /**
   * Tags to associate with the data source.
   */
  tags?: Record<string, string>;
}

export interface DataSource extends Resource<
  "AWS.Kendra.DataSource",
  DataSourceProps,
  {
    /**
     * Service-assigned unique identifier of the data source (unique within
     * its index).
     */
    id: string;
    /**
     * The identifier of the index the data source belongs to.
     */
    indexId: string;
    /**
     * ARN of the data source.
     */
    arn: string;
    /**
     * The data source's name.
     */
    name: string;
    /**
     * The connector type.
     */
    type: DataSourceType | undefined;
    /**
     * Current lifecycle status of the data source.
     */
    status: DataSourceStatus | undefined;
    /**
     * Current tags reported for the data source.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Kendra data source — a connector that syncs documents from a
 * repository (S3 bucket, SharePoint, website, ...) into a Kendra index.
 *
 * @resource
 * @section Creating Data Sources
 * @example S3 Data Source
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const source = yield* AWS.Kendra.DataSource("Docs", {
 *   indexId: index.id,
 *   type: "S3",
 *   roleArn: dataSourceRole.roleArn,
 *   configuration: {
 *     S3Configuration: {
 *       BucketName: bucket.bucketName,
 *     },
 *   },
 * });
 * ```
 *
 * @example Scheduled Sync
 * ```typescript
 * const source = yield* AWS.Kendra.DataSource("Docs", {
 *   indexId: index.id,
 *   type: "S3",
 *   roleArn: dataSourceRole.roleArn,
 *   schedule: "cron(0 12 * * ? *)",
 *   configuration: {
 *     S3Configuration: { BucketName: bucket.bucketName },
 *   },
 * });
 * ```
 */
export const DataSource = Resource<DataSource>("AWS.Kendra.DataSource");

const createDataSourceName = (
  id: string,
  props: { name?: string | undefined },
) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 100 });

const fetchTags = Effect.fn(function* (arn: string) {
  const response = yield* kendra
    .listTagsForResource({ ResourceARN: arn })
    .pipe(
      Effect.catchTag(
        ["ResourceNotFoundException", "ResourceUnavailableException"],
        () => Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    (response?.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
  );
});

const currentArnOf = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return (indexId: string, dataSourceId: string) =>
    `arn:aws:kendra:${region}:${accountId}:index/${indexId}/data-source/${dataSourceId}`;
});

interface DataSourceState {
  attrs: DataSource["Attributes"];
  described: kendra.DescribeDataSourceResponse;
}

const readDataSourceById = Effect.fn(function* (
  indexId: string,
  dataSourceId: string,
  arnOf: (indexId: string, dataSourceId: string) => string,
) {
  const described = yield* kendra
    .describeDataSource({ IndexId: indexId, Id: dataSourceId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described || described.Status === "DELETING") return undefined;
  const arn = arnOf(described.IndexId ?? indexId, described.Id ?? dataSourceId);
  const state: DataSourceState = {
    described,
    attrs: {
      id: described.Id ?? dataSourceId,
      indexId: described.IndexId ?? indexId,
      arn,
      name: described.Name ?? "",
      type: described.Type,
      status: described.Status,
      tags: yield* fetchTags(arn),
    },
  };
  return state;
});

const findDataSourceByName = Effect.fn(function* (
  indexId: string,
  name: string,
  arnOf: (indexId: string, dataSourceId: string) => string,
) {
  const summaries = yield* kendra.listDataSources
    .pages({ IndexId: indexId })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.SummaryItems ?? []),
      ),
      // The parent index may itself be gone.
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as kendra.DataSourceSummary[]),
      ),
    );
  const match = summaries.find(
    (summary) => summary.Name === name && summary.Status !== "DELETING",
  );
  if (!match?.Id) return undefined;
  return yield* readDataSourceById(indexId, match.Id, arnOf);
});

/**
 * A data source still transitioning toward the awaited status — retried by
 * {@link waitForDataSourceStatus}'s bounded schedule.
 */
class DataSourceNotReady extends Data.TaggedError("DataSourceNotReady")<{
  readonly id: string;
  readonly status: string | undefined;
}> {}

/**
 * A data source whose asynchronous provisioning converged to the terminal
 * `FAILED` status.
 */
export class DataSourceProvisioningFailed extends Data.TaggedError(
  "DataSourceProvisioningFailed",
)<{
  readonly id: string;
  readonly message: string | undefined;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "DataSourceNotReady",
    // Data source provisioning is usually well under a minute; budget ~5 min.
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

// CreateDataSource validates the IAM role up front; a freshly-created role
// may not have propagated yet and surfaces as ValidationException. Bounded
// retry through the propagation window (~60s). Explicitly typed for the same
// declaration-emit reason as retryWhileNotReady.
const retryThroughIamPropagation = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ValidationException",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(12)]),
  });

const waitForDataSourceStatus = (
  indexId: string,
  id: string,
  target: "ACTIVE" | "DELETED",
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* kendra
        .describeDataSource({ IndexId: indexId, Id: id })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (target === "DELETED") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new DataSourceNotReady({ id, status: described.Status }),
        );
      }
      if (described?.Status === "ACTIVE") return;
      if (described?.Status === "FAILED") {
        return yield* Effect.fail(
          new DataSourceProvisioningFailed({
            id,
            message: described.ErrorMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new DataSourceNotReady({ id, status: described?.Status }),
      );
    }),
  );

export const DataSourceProvider = () =>
  Provider.effect(
    DataSource,
    Effect.gen(function* () {
      return {
        stables: ["id", "indexId", "arn"],
        // Keyed by a parent index; cannot be enumerated account-wide without
        // iterating every index — treated as a sub-resource per the factory
        // list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arnOf = yield* currentArnOf;
          const indexId = output?.indexId ?? olds?.indexId;
          if (indexId === undefined) return undefined;
          const state = output?.id
            ? yield* readDataSourceById(indexId, output.id, arnOf)
            : yield* findDataSourceByName(
                indexId,
                yield* createDataSourceName(id, olds ?? {}),
                arnOf,
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent index and connector type are fixed at creation.
          if (olds.indexId !== news.indexId || olds.type !== news.type) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("Kendra DataSource requires props"),
            );
          }
          const arnOf = yield* currentArnOf;
          const indexId = news.indexId;
          const name = yield* createDataSourceName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let state = output?.id
            ? yield* readDataSourceById(indexId, output.id, arnOf)
            : yield* findDataSourceByName(indexId, name, arnOf);

          // Ensure — create if missing, then wait for ACTIVE.
          if (state === undefined) {
            const created = yield* retryThroughIamPropagation(
              kendra.createDataSource({
                IndexId: indexId,
                Name: name,
                Type: news.type,
                Configuration: news.configuration,
                VpcConfiguration: news.vpcConfiguration,
                Description: news.description,
                Schedule: news.schedule,
                RoleArn: news.roleArn,
                LanguageCode: news.languageCode,
                CustomDocumentEnrichmentConfiguration:
                  news.customDocumentEnrichmentConfiguration,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            );
            yield* session.note(
              `Creating data source ${name} (${created.Id})...`,
            );
            yield* waitForDataSourceStatus(indexId, created.Id, "ACTIVE");
            state = yield* readDataSourceById(indexId, created.Id, arnOf);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created data source ${name}`),
              );
            }
          }

          // Sync mutable settings via UpdateDataSource — only when drifted.
          const described = state.described;
          const needsUpdate =
            name !== described.Name ||
            (news.description ?? "") !== (described.Description ?? "") ||
            (news.schedule ?? "") !== (described.Schedule ?? "") ||
            (news.roleArn !== undefined &&
              news.roleArn !== described.RoleArn) ||
            (news.languageCode !== undefined &&
              news.languageCode !== described.LanguageCode) ||
            news.configuration !== undefined ||
            news.vpcConfiguration !== undefined ||
            news.customDocumentEnrichmentConfiguration !== undefined;
          if (needsUpdate) {
            yield* kendra.updateDataSource({
              Id: state.attrs.id,
              IndexId: indexId,
              Name: name,
              Configuration: news.configuration,
              VpcConfiguration: news.vpcConfiguration,
              Description: news.description,
              Schedule: news.schedule,
              RoleArn: news.roleArn,
              LanguageCode: news.languageCode,
              CustomDocumentEnrichmentConfiguration:
                news.customDocumentEnrichmentConfiguration,
            });
            yield* waitForDataSourceStatus(indexId, state.attrs.id, "ACTIVE");
            yield* session.note(`Updated data source ${name}`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* kendra.untagResource({
              ResourceARN: state.attrs.arn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* kendra.tagResource({
              ResourceARN: state.attrs.arn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(state.attrs.arn);

          const final = yield* readDataSourceById(
            indexId,
            state.attrs.id,
            arnOf,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled data source ${name}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* kendra
            .deleteDataSource({ IndexId: output.indexId, Id: output.id })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          yield* waitForDataSourceStatus(output.indexId, output.id, "DELETED");
        }),
      };
    }),
  );
