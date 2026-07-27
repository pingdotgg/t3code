import * as osis from "@distilled.cloud/aws/osis";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ResourcePolicyProps {
  /**
   * ARN of the OSIS resource (pipeline) the policy is attached to. A
   * resource has at most one resource-based policy. Changing the resource
   * replaces the policy.
   */
  resourceArn: string;
  /**
   * The IAM resource-based policy document (JSON) that grants other
   * principals or accounts access to the resource (e.g. `osis:Ingest`,
   * `osis:CreatePipelineEndpoint`). Updated in place.
   */
  policy: string;
}

export interface ResourcePolicy extends Resource<
  "AWS.OSIS.ResourcePolicy",
  ResourcePolicyProps,
  {
    /**
     * ARN of the resource the policy is attached to.
     */
    resourceArn: string;
    /**
     * The attached policy document (JSON).
     */
    policy: string;
  },
  never,
  Providers
> {}

/**
 * The resource-based policy of an Amazon OpenSearch Ingestion (OSIS)
 * pipeline — grants cross-account principals access to the pipeline, e.g.
 * `osis:Ingest` for cross-account ingestion or
 * `osis:CreatePipelineEndpoint` so another account can attach a VPC
 * endpoint. A resource has at most one.
 *
 * @resource
 * @section Creating a Resource Policy
 * @example Allow Another Account to Ingest
 * ```typescript
 * const policy = yield* OSIS.ResourcePolicy("CrossAccountIngest", {
 *   resourceArn: pipeline.pipelineArn,
 *   policy: Output.interpolate`{
 *     "Version": "2012-10-17",
 *     "Statement": [
 *       {
 *         "Effect": "Allow",
 *         "Principal": { "AWS": "arn:aws:iam::123456789012:root" },
 *         "Action": ["osis:Ingest"],
 *         "Resource": "${pipeline.pipelineArn}"
 *       }
 *     ]
 *   }`,
 * });
 * ```
 */
export const ResourcePolicy = Resource<ResourcePolicy>(
  "AWS.OSIS.ResourcePolicy",
);

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

export const ResourcePolicyProvider = () =>
  Provider.effect(
    ResourcePolicy,
    Effect.gen(function* () {
      /**
       * Read the attached policy. OSIS reports "no policy" two ways: a typed
       * `ResourceNotFoundException`, or (observed live) a success response
       * whose `Policy` is the empty document `"{}"` — normalize both to
       * `undefined`.
       */
      const getPolicy = Effect.fn(function* (resourceArn: string) {
        const policy = yield* osis
          .getResourcePolicy({ ResourceArn: resourceArn })
          .pipe(
            Effect.map((response) => response.Policy),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return policy === undefined || canonicalJson(policy) === "{}"
          ? undefined
          : policy;
      });

      return {
        stables: ["resourceArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.resourceArn !== news.resourceArn) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const resourceArn = output?.resourceArn ?? olds?.resourceArn;
          if (!resourceArn) return undefined;
          const policy = yield* getPolicy(resourceArn);
          if (policy === undefined) return undefined;
          // Resource policies are not taggable — ownership is implied by
          // the owned parent pipeline.
          return { resourceArn, policy };
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const resourceArn = news!.resourceArn;

          // 1. Observe — the live policy is authoritative.
          const observed = yield* getPolicy(resourceArn);

          // 2/3. Ensure + sync — `putResourcePolicy` is a true upsert;
          // call it only when the canonical document drifts.
          if (
            observed === undefined ||
            canonicalJson(observed) !== canonicalJson(news!.policy)
          ) {
            yield* osis.putResourcePolicy({
              ResourceArn: resourceArn,
              Policy: news!.policy,
            });
          }

          yield* session.note(resourceArn);
          return { resourceArn, policy: news!.policy };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* osis
            .deleteResourcePolicy({ ResourceArn: output.resourceArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Singleton sub-resource keyed by its parent resource ARN.
        list: () => Effect.succeed([]),
      };
    }),
  );
