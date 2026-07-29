import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalizePolicy,
  retryWhileConflict,
  stringifyPolicy,
} from "./internal.ts";
import type { SecurityPolicyDocument } from "./SecurityPolicy.ts";

/** The kind of lifecycle policy. OpenSearch Serverless only defines `retention`. */
export type LifecyclePolicyType = "retention";

export interface LifecyclePolicyProps {
  /**
   * Name of the lifecycle policy (3-32 characters, lowercase). Changing the
   * name replaces the policy.
   * @default a generated physical name
   */
  policyName?: string;
  /**
   * The policy kind. OpenSearch Serverless currently only supports
   * `retention` policies. Changing the type replaces the policy.
   * @default "retention"
   */
  type?: LifecyclePolicyType;
  /**
   * The lifecycle policy document — a JSON object with `Rules` matching index
   * patterns to a retention window, e.g.
   * `{ Rules: [{ ResourceType: "index", Resource: ["index/my-collection/*"], MinIndexRetention: "30d" }] }`.
   * Use `NoMinIndexRetention: true` on a rule to retain matched indexes
   * indefinitely. Supply an object or a pre-serialized string.
   */
  policy: SecurityPolicyDocument;
  /**
   * A human-readable description of the policy.
   */
  description?: string;
}

export interface LifecyclePolicy extends Resource<
  "AWS.OpenSearchServerless.LifecyclePolicy",
  LifecyclePolicyProps,
  {
    /**
     * Name of the lifecycle policy.
     */
    policyName: string;
    /**
     * Policy type (`retention`).
     */
    type: string;
    /**
     * Version of the policy, used for optimistic-concurrency updates.
     */
    policyVersion: string;
    /**
     * Description of the lifecycle policy.
     */
    description?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon OpenSearch Serverless data lifecycle policy. Retention lifecycle
 * policies control how long documents are retained in the indexes matched by
 * the policy's resource patterns — OpenSearch Serverless automatically deletes
 * documents older than the configured `MinIndexRetention`.
 *
 * Lifecycle policies are free, provision instantly, and are matched to
 * indexes by resource pattern (e.g. `index/my-collection/*`) — the collection
 * does not need to exist when the policy is created.
 *
 * @resource
 * @section Creating Lifecycle Policies
 * @example Retain Log Indexes for 30 Days
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const retention = yield* AWS.OpenSearchServerless.LifecyclePolicy("Retention", {
 *   policyName: "logs-retention",
 *   policy: {
 *     Rules: [
 *       {
 *         ResourceType: "index",
 *         Resource: ["index/logs/*"],
 *         MinIndexRetention: "30d",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Unlimited Retention for Specific Indexes
 * ```typescript
 * const keepForever = yield* AWS.OpenSearchServerless.LifecyclePolicy("KeepForever", {
 *   policyName: "audit-retention",
 *   policy: {
 *     Rules: [
 *       {
 *         ResourceType: "index",
 *         Resource: ["index/audit/*"],
 *         NoMinIndexRetention: true,
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const LifecyclePolicy = Resource<LifecyclePolicy>(
  "AWS.OpenSearchServerless.LifecyclePolicy",
);

const LIFECYCLE_POLICY_TYPE = "retention";

export const LifecyclePolicyProvider = () =>
  Provider.effect(
    LifecyclePolicy,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { policyName?: string | undefined },
      ) {
        return (
          props.policyName ??
          (yield* createPhysicalName({ id, maxLength: 32, lowercase: true }))
        );
      });

      const toAttributes = (detail: aoss.LifecyclePolicyDetail) => ({
        policyName: detail.name!,
        type: detail.type!,
        policyVersion: detail.policyVersion!,
        description: detail.description,
      });

      // batchGetLifecyclePolicy reports a missing policy in
      // lifecyclePolicyErrorDetails instead of failing, which observe treats
      // as "not present".
      const observe = Effect.fn(function* (type: string, name: string) {
        const response = yield* aoss.batchGetLifecyclePolicy({
          identifiers: [{ type, name }],
        });
        return response.lifecyclePolicyDetails?.[0];
      });

      return LifecyclePolicy.Provider.of({
        stables: ["policyName", "type"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* aoss.listLifecyclePolicies
              .pages({ type: LIFECYCLE_POLICY_TYPE })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.lifecyclePolicySummaries ?? [])
              .filter(
                (s) =>
                  s.name !== undefined &&
                  s.type !== undefined &&
                  s.policyVersion !== undefined,
              )
              .map((s) => ({
                policyName: s.name!,
                type: s.type!,
                policyVersion: s.policyVersion!,
                description: s.description,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.policyName ?? (yield* createName(id, olds ?? {}));
          const detail = yield* observe(LIFECYCLE_POLICY_TYPE, name);
          if (detail?.name === undefined) {
            return undefined;
          }
          // Lifecycle policies carry no tags, so an existing same-name policy
          // is adopted.
          return toAttributes(detail);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            (olds.type ?? LIFECYCLE_POLICY_TYPE) !==
            (news.type ?? LIFECYCLE_POLICY_TYPE)
          ) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // description/policy fall through to the default update path
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const type = news.type ?? LIFECYCLE_POLICY_TYPE;
          const name = output?.policyName ?? (yield* createName(id, news));
          const policy = stringifyPolicy(news.policy);

          // 1. OBSERVE
          let detail = yield* observe(type, name);

          // 2. ENSURE — create if missing; tolerate a concurrent create race
          if (detail?.name === undefined) {
            detail = yield* aoss
              .createLifecyclePolicy({
                type,
                name,
                policy,
                description: news.description,
              })
              .pipe(
                Effect.map((r) => r.lifecyclePolicyDetail),
                Effect.catchTag("ConflictException", () => observe(type, name)),
              );
          } else {
            // 3. SYNC — update policy/description when observed drifts from desired
            const policyDrift =
              canonicalizePolicy(detail.policy) !== canonicalizePolicy(policy);
            const descriptionDrift =
              news.description !== undefined &&
              news.description !== detail.description;
            if (policyDrift || descriptionDrift) {
              detail = yield* aoss
                .updateLifecyclePolicy({
                  type,
                  name,
                  policyVersion: detail.policyVersion!,
                  policy: policyDrift ? policy : undefined,
                  description: descriptionDrift ? news.description : undefined,
                })
                .pipe(Effect.map((r) => r.lifecyclePolicyDetail));
            }
          }

          if (detail?.name === undefined) {
            return yield* Effect.fail(
              new aoss.ResourceNotFoundException({
                message: `lifecycle policy ${type}/${name} not visible after reconcile`,
              }),
            );
          }
          yield* session.note(`${type}/${name}`);
          return toAttributes(detail);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            aoss.deleteLifecyclePolicy({
              type: output.type,
              name: output.policyName,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
