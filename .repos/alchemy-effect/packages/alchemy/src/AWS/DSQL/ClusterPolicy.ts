import * as dsql from "@distilled.cloud/aws/dsql";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ClusterPolicyProps {
  /**
   * Identifier of the DSQL cluster the policy is attached to. A cluster has
   * at most one resource-based policy. Changing the cluster replaces the
   * policy.
   */
  clusterId: string;
  /**
   * The resource-based policy document (JSON) that defines access
   * permissions and conditions for the cluster — e.g. denying
   * `dsql:DbConnect` from outside a VPC, or restricting connections to an
   * AWS Organization. Updated in place.
   */
  policy: string;
  /**
   * Skip the lockout safety check that prevents attaching a policy which
   * would lock the calling principal out of `dsql:PutClusterPolicy` /
   * `dsql:DeleteClusterPolicy` on the cluster.
   * @default false
   */
  bypassPolicyLockoutSafetyCheck?: boolean;
}

export interface ClusterPolicy extends Resource<
  "AWS.DSQL.ClusterPolicy",
  ClusterPolicyProps,
  {
    /** Identifier of the cluster the policy is attached to. */
    clusterId: string;
    /** The policy document attached to the cluster. */
    policy: string;
    /** Version of the attached policy, used for optimistic concurrency. */
    policyVersion: string;
  },
  never,
  Providers
> {}

/**
 * The resource-based policy of an Aurora DSQL cluster — controls which
 * principals may perform actions on the cluster (most commonly gating
 * `dsql:DbConnect` / `dsql:DbConnectAdmin` behind VPC or Organization
 * conditions). A cluster has at most one.
 *
 * @resource
 * @section Creating a Cluster Policy
 * @example Block Connections from Outside a VPC
 * ```typescript
 * const cluster = yield* DSQL.Cluster("AppDb", {});
 * const policy = yield* DSQL.ClusterPolicy("VpcOnly", {
 *   clusterId: cluster.clusterId,
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Deny",
 *         Principal: { AWS: "*" },
 *         Action: ["dsql:DbConnect", "dsql:DbConnectAdmin"],
 *         Resource: "*",
 *         Condition: { Null: { "aws:SourceVpc": "true" } },
 *       },
 *     ],
 *   }),
 * });
 * ```
 *
 * @example Restrict Access to an AWS Organization
 * ```typescript
 * const policy = yield* DSQL.ClusterPolicy("OrgOnly", {
 *   clusterId: cluster.clusterId,
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Deny",
 *         Principal: { AWS: "*" },
 *         Action: ["dsql:DbConnect", "dsql:DbConnectAdmin"],
 *         Resource: "*",
 *         Condition: {
 *           StringNotEquals: { "aws:PrincipalOrgID": "o-exampleorgid" },
 *         },
 *       },
 *     ],
 *   }),
 * });
 * ```
 */
export const ClusterPolicy = Resource<ClusterPolicy>("AWS.DSQL.ClusterPolicy");

/** Order-insensitive canonical form of a JSON policy document. */
const canonicalJson = (document: string): string => {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, sort(v)]),
          )
        : value;
  try {
    return JSON.stringify(sort(JSON.parse(document)));
  } catch {
    return document;
  }
};

export const ClusterPolicyProvider = () =>
  Provider.effect(
    ClusterPolicy,
    Effect.gen(function* () {
      /** Read the policy; typed not-found → undefined. */
      const readPolicy = Effect.fn(function* (identifier: string) {
        return yield* dsql
          .getClusterPolicy({ identifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (
        clusterId: string,
        policy: string,
        policyVersion: string,
      ) => ({ clusterId, policy, policyVersion });

      return {
        stables: ["clusterId"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.clusterId !== news.clusterId) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const clusterId = output?.clusterId ?? olds?.clusterId;
          if (!clusterId) return undefined;
          const existing = yield* readPolicy(clusterId);
          if (existing === undefined) return undefined;
          // Cluster policies are not taggable — ownership is implied by the
          // owned parent cluster.
          return toAttrs(clusterId, existing.policy, existing.policyVersion);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const clusterId = news!.clusterId;

          // 1. Observe — the live policy is authoritative.
          const observed = yield* readPolicy(clusterId);

          // 2/3. Ensure + sync — `putClusterPolicy` is a true upsert; call
          // it only when the canonical document drifts. `expectedPolicyVersion`
          // pins the observed version so a concurrent writer surfaces as a
          // typed ConflictException instead of a silent overwrite.
          if (
            observed !== undefined &&
            canonicalJson(observed.policy) === canonicalJson(news!.policy)
          ) {
            yield* session.note(clusterId);
            return toAttrs(clusterId, observed.policy, observed.policyVersion);
          }

          const updated = yield* dsql.putClusterPolicy({
            identifier: clusterId,
            policy: news!.policy,
            bypassPolicyLockoutSafetyCheck:
              news!.bypassPolicyLockoutSafetyCheck,
            expectedPolicyVersion: observed?.policyVersion,
          });

          yield* session.note(clusterId);
          return toAttrs(clusterId, news!.policy, updated.policyVersion);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dsql
            .deleteClusterPolicy({ identifier: output.clusterId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
              }),
            );
        }),

        // Singleton sub-resource keyed by its parent cluster.
        list: () => Effect.succeed([]),
      };
    }),
  );
