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

export type SchedulerResourceStatus = sagemaker.SchedulerResourceStatus;

export interface ClusterSchedulerConfigProps {
  /**
   * Name of the cluster policy. Maximum 63 characters, alphanumeric and
   * hyphens.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * ARN of the EKS-orchestrated HyperPod cluster the policy applies to.
   * Changing the cluster replaces the policy. AWS allows ONE cluster
   * policy per cluster — creating a second fails with the typed
   * `ClusterSchedulerConfigAlreadyExists` error.
   */
  clusterArn: string;
  /**
   * The policy itself: task priority classes, fair-share allocation, and
   * idle-resource sharing.
   */
  schedulerConfig?: sagemaker.SchedulerConfig;
  /**
   * A description of the cluster policy.
   */
  description?: string;
  /**
   * Tags to associate with the cluster policy. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface ClusterSchedulerConfig extends Resource<
  "AWS.SageMaker.ClusterSchedulerConfig",
  ClusterSchedulerConfigProps,
  {
    /**
     * The cluster policy's ID.
     */
    clusterSchedulerConfigId: string;
    /**
     * ARN of the cluster policy.
     */
    clusterSchedulerConfigArn: string;
    /**
     * The cluster policy's name.
     */
    name: string;
    /**
     * ARN of the HyperPod cluster the policy applies to.
     */
    clusterArn: string;
    /**
     * The policy's current version (incremented on every update).
     */
    clusterSchedulerConfigVersion: number;
  },
  never,
  Providers
> {}

/**
 * A SageMaker HyperPod cluster policy (task governance) — configures how an
 * EKS-orchestrated HyperPod cluster prioritizes tasks and allocates idle
 * compute across teams via priority classes and fair-share weights.
 * @resource
 * @section Creating Cluster Policies
 * @example Priority Classes with Fair-Share
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const policy = yield* AWS.SageMaker.ClusterSchedulerConfig("Scheduler", {
 *   clusterArn: hyperpod.clusterArn,
 *   schedulerConfig: {
 *     PriorityClasses: [
 *       { Name: "inference", Weight: 100 },
 *       { Name: "training", Weight: 75 },
 *     ],
 *     FairShare: "Enabled",
 *   },
 *   description: "Prioritize inference over training",
 * });
 * ```
 */
export const ClusterSchedulerConfig = Resource<ClusterSchedulerConfig>(
  "AWS.SageMaker.ClusterSchedulerConfig",
);

const createConfigName = (id: string, props: { name?: string | undefined }) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 63 });

const describeConfigOrUndefined = (configId: string) =>
  sagemaker
    .describeClusterSchedulerConfig({ ClusterSchedulerConfigId: configId })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

/**
 * Look a cluster policy up by exact name — used when state was lost (read
 * without output) or a create raced.
 */
const findConfigByName = Effect.fn(function* (name: string) {
  const summaries = yield* sagemaker.listClusterSchedulerConfigs
    .pages({ NameContains: name })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap(
          (page) => page.ClusterSchedulerConfigSummaries ?? [],
        ),
      ),
    );
  return summaries.find((s) => s.Name === name && s.Status !== "Deleted");
});

const fetchConfigTags = Effect.fn(function* (arn: string) {
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

const toAttrs = (
  described: sagemaker.DescribeClusterSchedulerConfigResponse,
): ClusterSchedulerConfig["Attributes"] => ({
  clusterSchedulerConfigId: described.ClusterSchedulerConfigId,
  clusterSchedulerConfigArn: described.ClusterSchedulerConfigArn,
  name: described.Name,
  clusterArn: described.ClusterArn ?? "",
  clusterSchedulerConfigVersion: described.ClusterSchedulerConfigVersion,
});

/**
 * The cluster policy is still transitioning toward the awaited state —
 * retried by the bounded wait schedule.
 */
class SchedulerConfigNotReady extends Data.TaggedError(
  "SchedulerConfigNotReady",
)<{
  readonly configId: string;
  readonly status: string | undefined;
}> {}

/**
 * The cluster policy converged to a terminal failed status.
 */
export class SchedulerConfigFailed extends Data.TaggedError(
  "SchedulerConfigFailed",
)<{
  readonly configId: string;
  readonly status: string | undefined;
  readonly message: string | undefined;
}> {}

const FAILED_STATUSES: string[] = [
  "CreateFailed",
  "CreateRollbackFailed",
  "UpdateFailed",
  "UpdateRollbackFailed",
  "DeleteFailed",
  "DeleteRollbackFailed",
];

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "SchedulerConfigNotReady",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

const waitForConfig = (configId: string, target: "Ready" | "Gone") =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* describeConfigOrUndefined(configId);
      if (target === "Gone") {
        if (described === undefined || described.Status === "Deleted") return;
        if (FAILED_STATUSES.includes(described.Status)) {
          return yield* Effect.fail(
            new SchedulerConfigFailed({
              configId,
              status: described.Status,
              message: described.FailureReason,
            }),
          );
        }
        return yield* Effect.fail(
          new SchedulerConfigNotReady({ configId, status: described.Status }),
        );
      }
      if (described?.Status === "Created" || described?.Status === "Updated") {
        return;
      }
      if (
        described !== undefined &&
        FAILED_STATUSES.includes(described.Status)
      ) {
        return yield* Effect.fail(
          new SchedulerConfigFailed({
            configId,
            status: described.Status,
            message: described.FailureReason,
          }),
        );
      }
      return yield* Effect.fail(
        new SchedulerConfigNotReady({ configId, status: described?.Status }),
      );
    }),
  );

export const ClusterSchedulerConfigProvider = () =>
  Provider.effect(
    ClusterSchedulerConfig,
    Effect.gen(function* () {
      return {
        stables: [
          "clusterSchedulerConfigId",
          "clusterSchedulerConfigArn",
          "name",
          "clusterArn",
        ],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* sagemaker.listClusterSchedulerConfigs
              .pages({})
              .pipe(
                EffectStream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.ClusterSchedulerConfigSummaries ?? [],
                  ),
                ),
              );
            return summaries.flatMap((s) =>
              s.ClusterSchedulerConfigId !== undefined && s.Status !== "Deleted"
                ? [
                    {
                      clusterSchedulerConfigId: s.ClusterSchedulerConfigId,
                      clusterSchedulerConfigArn:
                        s.ClusterSchedulerConfigArn ?? "",
                      name: s.Name ?? "",
                      clusterArn: s.ClusterArn ?? "",
                      clusterSchedulerConfigVersion:
                        s.ClusterSchedulerConfigVersion ?? 1,
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const configId =
            output?.clusterSchedulerConfigId ??
            (yield* findConfigByName(yield* createConfigName(id, olds ?? {})))
              ?.ClusterSchedulerConfigId;
          if (configId === undefined) return undefined;
          const described = yield* describeConfigOrUndefined(configId);
          if (
            !described ||
            described.Status === "Deleting" ||
            described.Status === "Deleted"
          ) {
            return undefined;
          }
          const attrs = toAttrs(described);
          const tags = yield* fetchConfigTags(attrs.clusterSchedulerConfigArn);
          return (yield* hasAlchemyTags(id, tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          const oldName = yield* createConfigName(id, olds);
          const newName = yield* createConfigName(id, news);
          // The name and target cluster are fixed at creation.
          if (oldName !== newName || olds.clusterArn !== news.clusterArn) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("SageMaker ClusterSchedulerConfig requires props"),
            );
          }
          const name = yield* createConfigName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — by cached id first, then by name (lost state or race).
          let configId = output?.clusterSchedulerConfigId;
          let described =
            configId !== undefined
              ? yield* describeConfigOrUndefined(configId)
              : undefined;
          if (described === undefined) {
            const found = yield* findConfigByName(name);
            described =
              found?.ClusterSchedulerConfigId !== undefined
                ? yield* describeConfigOrUndefined(
                    found.ClusterSchedulerConfigId,
                  )
                : undefined;
          }

          // Ensure — create if missing; a Conflict means a concurrent
          // create won the race, so re-observe by name.
          if (described === undefined) {
            const created = yield* sagemaker
              .createClusterSchedulerConfig({
                Name: name,
                ClusterArn: news.clusterArn,
                SchedulerConfig: news.schedulerConfig,
                Description: news.description,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            configId =
              created?.ClusterSchedulerConfigId ??
              (yield* findConfigByName(name))?.ClusterSchedulerConfigId;
            if (configId === undefined) {
              return yield* Effect.fail(
                new Error(`failed to create cluster scheduler config ${name}`),
              );
            }
            yield* session.note(`Creating cluster policy ${name}...`);
            yield* waitForConfig(configId, "Ready");
          } else {
            configId = described.ClusterSchedulerConfigId;
            // Wait out any in-flight transition before diffing.
            yield* waitForConfig(configId, "Ready");
            described = yield* describeConfigOrUndefined(configId);
            // Sync — diff observed policy against desired.
            if (
              described !== undefined &&
              (JSON.stringify(described.SchedulerConfig) !==
                JSON.stringify(news.schedulerConfig) ||
                (described.Description ?? undefined) !==
                  (news.description ?? undefined))
            ) {
              yield* sagemaker.updateClusterSchedulerConfig({
                ClusterSchedulerConfigId: configId,
                TargetVersion: described.ClusterSchedulerConfigVersion,
                SchedulerConfig: news.schedulerConfig,
                Description: news.description,
              });
              yield* session.note(`Updating cluster policy ${name}...`);
              yield* waitForConfig(configId, "Ready");
            }
          }

          described = yield* describeConfigOrUndefined(configId);
          if (described === undefined) {
            return yield* Effect.fail(
              new Error(
                `failed to read reconciled cluster scheduler config ${name}`,
              ),
            );
          }
          const attrs = toAttrs(described);

          // Sync tags — diff against OBSERVED cloud tags.
          const currentTags = yield* fetchConfigTags(
            attrs.clusterSchedulerConfigArn,
          );
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* sagemaker.deleteTags({
              ResourceArn: attrs.clusterSchedulerConfigArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* sagemaker.addTags({
              ResourceArn: attrs.clusterSchedulerConfigArn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(attrs.clusterSchedulerConfigArn);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* sagemaker
            .deleteClusterSchedulerConfig({
              ClusterSchedulerConfigId: output.clusterSchedulerConfigId,
            })
            .pipe(Effect.catchTag("ResourceNotFound", () => Effect.void));
          yield* waitForConfig(output.clusterSchedulerConfigId, "Gone");
        }),
      };
    }),
  );
