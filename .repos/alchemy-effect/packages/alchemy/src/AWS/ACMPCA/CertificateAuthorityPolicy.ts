import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface CertificateAuthorityPolicyProps {
  /**
   * The ARN of the private CA the resource-based policy is attached to.
   * Changing this replaces the policy.
   */
  certificateAuthorityArn: string;
  /**
   * The resource-based permission policy, either as a structured
   * {@link PolicyDocument} or a raw JSON string (escape hatch). The policy
   * grants cross-account access on the CA to an Amazon Web Services
   * account, organization, or organizational unit — a policy that would
   * lock the CA owner out is rejected by AWS with the typed
   * `LockoutPreventedException`.
   */
  policy: PolicyDocument | string;
}

export interface CertificateAuthorityPolicy extends Resource<
  "AWS.ACMPCA.CertificateAuthorityPolicy",
  CertificateAuthorityPolicyProps,
  {
    /** The ARN of the CA the policy is attached to. */
    certificateAuthorityArn: string;
    /** The attached policy document as a JSON string. */
    policy: string;
  },
  never,
  Providers
> {}

/**
 * A resource-based policy attached to a private CA, granting cross-account
 * access — e.g. allowing a Certificate Manager (ACM) user in another
 * account to issue and renew certificates signed by this CA. This is the
 * policy Amazon Web Services Resource Access Manager (RAM) manages when a
 * CA is shared; attach it directly for fine-grained control.
 *
 * @resource
 * @section Attaching a CA Policy
 * @example Allow Another Account to Issue Certificates
 * ```typescript
 * import * as ACMPCA from "alchemy/AWS/ACMPCA";
 *
 * const policy = yield* ACMPCA.CertificateAuthorityPolicy("CrossAccount", {
 *   certificateAuthorityArn: ca.certificateAuthorityArn,
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::123456789012:root" },
 *         Action: [
 *           "acm-pca:DescribeCertificateAuthority",
 *           "acm-pca:GetCertificate",
 *           "acm-pca:GetCertificateAuthorityCertificate",
 *           "acm-pca:ListPermissions",
 *           "acm-pca:IssueCertificate",
 *           "acm-pca:RevokeCertificate",
 *         ],
 *         Resource: ca.certificateAuthorityArn,
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const CertificateAuthorityPolicy = Resource<CertificateAuthorityPolicy>(
  "AWS.ACMPCA.CertificateAuthorityPolicy",
);

export const CertificateAuthorityPolicyProvider = () =>
  Provider.effect(
    CertificateAuthorityPolicy,
    Effect.gen(function* () {
      // A CA without a policy and a missing/deleted CA both answer
      // getPolicy with ResourceNotFoundException — either way there is no
      // policy to observe.
      const observe = (certificateAuthorityArn: string) =>
        acmpca.getPolicy({ ResourceArn: certificateAuthorityArn }).pipe(
          Effect.map((response) => response.Policy),
          Effect.catchTag(
            ["ResourceNotFoundException", "InvalidStateException"],
            () => Effect.succeed(undefined),
          ),
        );

      const toDesired = (policy: PolicyDocument | string) =>
        typeof policy === "string" ? policy : stringifyPolicyDocument(policy);

      return {
        stables: ["certificateAuthorityArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (news.certificateAuthorityArn !== olds.certificateAuthorityArn) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const certificateAuthorityArn =
            output?.certificateAuthorityArn ?? olds?.certificateAuthorityArn;
          if (certificateAuthorityArn === undefined) return undefined;
          const observed = yield* observe(certificateAuthorityArn);
          if (observed === undefined) return undefined;
          return { certificateAuthorityArn, policy: observed };
        }),
        list: () =>
          Effect.gen(function* () {
            // Policies hang off CAs: enumerate every non-deleted CA and
            // collect the ones that actually carry a policy.
            const cas = yield* acmpca.listCertificateAuthorities.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk)
                  .filter(
                    (ca) => ca.Arn !== undefined && ca.Status !== "DELETED",
                  )
                  .map((ca) => ca.Arn!),
              ),
            );
            const policies = yield* Effect.forEach(
              cas,
              (arn) =>
                observe(arn).pipe(
                  Effect.map((policy) =>
                    policy === undefined
                      ? []
                      : [{ certificateAuthorityArn: arn, policy }],
                  ),
                ),
              { concurrency: 5 },
            );
            return policies.flat();
          }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const certificateAuthorityArn = news.certificateAuthorityArn;
          const desired = toDesired(news.policy);

          // OBSERVE — putPolicy is an upsert; compare the canonicalized
          // live document against the canonicalized desired one so a
          // re-deploy of an equivalent policy (key order, whitespace) skips
          // the API call entirely.
          const observed = yield* observe(certificateAuthorityArn);
          if (
            observed === undefined ||
            normalizePolicyDocument(observed) !==
              normalizePolicyDocument(desired)
          ) {
            yield* acmpca.putPolicy({
              ResourceArn: certificateAuthorityArn,
              Policy: desired,
            });
          }

          yield* session.note(certificateAuthorityArn);
          return { certificateAuthorityArn, policy: desired };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* acmpca
            .deletePolicy({ ResourceArn: output.certificateAuthorityArn })
            .pipe(
              // CA already gone, no policy attached, or CA in a state
              // (DELETED) where the policy is no longer addressable — the
              // policy is gone with it.
              Effect.catchTag(
                ["ResourceNotFoundException", "InvalidStateException"],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
