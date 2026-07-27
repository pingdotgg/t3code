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

export interface ComputeQuotaProps {
  /**
   * Name of the compute allocation. Maximum 63 characters, alphanumeric and
   * hyphens.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * ARN of the EKS-orchestrated HyperPod cluster the allocation applies to.
   * Changing the cluster replaces the allocation.
   */
  clusterArn: string;
  /**
   * The team the quota is allocated to (its name maps to a Kubernetes
   * namespace `hyperpod-ns-<team-name>`) and its fair-share weight.
   */
  computeQuotaTarget: sagemaker.ComputeQuotaTarget;
  /**
   * The allocation itself: instance-type quotas, the resource-sharing
   * strategy for idle compute, and whether the team's own tasks can preempt
   * each other.
   */
  computeQuotaConfig?: sagemaker.ComputeQuotaConfig;
  /**
   * Whether the quota is enforced.
   * @default "Enabled"
   */
  activationState?: sagemaker.ActivationState;
  /**
   * A description of the compute allocation.
   */
  description?: string;
  /**
   * Tags to associate with the compute allocation. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ComputeQuota extends Resource<
  "AWS.SageMaker.ComputeQuota",
  ComputeQuotaProps,
  {
    /**
     * The compute allocation's ID.
     */
    computeQuotaId: string;
    /**
     * ARN of the compute allocation.
     */
    computeQuotaArn: string;
    /**
     * The compute allocation's name.
     */
    name: string;
    /**
     * ARN of the HyperPod cluster the allocation applies to.
     */
    clusterArn: string;
    /**
     * The allocation's current version (incremented on every update).
     */
    computeQuotaVersion: number;
    /**
     * The team the quota is allocated to. Task governance materializes the
     * `hyperpod-ns-<teamName>` namespace and its Kueue LocalQueue from it.
     */
    teamName: string;
  },
  never,
  Providers
> {}

/**
 * A SageMaker HyperPod compute allocation (task governance) — reserves
 * instance capacity on an EKS-orchestrated HyperPod cluster for a team,
 * with fair-share weights and borrow/lend rules for idle compute.
 * @resource
 * @section Creating Compute Allocations
 * @example Team Quota with Borrowing
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const quota = yield* AWS.SageMaker.ComputeQuota("ResearchQuota", {
 *   clusterArn: hyperpod.clusterArn,
 *   computeQuotaTarget: { TeamName: "research", FairShareWeight: 10 },
 *   computeQuotaConfig: {
 *     ComputeQuotaResources: [{ InstanceType: "ml.g5.xlarge", Count: 2 }],
 *     ResourceSharingConfig: { Strategy: "Lend", BorrowLimit: 50 },
 *   },
 * });
 * ```
 */
export const ComputeQuota = Resource<ComputeQuota>(
  "AWS.SageMaker.ComputeQuota",
);

const createQuotaName = (id: string, props: { name?: string | undefined }) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 63 });

const describeQuotaOrUndefined = (quotaId: string) =>
  sagemaker
    .describeComputeQuota({ ComputeQuotaId: quotaId })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

/**
 * Look a compute allocation up by exact name — used when state was lost
 * (read without output) or a create raced.
 */
const findQuotaByName = Effect.fn(function* (name: string) {
  const summaries = yield* sagemaker.listComputeQuotas
    .pages({ NameContains: name })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.ComputeQuotaSummaries ?? []),
      ),
    );
  return summaries.find((s) => s.Name === name && s.Status !== "Deleted");
});

const fetchQuotaTags = Effect.fn(function* (arn: string) {
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
  described: sagemaker.DescribeComputeQuotaResponse,
): ComputeQuota["Attributes"] => ({
  computeQuotaId: described.ComputeQuotaId,
  computeQuotaArn: described.ComputeQuotaArn,
  name: described.Name,
  clusterArn: described.ClusterArn ?? "",
  computeQuotaVersion: described.ComputeQuotaVersion,
  teamName: described.ComputeQuotaTarget?.TeamName ?? "",
});

/**
 * The compute allocation is still transitioning toward the awaited state —
 * retried by the bounded wait schedule.
 */
class ComputeQuotaNotReady extends Data.TaggedError("ComputeQuotaNotReady")<{
  readonly quotaId: string;
  readonly status: string | undefined;
}> {}

/**
 * The compute allocation converged to a terminal failed status.
 */
export class ComputeQuotaFailed extends Data.TaggedError("ComputeQuotaFailed")<{
  readonly quotaId: string;
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
    while: (e) => e._tag === "ComputeQuotaNotReady",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

const waitForQuota = (quotaId: string, target: "Ready" | "Gone") =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* describeQuotaOrUndefined(quotaId);
      if (target === "Gone") {
        if (described === undefined || described.Status === "Deleted") return;
        if (FAILED_STATUSES.includes(described.Status)) {
          return yield* Effect.fail(
            new ComputeQuotaFailed({
              quotaId,
              status: described.Status,
              message: described.FailureReason,
            }),
          );
        }
        return yield* Effect.fail(
          new ComputeQuotaNotReady({ quotaId, status: described.Status }),
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
          new ComputeQuotaFailed({
            quotaId,
            status: described.Status,
            message: described.FailureReason,
          }),
        );
      }
      return yield* Effect.fail(
        new ComputeQuotaNotReady({ quotaId, status: described?.Status }),
      );
    }),
  );

export const ComputeQuotaProvider = () =>
  Provider.effect(
    ComputeQuota,
    Effect.gen(function* () {
      return {
        stables: ["computeQuotaId", "computeQuotaArn", "name", "clusterArn"],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* sagemaker.listComputeQuotas.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.ComputeQuotaSummaries ?? [],
                ),
              ),
            );
            return summaries.flatMap((s) =>
              s.ComputeQuotaId !== undefined && s.Status !== "Deleted"
                ? [
                    {
                      computeQuotaId: s.ComputeQuotaId,
                      computeQuotaArn: s.ComputeQuotaArn ?? "",
                      name: s.Name ?? "",
                      clusterArn: s.ClusterArn ?? "",
                      computeQuotaVersion: s.ComputeQuotaVersion ?? 1,
                      teamName: s.ComputeQuotaTarget?.TeamName ?? "",
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const quotaId =
            output?.computeQuotaId ??
            (yield* findQuotaByName(yield* createQuotaName(id, olds ?? {})))
              ?.ComputeQuotaId;
          if (quotaId === undefined) return undefined;
          const described = yield* describeQuotaOrUndefined(quotaId);
          if (
            !described ||
            described.Status === "Deleting" ||
            described.Status === "Deleted"
          ) {
            return undefined;
          }
          const attrs = toAttrs(described);
          const tags = yield* fetchQuotaTags(attrs.computeQuotaArn);
          return (yield* hasAlchemyTags(id, tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          const oldName = yield* createQuotaName(id, olds);
          const newName = yield* createQuotaName(id, news);
          // The name and target cluster are fixed at creation.
          if (oldName !== newName || olds.clusterArn !== news.clusterArn) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("SageMaker ComputeQuota requires props"),
            );
          }
          const name = yield* createQuotaName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — by cached id first, then by name (lost state or race).
          let quotaId = output?.computeQuotaId;
          let described =
            quotaId !== undefined
              ? yield* describeQuotaOrUndefined(quotaId)
              : undefined;
          if (described === undefined) {
            const found = yield* findQuotaByName(name);
            described =
              found?.ComputeQuotaId !== undefined
                ? yield* describeQuotaOrUndefined(found.ComputeQuotaId)
                : undefined;
          }

          // Ensure — create if missing; a Conflict means a concurrent
          // create won the race, so re-observe by name.
          if (described === undefined) {
            const created = yield* sagemaker
              .createComputeQuota({
                Name: name,
                ClusterArn: news.clusterArn,
                ComputeQuotaConfig: news.computeQuotaConfig,
                ComputeQuotaTarget: news.computeQuotaTarget,
                ActivationState: news.activationState,
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
            quotaId =
              created?.ComputeQuotaId ??
              (yield* findQuotaByName(name))?.ComputeQuotaId;
            if (quotaId === undefined) {
              return yield* Effect.fail(
                new Error(`failed to create compute quota ${name}`),
              );
            }
            yield* session.note(`Creating compute quota ${name}...`);
            yield* waitForQuota(quotaId, "Ready");
          } else {
            quotaId = described.ComputeQuotaId;
            // Wait out any in-flight transition before diffing.
            yield* waitForQuota(quotaId, "Ready");
            described = yield* describeQuotaOrUndefined(quotaId);
            // Sync — diff observed allocation against desired.
            if (
              described !== undefined &&
              (JSON.stringify(described.ComputeQuotaConfig) !==
                JSON.stringify(news.computeQuotaConfig) ||
                JSON.stringify(described.ComputeQuotaTarget) !==
                  JSON.stringify(news.computeQuotaTarget) ||
                (news.activationState !== undefined &&
                  described.ActivationState !== news.activationState) ||
                (described.Description ?? undefined) !==
                  (news.description ?? undefined))
            ) {
              yield* sagemaker.updateComputeQuota({
                ComputeQuotaId: quotaId,
                TargetVersion: described.ComputeQuotaVersion,
                ComputeQuotaConfig: news.computeQuotaConfig,
                ComputeQuotaTarget: news.computeQuotaTarget,
                ActivationState: news.activationState,
                Description: news.description,
              });
              yield* session.note(`Updating compute quota ${name}...`);
              yield* waitForQuota(quotaId, "Ready");
            }
          }

          described = yield* describeQuotaOrUndefined(quotaId);
          if (described === undefined) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled compute quota ${name}`),
            );
          }
          const attrs = toAttrs(described);

          // Sync tags — diff against OBSERVED cloud tags.
          const currentTags = yield* fetchQuotaTags(attrs.computeQuotaArn);
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* sagemaker.deleteTags({
              ResourceArn: attrs.computeQuotaArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* sagemaker.addTags({
              ResourceArn: attrs.computeQuotaArn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(attrs.computeQuotaArn);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* sagemaker
            .deleteComputeQuota({ ComputeQuotaId: output.computeQuotaId })
            .pipe(Effect.catchTag("ResourceNotFound", () => Effect.void));
          yield* waitForQuota(output.computeQuotaId, "Gone");
        }),
      };
    }),
  );
