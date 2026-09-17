import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
  type PolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface EmailIdentityPolicyProps {
  /**
   * The email address or domain identity the sending-authorization policy is
   * attached to. Typically the `emailIdentity` output of a
   * `SES.EmailIdentity`. Changing it replaces the policy.
   */
  emailIdentity: string;
  /**
   * Name of the policy. May contain letters, numbers, dashes and underscores,
   * up to 64 characters. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * policy.
   */
  policyName?: string;
  /**
   * The IAM policy document that grants sending authorization. Equivalent
   * document representations are ignored when detecting drift.
   */
  policy: PolicyDocument;
}

export interface EmailIdentityPolicy extends Resource<
  "AWS.SES.EmailIdentityPolicy",
  EmailIdentityPolicyProps,
  {
    /** The identity the policy is attached to. */
    emailIdentity: string;
    /** Name of the policy. */
    policyName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 sending-authorization policy attached to an email identity —
 * lets the identity owner authorize other AWS accounts or IAM principals to
 * send email using the identity.
 *
 * SES stores the policy document as JSON; Alchemy serializes the typed IAM
 * policy at the API boundary and compares its normalized content for drift.
 * ### Attaching a Policy
 * **Example:** Authorize Another Account to Send
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 * });
 *
 * const policy = yield* SES.EmailIdentityPolicy("AllowPartner", {
 *   emailIdentity: identity.emailIdentity,
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *         Action: ["ses:SendEmail"],
 *         Resource: identity.identityArn,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Explicit Policy Name
 * ```typescript
 * // Without policyName a deterministic name is derived from app/stage/id.
 * const policy = yield* SES.EmailIdentityPolicy("AllowPartner", {
 *   emailIdentity: identity.emailIdentity,
 *   policyName: "partner-send",
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *         Action: ["ses:SendEmail"],
 *         Resource: identity.identityArn,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Restrict the Grant with Conditions
 * ```typescript
 * const policy = yield* SES.EmailIdentityPolicy("AllowPartnerScoped", {
 *   emailIdentity: identity.emailIdentity,
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *         Action: ["ses:SendEmail", "ses:SendRawEmail"],
 *         Resource: identity.identityArn,
 *         Condition: {
 *           StringEquals: { "ses:FromAddress": "noreply@mail.example.com" },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Several Policies on One Identity
 * ```typescript
 * // Each policy is a separate resource keyed by its own name.
 * for (const partner of ["111122223333", "444455556666"]) {
 *   yield* SES.EmailIdentityPolicy(`Allow${partner}`, {
 *     emailIdentity: identity.emailIdentity,
 *     policyName: `partner-${partner}`,
 *     policy: {
 *       Version: "2012-10-17",
 *       Statement: [
 *         {
 *           Effect: "Allow",
 *           Principal: { AWS: `arn:aws:iam::${partner}:root` },
 *           Action: ["ses:SendEmail"],
 *           Resource: identity.identityArn,
 *         },
 *       ],
 *     },
 *   });
 * }
 * ```
 *
 * @resource
 */
export const EmailIdentityPolicy = Resource<EmailIdentityPolicy>(
  "AWS.SES.EmailIdentityPolicy",
);

export const EmailIdentityPolicyProvider = () =>
  Provider.effect(
    EmailIdentityPolicy,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<EmailIdentityPolicyProps, "policyName">,
      ) {
        return (
          props.policyName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      // Returns the policy-name -> document map for the identity, or undefined
      // when the identity itself no longer exists.
      const getPolicies = Effect.fn(function* (emailIdentity: string) {
        return yield* sesv2
          .getEmailIdentityPolicies({ EmailIdentity: emailIdentity })
          .pipe(
            Effect.map((response) => response.Policies ?? {}),
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return EmailIdentityPolicy.Provider.of({
        // Deleting a policy requires its parent identity to still exist, so
        // the identity must outlive every policy nuke tears down.
        nuke: { dependsOn: ["AWS.SES.EmailIdentity"] },
        stables: ["emailIdentity", "policyName"],

        // Policies are keyed by their parent identity, so enumeration walks
        // every identity and reads its policy map. getPolicies already treats
        // a vanished identity as "no policies".
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listEmailIdentities
            .pages({})
            .pipe(Stream.runCollect);
          const identities = Array.from(pages)
            .flatMap((page) => page.EmailIdentities ?? [])
            .flatMap((info) => (info.IdentityName ? [info.IdentityName] : []));
          const nested = yield* Effect.forEach(
            identities,
            (emailIdentity) =>
              getPolicies(emailIdentity).pipe(
                Effect.map((policies) =>
                  Object.keys(policies ?? {}).map((policyName) => ({
                    emailIdentity,
                    policyName,
                  })),
                ),
              ),
            { concurrency: 2 },
          );
          return nested.flat();
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const emailIdentity = output?.emailIdentity ?? olds?.emailIdentity;
          if (emailIdentity === undefined) return undefined;
          const policyName =
            output?.policyName ?? (yield* createName(id, olds ?? {}));
          const policies = yield* getPolicies(emailIdentity);
          if (policies === undefined || policies[policyName] === undefined) {
            return undefined;
          }
          // Policies carry no tags, so existence at our deterministic name is
          // treated as ownership.
          return { emailIdentity, policyName };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            olds.emailIdentity !== news.emailIdentity
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const emailIdentity = output?.emailIdentity ?? news.emailIdentity;
          const policyName =
            output?.policyName ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative.
          const policies = yield* getPolicies(emailIdentity);
          const existing = policies?.[policyName];
          const desiredPolicy = stringifyPolicyDocument(news.policy);

          if (existing === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge via update.
            yield* sesv2
              .createEmailIdentityPolicy({
                EmailIdentity: emailIdentity,
                PolicyName: policyName,
                Policy: desiredPolicy,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateEmailIdentityPolicy({
                    EmailIdentity: emailIdentity,
                    PolicyName: policyName,
                    Policy: desiredPolicy,
                  }),
                ),
              );
          } else {
            // 3. SYNC — update only when the stored document differs.
            const changed = yield* Effect.sync(
              () =>
                normalizePolicyDocument(existing) !==
                normalizePolicyDocument(news.policy),
            );
            if (changed) {
              yield* sesv2.updateEmailIdentityPolicy({
                EmailIdentity: emailIdentity,
                PolicyName: policyName,
                Policy: desiredPolicy,
              });
            }
          }

          return { emailIdentity, policyName };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteEmailIdentityPolicy succeeds even if the policy is absent; a
          // missing identity means the policy is already gone.
          yield* sesv2
            .deleteEmailIdentityPolicy({
              EmailIdentity: output.emailIdentity,
              PolicyName: output.policyName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
