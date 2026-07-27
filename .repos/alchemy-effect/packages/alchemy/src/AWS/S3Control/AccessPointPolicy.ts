import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  normalizePolicyDocument,
  type PolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface AccessPointPolicyProps {
  /**
   * Name of the access point the policy is attached to.
   *
   * Changing the access point replaces the policy.
   */
  accessPointName: string;
  /**
   * The resource policy granting access through the access point, as a
   * typed {@link PolicyDocument} or a raw JSON string (escape hatch /
   * adoption). Object-level actions target `${accessPointArn}/object/${key}`.
   */
  policy: PolicyDocument | string;
}

export interface AccessPointPolicy extends Resource<
  "AWS.S3Control.AccessPointPolicy",
  AccessPointPolicyProps,
  {
    /**
     * Name of the access point the policy is attached to.
     */
    accessPointName: string;
  },
  never,
  Providers
> {}

/**
 * The resource policy of an S3 Access Point. Grants principals access to
 * objects through the access point — the delegated replacement for a giant
 * shared bucket policy.
 *
 * Note that the underlying bucket must delegate access control to the access
 * point (or the principals must also be allowed by the bucket policy).
 * @resource
 * @section Attaching a Policy
 * @example Allow a role to read objects through the access point
 * ```typescript
 * import * as S3Control from "alchemy/AWS/S3Control";
 *
 * const accessPoint = yield* S3Control.AccessPoint("data-ap", {
 *   bucket: bucket.bucketName,
 * });
 *
 * yield* S3Control.AccessPointPolicy("data-ap-policy", {
 *   accessPointName: accessPoint.accessPointName,
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: `arn:aws:iam::${accountId}:role/reader` },
 *         Action: ["s3:GetObject"],
 *         Resource: [Output.interpolate`${accessPoint.accessPointArn}/object/*`],
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const AccessPointPolicy = Resource<AccessPointPolicy>(
  "AWS.S3Control.AccessPointPolicy",
);

export const AccessPointPolicyProvider = () =>
  Provider.effect(
    AccessPointPolicy,
    Effect.gen(function* () {
      const observePolicy = (accountId: string, name: string) =>
        s3control
          .getAccessPointPolicy({ AccountId: accountId, Name: name })
          .pipe(
            Effect.map((r) => r.Policy),
            Effect.catchTag(
              ["NoSuchAccessPointPolicy", "NoSuchAccessPoint"],
              () => Effect.succeed(undefined),
            ),
          );

      const desiredPolicy = (props: AccessPointPolicyProps) =>
        typeof props.policy === "string"
          ? props.policy
          : stringifyPolicyDocument(props.policy);

      return AccessPointPolicy.Provider.of({
        stables: ["accessPointName"],
        // Sub-resource keyed by its access point — there is no account-wide
        // enumeration of access point policies, and the policy is deleted
        // with its access point, so nuke discovers it via the parent.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output?.accessPointName ?? olds?.accessPointName;
          if (name === undefined) return undefined;
          const policy = yield* observePolicy(accountId, name);
          if (policy === undefined) return undefined;
          return { accessPointName: name };
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            olds.accessPointName !== news.accessPointName
          ) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update path (policy content)
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = news.accessPointName;

          // 1. OBSERVE — read the policy currently attached in the cloud.
          const observed = yield* observePolicy(accountId, name);

          // 2. SYNC — apply only when the desired document differs after
          // canonicalization (key order / whitespace insensitive), so a
          // re-deploy of an unchanged document is a no-op.
          const desired = desiredPolicy(news);
          if (
            observed === undefined ||
            normalizePolicyDocument(observed) !==
              normalizePolicyDocument(desired)
          ) {
            yield* s3control.putAccessPointPolicy({
              AccountId: accountId,
              Name: name,
              Policy: desired,
            });
          }

          yield* session.note(name);
          return { accessPointName: name };
        }),
        delete: Effect.fn(function* ({ output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* s3control
            .deleteAccessPointPolicy({
              AccountId: accountId,
              Name: output.accessPointName,
            })
            .pipe(
              // Idempotent delete — a policy (or its whole access point)
              // that is already gone is success.
              Effect.catchTag(
                ["NoSuchAccessPointPolicy", "NoSuchAccessPoint"],
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
