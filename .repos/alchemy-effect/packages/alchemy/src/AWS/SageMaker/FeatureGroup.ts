import * as sagemaker from "@distilled.cloud/aws/sagemaker";
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

export type FeatureGroupStatus = sagemaker.FeatureGroupStatus;

export interface FeatureGroupProps {
  /**
   * Name of the feature group. Maximum 64 characters, alphanumeric and
   * hyphens.
   * @default ${app}-${stage}-${id}
   */
  featureGroupName?: string;
  /**
   * The name of the feature whose value uniquely identifies a record. Must
   * be one of the `featureDefinitions`.
   */
  recordIdentifierFeatureName: string;
  /**
   * The name of the feature that stores each record's event time (an ISO
   * 8601 string or unix seconds). Must be one of the `featureDefinitions`.
   */
  eventTimeFeatureName: string;
  /**
   * The schema: every feature's name and type (`String`, `Integral`,
   * `Fractional`).
   */
  featureDefinitions: sagemaker.FeatureDefinition[];
  /**
   * Enable the low-latency online store (required for
   * `GetRecord`/`PutRecord` runtime bindings).
   */
  onlineStoreConfig?: sagemaker.OnlineStoreConfig;
  /**
   * Replicate writes to an S3-backed offline store (for training). Requires
   * `roleArn`.
   */
  offlineStoreConfig?: sagemaker.OfflineStoreConfig;
  /**
   * Provisioned or on-demand read/write throughput for the online store.
   */
  throughputConfig?: sagemaker.ThroughputConfig;
  /**
   * ARN of the IAM role SageMaker assumes to write the offline store to S3.
   * Only required when `offlineStoreConfig` is set.
   */
  roleArn?: string;
  /**
   * A description of the feature group.
   */
  description?: string;
  /**
   * Tags to associate with the feature group. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface FeatureGroup extends Resource<
  "AWS.SageMaker.FeatureGroup",
  FeatureGroupProps,
  {
    /**
     * The feature group's name.
     */
    featureGroupName: string;
    /**
     * ARN of the feature group.
     */
    featureGroupArn: string;
    /**
     * The record-identifier feature name.
     */
    recordIdentifierFeatureName: string;
    /**
     * The event-time feature name.
     */
    eventTimeFeatureName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SageMaker Feature Store FeatureGroup — a typed, versioned table
 * of ML features with an optional low-latency online store (for inference
 * lookups) and an S3-backed offline store (for training).
 *
 * With the online store enabled, functions read and write records at runtime
 * via the `AWS.SageMaker.GetRecord` / `AWS.SageMaker.PutRecord` bindings.
 * @resource
 * @section Creating Feature Groups
 * @example Online-Store Feature Group
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const features = yield* AWS.SageMaker.FeatureGroup("UserFeatures", {
 *   recordIdentifierFeatureName: "user_id",
 *   eventTimeFeatureName: "event_time",
 *   featureDefinitions: [
 *     { FeatureName: "user_id", FeatureType: "String" },
 *     { FeatureName: "event_time", FeatureType: "String" },
 *     { FeatureName: "clicks", FeatureType: "Integral" },
 *   ],
 *   onlineStoreConfig: { EnableOnlineStore: true },
 * });
 * ```
 *
 * @section Runtime Access
 * @example Read and write records from a Lambda function
 * ```typescript
 * // init
 * const putRecord = yield* AWS.SageMaker.PutRecord(features);
 * const getRecord = yield* AWS.SageMaker.GetRecord(features);
 *
 * // runtime
 * yield* putRecord({
 *   Record: [
 *     { FeatureName: "user_id", ValueAsString: "user-123" },
 *     { FeatureName: "event_time", ValueAsString: new Date().toISOString() },
 *     { FeatureName: "clicks", ValueAsString: "42" },
 *   ],
 * });
 * const { Record } = yield* getRecord({
 *   RecordIdentifierValueAsString: "user-123",
 * });
 * ```
 */
export const FeatureGroup = Resource<FeatureGroup>(
  "AWS.SageMaker.FeatureGroup",
);

const createFeatureGroupName = (
  id: string,
  props: { featureGroupName?: string | undefined },
) =>
  props.featureGroupName
    ? Effect.succeed(props.featureGroupName)
    : createPhysicalName({ id, maxLength: 64 });

const fetchFeatureGroupTags = Effect.fn(function* (arn: string) {
  const response = yield* sagemaker
    .listTags({ ResourceArn: arn })
    .pipe(
      Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
    );
  return Object.fromEntries(
    (response?.Tags ?? []).flatMap((tag) =>
      tag.Key !== undefined ? [[tag.Key, tag.Value ?? ""]] : [],
    ),
  );
});

const describeFeatureGroupOrUndefined = (name: string) =>
  sagemaker
    .describeFeatureGroup({ FeatureGroupName: name })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  described: sagemaker.DescribeFeatureGroupResponse,
): FeatureGroup["Attributes"] => ({
  featureGroupName: described.FeatureGroupName,
  featureGroupArn: described.FeatureGroupArn,
  recordIdentifierFeatureName: described.RecordIdentifierFeatureName,
  eventTimeFeatureName: described.EventTimeFeatureName,
});

/**
 * The feature group is still transitioning toward the awaited state —
 * retried by the bounded wait schedule.
 */
class FeatureGroupNotReady extends Data.TaggedError("FeatureGroupNotReady")<{
  readonly featureGroupName: string;
  readonly status: string | undefined;
}> {}

/**
 * The feature group's asynchronous creation converged to the terminal
 * `CreateFailed` status.
 */
export class FeatureGroupCreateFailed extends Data.TaggedError(
  "FeatureGroupCreateFailed",
)<{
  readonly featureGroupName: string;
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
    while: (e) => e._tag === "FeatureGroupNotReady",
    // Online-store creation typically converges in well under 2 minutes;
    // offline-store (Glue) creation can take a few. Poll 5s up to ~5 min.
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

const waitForFeatureGroup = (name: string, target: "Created" | "Gone") =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* describeFeatureGroupOrUndefined(name);
      if (target === "Gone") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new FeatureGroupNotReady({
            featureGroupName: name,
            status: described.FeatureGroupStatus,
          }),
        );
      }
      if (described?.FeatureGroupStatus === "Created") return;
      if (
        described?.FeatureGroupStatus === "CreateFailed" ||
        described?.FeatureGroupStatus === "DeleteFailed"
      ) {
        return yield* Effect.fail(
          new FeatureGroupCreateFailed({
            featureGroupName: name,
            message: described.FailureReason,
          }),
        );
      }
      return yield* Effect.fail(
        new FeatureGroupNotReady({
          featureGroupName: name,
          status: described?.FeatureGroupStatus,
        }),
      );
    }),
  );

export const FeatureGroupProvider = () =>
  Provider.effect(
    FeatureGroup,
    Effect.gen(function* () {
      return {
        stables: [
          "featureGroupName",
          "featureGroupArn",
          "recordIdentifierFeatureName",
          "eventTimeFeatureName",
        ],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* sagemaker.listFeatureGroups.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.FeatureGroupSummaries ?? [],
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              summaries.flatMap((s) =>
                s.FeatureGroupName !== undefined ? [s.FeatureGroupName] : [],
              ),
              (name) =>
                describeFeatureGroupOrUndefined(name).pipe(
                  Effect.map((d) => (d === undefined ? undefined : toAttrs(d))),
                ),
              { concurrency: 5 },
            );
            return hydrated.filter(
              (attrs): attrs is FeatureGroup["Attributes"] =>
                attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.featureGroupName ??
            (yield* createFeatureGroupName(id, olds ?? {}));
          const described = yield* describeFeatureGroupOrUndefined(name);
          if (!described || described.FeatureGroupStatus === "Deleting") {
            return undefined;
          }
          const attrs = toAttrs(described);
          const tags = yield* fetchFeatureGroupTags(attrs.featureGroupArn);
          return (yield* hasAlchemyTags(id, tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The feature group schema and stores are fixed at creation —
          // everything except tags replaces.
          const identity = (props: FeatureGroupProps) => [
            props.recordIdentifierFeatureName,
            props.eventTimeFeatureName,
            props.featureDefinitions,
            props.onlineStoreConfig,
            props.offlineStoreConfig,
            props.throughputConfig,
            props.roleArn,
            props.description,
          ];
          const oldName = yield* createFeatureGroupName(id, olds);
          const newName = yield* createFeatureGroupName(id, news);
          if (
            oldName !== newName ||
            JSON.stringify(identity(olds)) !== JSON.stringify(identity(news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("SageMaker FeatureGroup requires props"),
            );
          }
          const name =
            output?.featureGroupName ??
            (yield* createFeatureGroupName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let described = yield* describeFeatureGroupOrUndefined(name);

          // Ensure — create if missing; tolerate the already-exists race.
          if (described === undefined) {
            yield* sagemaker
              .createFeatureGroup({
                FeatureGroupName: name,
                RecordIdentifierFeatureName: news.recordIdentifierFeatureName,
                EventTimeFeatureName: news.eventTimeFeatureName,
                FeatureDefinitions: news.featureDefinitions,
                OnlineStoreConfig: news.onlineStoreConfig,
                OfflineStoreConfig: news.offlineStoreConfig,
                ThroughputConfig: news.throughputConfig,
                RoleArn: news.roleArn,
                Description: news.description,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(Effect.catchTag("ResourceInUse", () => Effect.void));
            yield* session.note(`Creating feature group ${name}...`);
          }

          // Converge to Created (creation is asynchronous).
          yield* waitForFeatureGroup(name, "Created");
          described = yield* describeFeatureGroupOrUndefined(name);
          if (described === undefined) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled feature group ${name}`),
            );
          }
          const attrs = toAttrs(described);

          // Sync tags — diff against OBSERVED cloud tags.
          const currentTags = yield* fetchFeatureGroupTags(
            attrs.featureGroupArn,
          );
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* sagemaker.deleteTags({
              ResourceArn: attrs.featureGroupArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* sagemaker.addTags({
              ResourceArn: attrs.featureGroupArn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(attrs.featureGroupArn);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* sagemaker
            .deleteFeatureGroup({
              FeatureGroupName: output.featureGroupName,
            })
            .pipe(Effect.catchTag("ResourceNotFound", () => Effect.void));
          yield* waitForFeatureGroup(output.featureGroupName, "Gone");
        }),
      };
    }),
  );
