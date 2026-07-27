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

export interface AccessPolicyProps {
  /**
   * Name of the data access policy (3-32 characters, lowercase). Changing the
   * name replaces the policy.
   * @default a generated physical name
   */
  policyName?: string;
  /**
   * The data access policy document — a JSON array of rules granting principals
   * (IAM roles/users) collection- and index-level permissions such as
   * `aoss:CreateIndex`, `aoss:ReadDocument`, `aoss:WriteDocument`. Supply an
   * array/object or a pre-serialized string.
   */
  policy: SecurityPolicyDocument;
  /**
   * A human-readable description of the policy.
   */
  description?: string;
}

export interface AccessPolicy extends Resource<
  "AWS.OpenSearchServerless.AccessPolicy",
  AccessPolicyProps,
  {
    /**
     * Name of the access policy.
     */
    policyName: string;
    /**
     * Policy type (`data`).
     */
    type: string;
    /**
     * Version of the policy, used for optimistic-concurrency updates.
     */
    policyVersion: string;
    /**
     * Description of the access policy.
     */
    description?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon OpenSearch Serverless data access policy. Data access policies
 * grant IAM principals fine-grained permissions on collections and their
 * indexes (create/read/write/delete documents, create indexes, etc.) — they
 * are the data-plane authorization layer that complements the network and
 * encryption {@link SecurityPolicy | security policies}.
 *
 * A Bedrock Knowledge Base backed by an OpenSearch Serverless collection
 * requires a data access policy granting the Knowledge Base's service role
 * `aoss:APIAccessAll` on the collection and its indexes.
 *
 * @resource
 * @section Creating Access Policies
 * @example Grant a Role Full Data Access
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const access = yield* AWS.OpenSearchServerless.AccessPolicy("Access", {
 *   policyName: "my-collection-access",
 *   policy: [
 *     {
 *       Rules: [
 *         {
 *           ResourceType: "collection",
 *           Resource: ["collection/my-collection"],
 *           Permission: ["aoss:*"],
 *         },
 *         {
 *           ResourceType: "index",
 *           Resource: ["index/my-collection/*"],
 *           Permission: ["aoss:*"],
 *         },
 *       ],
 *       Principal: ["arn:aws:iam::123456789012:role/my-role"],
 *     },
 *   ],
 * });
 * ```
 */
export const AccessPolicy = Resource<AccessPolicy>(
  "AWS.OpenSearchServerless.AccessPolicy",
);

// OpenSearch Serverless only defines the "data" access-policy type.
const ACCESS_POLICY_TYPE = "data";

export const AccessPolicyProvider = () =>
  Provider.effect(
    AccessPolicy,
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

      const toAttributes = (detail: aoss.AccessPolicyDetail) => ({
        policyName: detail.name!,
        type: detail.type!,
        policyVersion: detail.policyVersion!,
        description: detail.description,
      });

      return AccessPolicy.Provider.of({
        stables: ["policyName", "type"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* aoss.listAccessPolicies
              .pages({ type: ACCESS_POLICY_TYPE })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.accessPolicySummaries ?? [])
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
          const found = yield* aoss
            .getAccessPolicy({ type: ACCESS_POLICY_TYPE, name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found?.accessPolicyDetail === undefined) {
            return undefined;
          }
          // Access policies carry no tags, so an existing same-name policy is
          // adopted.
          return toAttributes(found.accessPolicyDetail);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // description/policy fall through to the default update path
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.policyName ?? (yield* createName(id, news));
          const policy = stringifyPolicy(news.policy);

          // 1. OBSERVE
          let detail = yield* aoss
            .getAccessPolicy({ type: ACCESS_POLICY_TYPE, name })
            .pipe(
              Effect.map((r) => r.accessPolicyDetail),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // 2. ENSURE
          if (detail === undefined) {
            detail = yield* aoss
              .createAccessPolicy({
                type: ACCESS_POLICY_TYPE,
                name,
                policy,
                description: news.description,
              })
              .pipe(
                Effect.map((r) => r.accessPolicyDetail),
                Effect.catchTag("ConflictException", () =>
                  aoss
                    .getAccessPolicy({ type: ACCESS_POLICY_TYPE, name })
                    .pipe(Effect.map((r) => r.accessPolicyDetail)),
                ),
              );
          } else {
            // 3. SYNC
            const policyDrift =
              canonicalizePolicy(detail.policy) !== canonicalizePolicy(policy);
            const descriptionDrift =
              news.description !== undefined &&
              news.description !== detail.description;
            if (policyDrift || descriptionDrift) {
              detail = yield* aoss
                .updateAccessPolicy({
                  type: ACCESS_POLICY_TYPE,
                  name,
                  policyVersion: detail.policyVersion!,
                  policy: policyDrift ? policy : undefined,
                  description: descriptionDrift ? news.description : undefined,
                })
                .pipe(Effect.map((r) => r.accessPolicyDetail));
            }
          }

          if (detail?.name === undefined) {
            return yield* Effect.fail(
              new aoss.ResourceNotFoundException({
                message: `access policy ${name} not visible after reconcile`,
              }),
            );
          }
          yield* session.note(name);
          return toAttributes(detail);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            aoss.deleteAccessPolicy({
              type: ACCESS_POLICY_TYPE,
              name: output.policyName,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
