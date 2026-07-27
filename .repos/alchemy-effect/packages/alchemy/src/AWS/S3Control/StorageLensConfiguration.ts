import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createTagsList,
  createInternalTags,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface StorageLensConfigurationProps {
  /**
   * ID of the Storage Lens configuration (1-64 characters: letters,
   * numbers, `-`, `_` and `.`). If omitted, a unique ID is generated
   * from the app, stage and logical ID.
   *
   * Changing the ID replaces the configuration.
   * @default ${app}-${stage}-${id}
   */
  configId?: string;
  /**
   * Whether the S3 Storage Lens configuration is enabled (actively
   * aggregating metrics).
   * @default true
   */
  isEnabled?: boolean;
  /**
   * Account-level metrics configuration (activity metrics, advanced
   * metrics, prefix-level metrics, ...). Passed through to the S3 Control
   * API verbatim.
   * @default { BucketLevel: {} } — free metrics for every bucket
   */
  accountLevel?: s3control.AccountLevel;
  /**
   * Restrict the dashboard to specific buckets and/or regions. Mutually
   * exclusive with `exclude`.
   */
  include?: s3control.Include;
  /**
   * Exclude specific buckets and/or regions from the dashboard. Mutually
   * exclusive with `include`.
   */
  exclude?: s3control.Exclude;
  /**
   * Export the daily metrics to an S3 bucket and/or publish them to
   * CloudWatch.
   */
  dataExport?: s3control.StorageLensDataExport;
  /**
   * ARN of the AWS Organization to aggregate metrics across member
   * accounts (requires trusted access / delegated administration).
   */
  awsOrg?: string;
  /**
   * Tags to apply to the configuration. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface StorageLensConfiguration extends Resource<
  "AWS.S3Control.StorageLensConfiguration",
  StorageLensConfigurationProps,
  {
    /**
     * ID of the Storage Lens configuration.
     */
    configId: string;
    /**
     * ARN of the Storage Lens configuration.
     */
    storageLensArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon S3 Storage Lens configuration — an account-wide (or
 * organization-wide) storage analytics dashboard aggregating usage and
 * activity metrics across buckets, with optional daily export to S3 or
 * CloudWatch.
 * @resource
 * @section Creating Dashboards
 * @example Free-metrics dashboard over the whole account
 * ```typescript
 * import * as S3Control from "alchemy/AWS/S3Control";
 *
 * const lens = yield* S3Control.StorageLensConfiguration("account-lens", {});
 * ```
 *
 * @example Dashboard scoped to specific buckets
 * ```typescript
 * const lens = yield* S3Control.StorageLensConfiguration("data-lens", {
 *   include: {
 *     Buckets: [bucket.bucketArn],
 *   },
 * });
 * ```
 *
 * @example Advanced metrics with S3 export
 * ```typescript
 * const lens = yield* S3Control.StorageLensConfiguration("advanced-lens", {
 *   accountLevel: {
 *     ActivityMetrics: { IsEnabled: true },
 *     BucketLevel: {
 *       ActivityMetrics: { IsEnabled: true },
 *     },
 *   },
 *   dataExport: {
 *     S3BucketDestination: {
 *       Format: "CSV",
 *       OutputSchemaVersion: "V_1",
 *       AccountId: accountId,
 *       Arn: reportBucket.bucketArn,
 *     },
 *   },
 * });
 * ```
 *
 * @example Disable a dashboard without deleting it
 * ```typescript
 * const lens = yield* S3Control.StorageLensConfiguration("account-lens", {
 *   isEnabled: false,
 * });
 * ```
 */
export const StorageLensConfiguration = Resource<StorageLensConfiguration>(
  "AWS.S3Control.StorageLensConfiguration",
);

/**
 * Retry while a freshly-written Storage Lens configuration has not
 * propagated to reads yet.
 *
 * Explicitly typed at module scope — inlining `Effect.retry` in a lifecycle
 * op leaks `Retry.Return`'s conditional type into declaration emit, widening
 * the provider layer to `unknown` and poisoning `AWS.providers()`.
 */
const retryWhileConfigurationPropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "NoSuchConfiguration",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(10)]),
  });

export const StorageLensConfigurationProvider = () =>
  Provider.effect(
    StorageLensConfiguration,
    Effect.gen(function* () {
      const createConfigId = Effect.fn(function* (
        id: string,
        props: Pick<StorageLensConfigurationProps, "configId">,
      ) {
        // Config IDs allow [a-zA-Z0-9-_.], 1-64 characters.
        return (
          props.configId ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const observeConfiguration = (accountId: string, configId: string) =>
        s3control
          .getStorageLensConfiguration({
            AccountId: accountId,
            ConfigId: configId,
          })
          .pipe(
            Effect.map((r) => r.StorageLensConfiguration),
            Effect.catchTag("NoSuchConfiguration", () =>
              Effect.succeed(undefined),
            ),
          );

      const observedTags = (accountId: string, configId: string) =>
        s3control
          .getStorageLensConfigurationTagging({
            AccountId: accountId,
            ConfigId: configId,
          })
          .pipe(
            Effect.map((r) =>
              Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
            ),
            Effect.catchTag("NoSuchConfiguration", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );

      const desiredConfiguration = (
        configId: string,
        props: StorageLensConfigurationProps,
      ): s3control.StorageLensConfiguration => ({
        Id: configId,
        AccountLevel: props.accountLevel ?? { BucketLevel: {} },
        Include: props.include,
        Exclude: props.exclude,
        DataExport: props.dataExport,
        IsEnabled: props.isEnabled ?? true,
        AwsOrg: props.awsOrg ? { Arn: props.awsOrg } : undefined,
      });

      // Canonical form for observed-vs-desired comparison: only the members
      // we manage, with `undefined` members normalized away.
      const canon = (cfg: s3control.StorageLensConfiguration) =>
        JSON.stringify({
          id: cfg.Id,
          // AWS omits an empty <BucketLevel/> from GET responses, so
          // normalize it to {} to avoid perpetual drift.
          accountLevel: {
            ...cfg.AccountLevel,
            BucketLevel: cfg.AccountLevel?.BucketLevel ?? {},
          },
          include: cfg.Include ?? null,
          exclude: cfg.Exclude ?? null,
          dataExport: cfg.DataExport ?? null,
          isEnabled: cfg.IsEnabled,
          awsOrg: cfg.AwsOrg ?? null,
        });

      return StorageLensConfiguration.Provider.of({
        stables: ["configId", "storageLensArn"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const pages = yield* s3control.listStorageLensConfigurations
              .pages({ AccountId: accountId })
              .pipe(Stream.runCollect);
            return Array.from(pages).flatMap((page) =>
              (page.StorageLensConfigurationList ?? []).map((entry) => ({
                configId: entry.Id,
                storageLensArn: entry.StorageLensArn,
              })),
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const configId =
            output?.configId ?? (yield* createConfigId(id, olds ?? {}));
          const observed = yield* observeConfiguration(accountId, configId);
          if (observed?.StorageLensArn === undefined) return undefined;
          const attrs = {
            configId,
            storageLensArn: observed.StorageLensArn,
          };
          const tags = yield* observedTags(accountId, configId);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldConfigId = yield* createConfigId(id, olds ?? {});
          const newConfigId = yield* createConfigId(id, news);
          if (oldConfigId !== newConfigId) {
            return { action: "replace" } as const;
          }
          // fall through: everything else converges via PUT (upsert)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const configId =
            output?.configId ?? (yield* createConfigId(id, news));

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* observeConfiguration(accountId, configId);

          // 2. ENSURE + SYNC — PutStorageLensConfiguration is a true upsert;
          //    write only when the observed configuration differs.
          const desired = desiredConfiguration(configId, news);
          if (observed === undefined || canon(observed) !== canon(desired)) {
            yield* s3control.putStorageLensConfiguration({
              AccountId: accountId,
              ConfigId: configId,
              StorageLensConfiguration: desired,
            });
          }

          // 3. SYNC TAGS — PutStorageLensConfigurationTagging replaces the
          //    whole tag set, so diff against OBSERVED tags only to decide
          //    whether a write is needed.
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const currentTags = yield* observedTags(accountId, configId);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0 || removed.length > 0) {
            yield* retryWhileConfigurationPropagates(
              s3control.putStorageLensConfigurationTagging({
                AccountId: accountId,
                ConfigId: configId,
                Tags: createTagsList(desiredTags),
              }),
            );
          }

          // 4. RETURN — re-read for the service-assigned ARN.
          const final = yield* retryWhileConfigurationPropagates(
            s3control.getStorageLensConfiguration({
              AccountId: accountId,
              ConfigId: configId,
            }),
          );

          yield* session.note(configId);
          return {
            configId,
            storageLensArn:
              final.StorageLensConfiguration?.StorageLensArn ??
              output?.storageLensArn ??
              "",
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* s3control
            .deleteStorageLensConfiguration({
              AccountId: accountId,
              ConfigId: output.configId,
            })
            .pipe(
              // Idempotent delete — already gone is success.
              Effect.catchTag("NoSuchConfiguration", () => Effect.void),
            );
        }),
      });
    }),
  );
