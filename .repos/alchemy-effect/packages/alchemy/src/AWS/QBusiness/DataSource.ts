import * as qbusiness from "@distilled.cloud/aws/qbusiness";
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
import type { Providers } from "../Providers.ts";

export type DataSourceStatus = qbusiness.DataSourceStatus;

export interface DataSourceProps {
  /**
   * The identifier of the Amazon Q Business application the data source
   * attaches to. Changing it replaces the data source.
   */
  applicationId: string;
  /**
   * The identifier of the index the data source syncs documents into.
   * Changing it replaces the data source.
   */
  indexId: string;
  /**
   * Display name of the data source.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * Connector-specific configuration (e.g. the S3 or Web Crawler connector
   * template). See the Amazon Q Business connector documentation for each
   * connector's schema.
   */
  configuration: unknown;
  /**
   * VPC configuration for connectors that reach into a VPC.
   */
  vpcConfiguration?: qbusiness.DataSourceVpcConfiguration;
  /**
   * A description of the data source.
   */
  description?: string;
  /**
   * Sync schedule as a cron expression (e.g. `cron(0 12 * * ? *)`). When
   * omitted, syncs run only on demand.
   */
  syncSchedule?: string;
  /**
   * ARN of the IAM role the connector assumes to access the source
   * content.
   */
  roleArn?: string;
  /**
   * Alter document metadata/content during ingestion.
   */
  documentEnrichmentConfiguration?: qbusiness.DocumentEnrichmentConfiguration;
  /**
   * Image/audio/video extraction settings for ingested media.
   */
  mediaExtractionConfiguration?: qbusiness.MediaExtractionConfiguration;
  /**
   * Tags to associate with the data source.
   */
  tags?: Record<string, string>;
}

export interface DataSource extends Resource<
  "AWS.QBusiness.DataSource",
  DataSourceProps,
  {
    /**
     * Service-assigned unique identifier of the data source (unique within
     * its index).
     */
    dataSourceId: string;
    /**
     * The identifier of the application the data source belongs to.
     */
    applicationId: string;
    /**
     * The identifier of the index the data source syncs into.
     */
    indexId: string;
    /**
     * ARN of the data source.
     */
    dataSourceArn: string;
    /**
     * The data source's display name.
     */
    displayName: string;
    /**
     * The connector type (e.g. `S3`, `WEBCRAWLERV2`, `CUSTOM`).
     */
    type: string | undefined;
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
 * An Amazon Q Business data source — a connector that syncs documents from
 * a repository (S3 bucket, website, SharePoint, ...) into an index.
 *
 * @resource
 * @section Creating Data Sources
 * @example S3 Data Source
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const source = yield* AWS.QBusiness.DataSource("Docs", {
 *   applicationId: app.applicationId,
 *   indexId: index.indexId,
 *   roleArn: dataSourceRole.roleArn,
 *   configuration: {
 *     type: "S3",
 *     syncMode: "FORCED_FULL_CRAWL",
 *     connectionConfiguration: {
 *       repositoryEndpointMetadata: { BucketName: bucket.bucketName },
 *     },
 *     repositoryConfigurations: {
 *       document: {
 *         fieldMappings: [{
 *           indexFieldName: "s3_document_id",
 *           indexFieldType: "STRING",
 *           dataSourceFieldName: "s3_document_id",
 *         }],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @example Scheduled Sync
 * ```typescript
 * const source = yield* AWS.QBusiness.DataSource("Docs", {
 *   applicationId: app.applicationId,
 *   indexId: index.indexId,
 *   roleArn: dataSourceRole.roleArn,
 *   syncSchedule: "cron(0 12 * * ? *)",
 *   configuration: { ... },
 * });
 * ```
 */
export const DataSource = Resource<DataSource>("AWS.QBusiness.DataSource");

const createDisplayName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

const fetchTags = Effect.fn(function* (arn: string) {
  const response = yield* qbusiness
    .listTagsForResource({ resourceARN: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    (response?.tags ?? []).map((tag) => [tag.key, tag.value]),
  );
});

interface DataSourceState {
  attrs: DataSource["Attributes"];
  described: qbusiness.GetDataSourceResponse;
}

const readDataSourceById = Effect.fn(function* (
  applicationId: string,
  indexId: string,
  dataSourceId: string,
) {
  const described = yield* qbusiness
    .getDataSource({ applicationId, indexId, dataSourceId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described || described.status === "DELETING") return undefined;
  const arn = described.dataSourceArn;
  if (arn === undefined) return undefined;
  const state: DataSourceState = {
    described,
    attrs: {
      dataSourceId: described.dataSourceId ?? dataSourceId,
      applicationId: described.applicationId ?? applicationId,
      indexId: described.indexId ?? indexId,
      dataSourceArn: arn,
      displayName: described.displayName ?? "",
      type: described.type,
      status: described.status,
      tags: yield* fetchTags(arn),
    },
  };
  return state;
});

const findDataSourceByName = Effect.fn(function* (
  applicationId: string,
  indexId: string,
  displayName: string,
) {
  const summaries = yield* qbusiness.listDataSources
    .pages({ applicationId, indexId })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.dataSources ?? []),
      ),
      // The parent application/index may itself be gone.
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as qbusiness.DataSource[]),
      ),
    );
  const match = summaries.find(
    (summary) =>
      summary.displayName === displayName && summary.status !== "DELETING",
  );
  if (!match?.dataSourceId) return undefined;
  return yield* readDataSourceById(applicationId, indexId, match.dataSourceId);
});

/**
 * A data source still transitioning toward the awaited status — retried by
 * {@link waitForDataSourceStatus}'s bounded schedule.
 */
class DataSourceNotReady extends Data.TaggedError(
  "QBusinessDataSourceNotReady",
)<{
  readonly dataSourceId: string;
  readonly status: string | undefined;
}> {}

/**
 * A data source whose asynchronous provisioning converged to the terminal
 * `FAILED` status.
 */
export class DataSourceProvisioningFailed extends Data.TaggedError(
  "QBusinessDataSourceProvisioningFailed",
)<{
  readonly dataSourceId: string;
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
    while: (e) => e._tag === "QBusinessDataSourceNotReady",
    // Data source provisioning is usually well under a minute; budget ~5 min.
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

// CreateDataSource validates the IAM role up front; a freshly-created role
// may not have propagated yet and surfaces as ValidationException. Bounded
// retry through the propagation window (~60s).
const retryThroughIamPropagation = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ValidationException",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(12)]),
  });

const waitForDataSourceStatus = (
  applicationId: string,
  indexId: string,
  dataSourceId: string,
  target: "ACTIVE" | "DELETED",
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* qbusiness
        .getDataSource({ applicationId, indexId, dataSourceId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (target === "DELETED") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new DataSourceNotReady({ dataSourceId, status: described.status }),
        );
      }
      if (described?.status === "ACTIVE") return;
      if (described?.status === "FAILED") {
        return yield* Effect.fail(
          new DataSourceProvisioningFailed({
            dataSourceId,
            message: described.error?.errorMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new DataSourceNotReady({ dataSourceId, status: described?.status }),
      );
    }),
  );

export const DataSourceProvider = () =>
  Provider.effect(
    DataSource,
    Effect.gen(function* () {
      return {
        stables: ["dataSourceId", "applicationId", "indexId", "dataSourceArn"],
        // Keyed by a parent application+index; cannot be enumerated
        // account-wide without iterating every application — treated as a
        // sub-resource per the factory list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const applicationId = output?.applicationId ?? olds?.applicationId;
          const indexId = output?.indexId ?? olds?.indexId;
          if (applicationId === undefined || indexId === undefined) {
            return undefined;
          }
          const state = output?.dataSourceId
            ? yield* readDataSourceById(
                applicationId,
                indexId,
                output.dataSourceId,
              )
            : yield* findDataSourceByName(
                applicationId,
                indexId,
                yield* createDisplayName(id, olds ?? {}),
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent application and index are fixed at creation.
          if (
            olds.applicationId !== news.applicationId ||
            olds.indexId !== news.indexId
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("QBusiness DataSource requires props"),
            );
          }
          const applicationId = news.applicationId;
          const indexId = news.indexId;
          const displayName = yield* createDisplayName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let state = output?.dataSourceId
            ? yield* readDataSourceById(
                applicationId,
                indexId,
                output.dataSourceId,
              )
            : yield* findDataSourceByName(applicationId, indexId, displayName);

          // Ensure — create if missing, then wait for ACTIVE.
          if (state === undefined) {
            const created = yield* retryThroughIamPropagation(
              qbusiness.createDataSource({
                applicationId,
                indexId,
                displayName,
                configuration: news.configuration,
                vpcConfiguration: news.vpcConfiguration,
                description: news.description,
                syncSchedule: news.syncSchedule,
                roleArn: news.roleArn,
                documentEnrichmentConfiguration:
                  news.documentEnrichmentConfiguration,
                mediaExtractionConfiguration: news.mediaExtractionConfiguration,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              }),
            );
            if (!created.dataSourceId) {
              return yield* Effect.fail(
                new Error(
                  `CreateDataSource for '${displayName}' returned no dataSourceId`,
                ),
              );
            }
            yield* session.note(
              `Creating data source ${displayName} (${created.dataSourceId})...`,
            );
            yield* waitForDataSourceStatus(
              applicationId,
              indexId,
              created.dataSourceId,
              "ACTIVE",
            );
            state = yield* readDataSourceById(
              applicationId,
              indexId,
              created.dataSourceId,
            );
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created data source ${displayName}`),
              );
            }
          }

          // Sync mutable settings via UpdateDataSource — only when drifted.
          const described = state.described;
          const needsUpdate =
            displayName !== described.displayName ||
            (news.description ?? "") !== (described.description ?? "") ||
            (news.syncSchedule ?? "") !== (described.syncSchedule ?? "") ||
            (news.roleArn !== undefined &&
              news.roleArn !== described.roleArn) ||
            news.configuration !== undefined ||
            news.vpcConfiguration !== undefined ||
            news.documentEnrichmentConfiguration !== undefined ||
            news.mediaExtractionConfiguration !== undefined;
          if (needsUpdate) {
            yield* qbusiness.updateDataSource({
              applicationId,
              indexId,
              dataSourceId: state.attrs.dataSourceId,
              displayName,
              configuration: news.configuration,
              vpcConfiguration: news.vpcConfiguration,
              description: news.description,
              syncSchedule: news.syncSchedule,
              roleArn: news.roleArn,
              documentEnrichmentConfiguration:
                news.documentEnrichmentConfiguration,
              mediaExtractionConfiguration: news.mediaExtractionConfiguration,
            });
            yield* waitForDataSourceStatus(
              applicationId,
              indexId,
              state.attrs.dataSourceId,
              "ACTIVE",
            );
            yield* session.note(`Updated data source ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* qbusiness.untagResource({
              resourceARN: state.attrs.dataSourceArn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* qbusiness.tagResource({
              resourceARN: state.attrs.dataSourceArn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }

          yield* session.note(state.attrs.dataSourceArn);

          const final = yield* readDataSourceById(
            applicationId,
            indexId,
            state.attrs.dataSourceId,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled data source ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* qbusiness
            .deleteDataSource({
              applicationId: output.applicationId,
              indexId: output.indexId,
              dataSourceId: output.dataSourceId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          yield* waitForDataSourceStatus(
            output.applicationId,
            output.indexId,
            output.dataSourceId,
            "DELETED",
          );
        }),
      };
    }),
  );
