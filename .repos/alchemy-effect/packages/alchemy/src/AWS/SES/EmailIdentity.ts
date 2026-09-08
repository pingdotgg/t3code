import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * The length of the RSA key pair SES generates for Easy DKIM signing.
 */
export type DkimSigningKeyLength = "RSA_1024_BIT" | "RSA_2048_BIT";

export interface EmailIdentityProps {
  /**
   * The email address or domain to verify with SES, e.g. `hello@example.com`
   * or `example.com`. Changing this replaces the identity.
   *
   * - **Email address** — SES sends a verification email to the address; the
   *   identity stays `PENDING` until the link is clicked.
   * - **Domain** — SES generates Easy DKIM tokens (see the `dkimTokens`
   *   attribute) that must be published as CNAME records; the identity stays
   *   `PENDING` until the DNS records propagate.
   */
  emailIdentity: string;
  /**
   * The configuration set to apply by default to messages sent from this
   * identity. The configuration set must exist in the same region.
   */
  configurationSetName?: string;
  /**
   * The length of the private key SES uses for Easy DKIM signing. Only
   * applies to domain identities.
   * @default "RSA_2048_BIT"
   */
  dkimSigningKeyLength?: DkimSigningKeyLength;
  /**
   * Whether Easy DKIM signing is enabled for the identity. Leave undefined to
   * keep SES's current setting.
   */
  dkimSigningEnabled?: boolean;
  /**
   * Whether SES forwards bounce and complaint feedback to the identity's email
   * address. Leave undefined to keep SES's current setting.
   * @default true
   */
  feedbackForwardingEnabled?: boolean;
  /**
   * A custom MAIL FROM domain (a verified subdomain of the identity) SES uses
   * in the message envelope. Publish the required MX and SPF records for the
   * subdomain to complete setup. Leave undefined to keep SES's current
   * setting — there is no removal path once one is configured.
   */
  mailFromDomain?: string;
  /**
   * What SES does when the custom MAIL FROM domain's MX record can't be read:
   * fall back to the SES default (`USE_DEFAULT_VALUE`) or reject the message
   * (`REJECT_MESSAGE`).
   * @default "USE_DEFAULT_VALUE"
   */
  mailFromBehaviorOnMxFailure?: sesv2.BehaviorOnMxFailure;
  /**
   * Tags to apply to the identity. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface EmailIdentity extends Resource<
  "AWS.SES.EmailIdentity",
  EmailIdentityProps,
  {
    emailIdentity: string;
    identityArn: string;
    identityType: sesv2.IdentityType;
    verifiedForSendingStatus: boolean;
    verificationStatus: sesv2.VerificationStatus | undefined;
    /**
     * The Easy DKIM CNAME tokens for a domain identity. Publish each token as
     * `{token}._domainkey.{domain} CNAME {token}.dkim.amazonses.com` to
     * complete verification. Empty for email-address identities.
     */
    dkimTokens: string[];
    dkimStatus: sesv2.DkimStatus | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 email identity — a verified email address or domain that
 * you send email from.
 *
 * Creating the identity starts verification: email-address identities receive
 * a verification email, and domain identities get Easy DKIM tokens (exposed
 * as the `dkimTokens` attribute) to publish as CNAME records. The identity
 * is usable for sending once `verificationStatus` is `SUCCESS`.
 * ### Creating Identities
 * **Example:** Domain Identity
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 * });
 * // publish identity.dkimTokens as CNAME records to verify
 * ```
 *
 * **Example:** Email Address Identity
 * ```typescript
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "hello@example.com",
 * });
 * // SES emails hello@example.com a verification link
 * ```
 *
 * ### Configuration Set Association
 * **Example:** Apply a Configuration Set by Default
 * ```typescript
 * const configSet = yield* SES.ConfigurationSet("Tracking", {});
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 *   configurationSetName: configSet.configurationSetName,
 * });
 * ```
 *
 * ### DKIM and Feedback
 * **Example:** Turn Easy DKIM Signing Off
 * ```typescript
 * // Omit the prop entirely to leave SES's current setting alone.
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 *   dkimSigningEnabled: false,
 * });
 * ```
 *
 * **Example:** Stop Forwarding Bounces and Complaints by Email
 * ```typescript
 * // Turn this off once a configuration set event destination is handling
 * // bounces and complaints, so they stop arriving as mail.
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 *   feedbackForwardingEnabled: false,
 * });
 * ```
 *
 * ### Custom MAIL FROM Domain
 * **Example:** Send with Your Own Envelope Domain
 * ```typescript
 * // mailFromDomain must be a subdomain of the identity, and needs MX and
 * // SPF records published before SES will use it.
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 *   mailFromDomain: "bounce.mail.example.com",
 *   // Reject rather than silently falling back to the SES default when the
 *   // MX record cannot be read.
 *   mailFromBehaviorOnMxFailure: "REJECT_MESSAGE",
 * });
 * ```
 *
 * ### Sending Email at Runtime
 * **Example:** Send Through the Identity from a Lambda Function
 * ```typescript
 * // init
 * const sendEmail = yield* SES.SendEmail(identity);
 *
 * // runtime
 * const result = yield* sendEmail({
 *   FromEmailAddress: "hello@mail.example.com",
 *   Destination: { ToAddresses: ["customer@example.com"] },
 *   Content: {
 *     Simple: {
 *       Subject: { Data: "Welcome!" },
 *       Body: { Text: { Data: "Hello from SES." } },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const EmailIdentity = Resource<EmailIdentity>("AWS.SES.EmailIdentity");

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

const identityArnOf = (region: string, accountId: string, name: string) =>
  `arn:aws:ses:${region}:${accountId}:identity/${name}`;

const toAttributes = (
  name: string,
  identityArn: string,
  identity: sesv2.GetEmailIdentityResponse,
) => ({
  emailIdentity: name,
  identityArn,
  identityType: identity.IdentityType ?? "DOMAIN",
  verifiedForSendingStatus: identity.VerifiedForSendingStatus ?? false,
  verificationStatus: identity.VerificationStatus,
  dkimTokens: [...(identity.DkimAttributes?.Tokens ?? [])],
  dkimStatus: identity.DkimAttributes?.Status,
});

export const EmailIdentityProvider = () =>
  Provider.effect(
    EmailIdentity,
    Effect.gen(function* () {
      const getIdentity = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getEmailIdentity({ EmailIdentity: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return EmailIdentity.Provider.of({
        stables: ["emailIdentity", "identityArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* sesv2.listEmailIdentities
              .pages({})
              .pipe(Stream.runCollect);
            const infos = Array.from(pages).flatMap(
              (page) => page.EmailIdentities ?? [],
            );
            const attrs = yield* Effect.forEach(
              infos.filter(
                (info): info is typeof info & { IdentityName: string } =>
                  info.IdentityName != null,
              ),
              (info) =>
                Effect.gen(function* () {
                  const identity = yield* getIdentity(info.IdentityName);
                  return identity === undefined
                    ? undefined
                    : toAttributes(
                        info.IdentityName,
                        identityArnOf(region, accountId, info.IdentityName),
                        identity,
                      );
                }),
              { concurrency: 2 },
            );
            return attrs.filter((a) => a !== undefined);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.emailIdentity ?? olds?.emailIdentity;
          if (name === undefined) return undefined;
          const found = yield* getIdentity(name);
          if (!found) return undefined;
          const attrs = toAttributes(
            name,
            identityArnOf(region, accountId, name),
            found,
          );
          const tags = toTagRecord(found.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.emailIdentity !== undefined &&
            news?.emailIdentity !== undefined &&
            olds.emailIdentity !== news.emailIdentity
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.emailIdentity ?? news.emailIdentity;
          const identityArn = identityArnOf(region, accountId, name);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; `output` is only a
          //    cache of the identity name.
          let observed = yield* getIdentity(name);

          // 2. ENSURE — create if missing; AlreadyExists is a race, not a
          //    failure. Creation kicks off verification (email or DKIM DNS).
          if (observed === undefined) {
            yield* sesv2
              .createEmailIdentity({
                EmailIdentity: name,
                ConfigurationSetName: news.configurationSetName,
                DkimSigningAttributes:
                  news.dkimSigningKeyLength !== undefined
                    ? { NextSigningKeyLength: news.dkimSigningKeyLength }
                    : undefined,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
            observed = yield* sesv2.getEmailIdentity({ EmailIdentity: name });
          }

          // 3. SYNC configuration-set association — compare observed against
          //    desired; passing undefined removes the association.
          if (observed.ConfigurationSetName !== news.configurationSetName) {
            yield* sesv2.putEmailIdentityConfigurationSetAttributes({
              EmailIdentity: name,
              ConfigurationSetName: news.configurationSetName,
            });
          }

          // 3b. SYNC Easy DKIM signing key length (domain identities). Only
          //     applied when explicitly requested and observably different —
          //     rotating the key regenerates the DKIM tokens.
          if (
            news.dkimSigningKeyLength !== undefined &&
            observed.DkimAttributes?.NextSigningKeyLength !== undefined &&
            observed.DkimAttributes.NextSigningKeyLength !==
              news.dkimSigningKeyLength
          ) {
            yield* sesv2.putEmailIdentityDkimSigningAttributes({
              EmailIdentity: name,
              SigningAttributesOrigin: "AWS_SES",
              SigningAttributes: {
                NextSigningKeyLength: news.dkimSigningKeyLength,
              },
            });
          }

          // 3c. SYNC Easy DKIM signing enablement — only applied when
          //     explicitly requested and observably different.
          if (
            news.dkimSigningEnabled !== undefined &&
            (observed.DkimAttributes?.SigningEnabled ?? false) !==
              news.dkimSigningEnabled
          ) {
            yield* sesv2.putEmailIdentityDkimAttributes({
              EmailIdentity: name,
              SigningEnabled: news.dkimSigningEnabled,
            });
          }

          // 3d. SYNC feedback forwarding — only applied when explicitly
          //     requested and observably different (SES defaults it to on).
          if (
            news.feedbackForwardingEnabled !== undefined &&
            (observed.FeedbackForwardingStatus ?? true) !==
              news.feedbackForwardingEnabled
          ) {
            yield* sesv2.putEmailIdentityFeedbackAttributes({
              EmailIdentity: name,
              EmailForwardingEnabled: news.feedbackForwardingEnabled,
            });
          }

          // 3e. SYNC custom MAIL FROM domain — only applied when explicitly
          //     requested and observably different.
          if (
            news.mailFromDomain !== undefined &&
            (observed.MailFromAttributes?.MailFromDomain !==
              news.mailFromDomain ||
              (news.mailFromBehaviorOnMxFailure !== undefined &&
                observed.MailFromAttributes?.BehaviorOnMxFailure !==
                  news.mailFromBehaviorOnMxFailure))
          ) {
            yield* sesv2.putEmailIdentityMailFromAttributes({
              EmailIdentity: name,
              MailFromDomain: news.mailFromDomain,
              BehaviorOnMxFailure: news.mailFromBehaviorOnMxFailure,
            });
          }

          // 3f. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = toTagRecord(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sesv2.tagResource({
              ResourceArn: identityArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* sesv2.untagResource({
              ResourceArn: identityArn,
              TagKeys: removed,
            });
          }

          // 4. RETURN — re-read so DKIM tokens/status reflect any sync above.
          const final = yield* sesv2.getEmailIdentity({ EmailIdentity: name });
          yield* session.note(identityArn);
          return toAttributes(name, identityArn, final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* sesv2
            .deleteEmailIdentity({ EmailIdentity: output.emailIdentity })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
