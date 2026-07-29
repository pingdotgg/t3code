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

/** The kind of security policy — encryption at rest or network access. */
export type SecurityPolicyType = "encryption" | "network";

/** A security policy document — a JSON object/array or a pre-serialized string. */
export type SecurityPolicyDocument =
  | string
  | Record<string, unknown>
  | readonly unknown[];

export interface SecurityPolicyProps {
  /**
   * Name of the security policy (3-32 characters, lowercase). Must be unique
   * within its {@link SecurityPolicyProps.type | type}. Changing the name
   * replaces the policy.
   * @default a generated physical name
   */
  policyName?: string;
  /**
   * The policy kind:
   * - `encryption` — encryption-at-rest policy (a single JSON object with
   *   `Rules` and either `AWSOwnedKey` or `KmsARN`). Every collection MUST be
   *   matched by exactly one encryption policy before it can be created.
   * - `network` — network-access policy (a JSON array of rules controlling
   *   public/VPC access to the collection and Dashboards endpoints).
   *
   * Changing the type replaces the policy.
   */
  type: SecurityPolicyType;
  /**
   * The policy document. Supply a JSON object (encryption) or array (network),
   * or a pre-serialized string when you need to interpolate an `Output`-derived
   * collection name into it.
   */
  policy: SecurityPolicyDocument;
  /**
   * A human-readable description of the policy.
   */
  description?: string;
}

export interface SecurityPolicy extends Resource<
  "AWS.OpenSearchServerless.SecurityPolicy",
  SecurityPolicyProps,
  {
    /**
     * Name of the security policy.
     */
    policyName: string;
    /**
     * Policy type (`encryption` or `network`).
     */
    type: string;
    /**
     * Version of the policy, used for optimistic-concurrency updates.
     */
    policyVersion: string;
    /**
     * Description of the security policy.
     */
    description?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon OpenSearch Serverless security policy. Security policies govern
 * encryption at rest (`encryption`) and network access (`network`) for one or
 * more collections, matched by a resource pattern such as
 * `collection/my-collection`.
 *
 * An **encryption** policy is a prerequisite for every collection — a
 * collection whose name is not covered by an encryption policy fails to
 * create. A **network** policy controls whether the collection's data and
 * OpenSearch Dashboards endpoints are reachable from public networks or only
 * from specific VPC endpoints.
 *
 * @resource
 * @section Encryption Policies
 * @example AWS-Owned-Key Encryption Policy
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const encryption = yield* AWS.OpenSearchServerless.SecurityPolicy("Encryption", {
 *   policyName: "my-collection-enc",
 *   type: "encryption",
 *   policy: {
 *     Rules: [{ ResourceType: "collection", Resource: ["collection/my-collection"] }],
 *     AWSOwnedKey: true,
 *   },
 * });
 * ```
 *
 * @section Network Policies
 * @example Public Network Access Policy
 * ```typescript
 * const network = yield* AWS.OpenSearchServerless.SecurityPolicy("Network", {
 *   policyName: "my-collection-net",
 *   type: "network",
 *   policy: [
 *     {
 *       Rules: [
 *         { ResourceType: "collection", Resource: ["collection/my-collection"] },
 *         { ResourceType: "dashboard", Resource: ["collection/my-collection"] },
 *       ],
 *       AllowFromPublic: true,
 *     },
 *   ],
 * });
 * ```
 */
export const SecurityPolicy = Resource<SecurityPolicy>(
  "AWS.OpenSearchServerless.SecurityPolicy",
);

export const SecurityPolicyProvider = () =>
  Provider.effect(
    SecurityPolicy,
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

      const toAttributes = (detail: aoss.SecurityPolicyDetail) => ({
        policyName: detail.name!,
        type: detail.type!,
        policyVersion: detail.policyVersion!,
        description: detail.description,
      });

      return SecurityPolicy.Provider.of({
        stables: ["policyName", "type"],

        list: () =>
          Effect.gen(function* () {
            const types: SecurityPolicyType[] = ["encryption", "network"];
            const results: {
              policyName: string;
              type: string;
              policyVersion: string;
              description?: string;
            }[] = [];
            for (const type of types) {
              const pages = yield* aoss.listSecurityPolicies
                .pages({ type })
                .pipe(Stream.runCollect);
              for (const page of pages) {
                for (const s of page.securityPolicySummaries ?? []) {
                  if (
                    s.name !== undefined &&
                    s.type !== undefined &&
                    s.policyVersion !== undefined
                  ) {
                    results.push({
                      policyName: s.name,
                      type: s.type,
                      policyVersion: s.policyVersion,
                      description: s.description,
                    });
                  }
                }
              }
            }
            return results;
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const type = output?.type ?? olds?.type;
          if (type === undefined) {
            return undefined;
          }
          const name =
            output?.policyName ?? (yield* createName(id, olds ?? {}));
          const found = yield* aoss
            .getSecurityPolicy({ type, name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found?.securityPolicyDetail === undefined) {
            return undefined;
          }
          // Security policies carry no tags, so ownership cannot be gated —
          // an existing same-name policy is adopted.
          return toAttributes(found.securityPolicyDetail);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.type !== news.type) {
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
          const type = news.type;
          const name = output?.policyName ?? (yield* createName(id, news));
          const policy = stringifyPolicy(news.policy);

          // 1. OBSERVE
          let detail = yield* aoss.getSecurityPolicy({ type, name }).pipe(
            Effect.map((r) => r.securityPolicyDetail),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

          // 2. ENSURE — create if missing; tolerate a concurrent create race
          if (detail === undefined) {
            detail = yield* aoss
              .createSecurityPolicy({
                type,
                name,
                policy,
                description: news.description,
              })
              .pipe(
                Effect.map((r) => r.securityPolicyDetail),
                Effect.catchTag("ConflictException", () =>
                  aoss
                    .getSecurityPolicy({ type, name })
                    .pipe(Effect.map((r) => r.securityPolicyDetail)),
                ),
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
                .updateSecurityPolicy({
                  type,
                  name,
                  policyVersion: detail.policyVersion!,
                  policy: policyDrift ? policy : undefined,
                  description: descriptionDrift ? news.description : undefined,
                })
                .pipe(Effect.map((r) => r.securityPolicyDetail));
            }
          }

          if (detail?.name === undefined) {
            return yield* Effect.fail(
              new aoss.ResourceNotFoundException({
                message: `security policy ${type}/${name} not visible after reconcile`,
              }),
            );
          }
          yield* session.note(`${type}/${name}`);
          return toAttributes(detail);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            aoss.deleteSecurityPolicy({
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
