import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const EmailSecurityAllowPolicyTypeId = "Cloudflare.Email.AllowPolicy" as const;
type EmailSecurityAllowPolicyTypeId = typeof EmailSecurityAllowPolicyTypeId;

/**
 * Type of pattern matching for Email Security sender/recipient patterns.
 * `UNKNOWN` is deprecated and rejected on create/update, so it is not
 * accepted as an input.
 */
export type PatternType = "EMAIL" | "DOMAIN" | "IP";

export interface AllowPolicyProps {
  /**
   * The email address, domain, IP, or regular expression to match.
   * The pattern is the policy's identity for cold-state recovery — a
   * pre-existing policy with the same pattern is reported as unowned and
   * only taken over when adoption is enabled.
   */
  pattern: string;
  /**
   * Type of pattern matching.
   */
  patternType: PatternType;
  /**
   * Whether `pattern` is a regular expression.
   * @default false
   */
  isRegex?: boolean;
  /**
   * Messages from this sender are exempted from Spam, Spoof, and Bulk
   * dispositions. Does not exempt Malicious or Suspicious dispositions.
   * @default false
   */
  isAcceptableSender?: boolean;
  /**
   * Messages to this recipient bypass all detections.
   * @default false
   */
  isExemptRecipient?: boolean;
  /**
   * Messages from this sender bypass all detections and link following.
   * @default false
   */
  isTrustedSender?: boolean;
  /**
   * Enforce DMARC, SPF, or DKIM authentication — when on, Email Security
   * only honors the policy when the message passes authentication.
   * @default true
   */
  verifySender?: boolean;
  /**
   * Free-form notes about the policy.
   */
  comments?: string;
}

export interface AllowPolicyAttributes {
  /** Cloudflare-assigned allow policy identifier. */
  policyId: string;
  /** The account the policy belongs to. */
  accountId: string;
  /** The matched pattern. */
  pattern: string;
  /** Type of pattern matching. */
  patternType: PatternType;
  /** Whether the pattern is a regular expression. */
  isRegex: boolean;
  /** Whether the sender is exempted from Spam/Spoof/Bulk dispositions. */
  isAcceptableSender: boolean;
  /** Whether messages to the recipient bypass all detections. */
  isExemptRecipient: boolean;
  /** Whether the sender bypasses all detections and link following. */
  isTrustedSender: boolean;
  /** Whether sender authentication (SPF/DKIM/DMARC) is enforced. */
  verifySender: boolean;
  /** Free-form notes about the policy, if set. */
  comments: string | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-modified timestamp, if the policy has been modified. */
  modifiedAt: string | undefined;
}

export type AllowPolicy = Resource<
  EmailSecurityAllowPolicyTypeId,
  AllowPolicyProps,
  AllowPolicyAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Email Security (Area 1) allow policy — exempts messages
 * matching a sender/recipient pattern from detections.
 *
 * All fields are mutable in place. Requires the Email Security enterprise
 * add-on; accounts without the entitlement receive the typed
 * `EmailSecurityNotEntitled` error.
 * @resource
 * @product Email Security
 * @category Email
 * @section Creating an Allow Policy
 * @example Acceptable sender by email address
 * ```typescript
 * yield* Cloudflare.Email.AllowPolicy("NewsletterSender", {
 *   pattern: "news@partner.example.com",
 *   patternType: "EMAIL",
 *   isAcceptableSender: true,
 * });
 * ```
 *
 * @example Trusted sender domain (bypasses all detections)
 * ```typescript
 * yield* Cloudflare.Email.AllowPolicy("TrustedPartner", {
 *   pattern: "partner.example.com",
 *   patternType: "DOMAIN",
 *   isTrustedSender: true,
 *   comments: "contractually trusted partner",
 * });
 * ```
 *
 * @example Exempt recipient
 * ```typescript
 * // Messages delivered to the abuse mailbox must never be filtered.
 * yield* Cloudflare.Email.AllowPolicy("AbuseMailbox", {
 *   pattern: "abuse@example.com",
 *   patternType: "EMAIL",
 *   isExemptRecipient: true,
 *   verifySender: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/email-security/
 */
export const AllowPolicy = Resource<AllowPolicy>(
  EmailSecurityAllowPolicyTypeId,
  { aliases: ["Cloudflare.EmailSecurity.AllowPolicy"] },
);

/**
 * Returns true if the given value is an AllowPolicy resource.
 */
export const isAllowPolicy = (value: unknown): value is AllowPolicy =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === EmailSecurityAllowPolicyTypeId;

export const AllowPolicyProvider = () =>
  Provider.succeed(AllowPolicy, {
    stables: ["policyId", "accountId", "createdAt"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* emailSecurity.listSettingAllowPolicies
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((policy) =>
                toAttributes(policy, accountId),
              ),
            ),
          ),
          // Email Security is a paid add-on; accounts without the
          // entitlement can't enumerate policies — treat as empty.
          Effect.catchTag("EmailSecurityNotEntitled", () =>
            Effect.succeed([] as AllowPolicyAttributes[]),
          ),
        );
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted policy id.
      if (output?.policyId) {
        const observed = yield* getPolicy(acct, output.policyId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold lookup: recover by pattern. Allow policies carry no ownership
      // markers, so a match is reported as `Unowned` and only taken over
      // when adoption is enabled.
      const pattern = output?.pattern ?? olds?.pattern;
      if (pattern !== undefined) {
        const observed = yield* findByPattern(acct, pattern);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const desired = withDefaults(news);

      // 1. Observe — the id on `output` is a hint, not a guarantee; a
      //    missing policy falls through to the pattern scan and create.
      let observed = output?.policyId
        ? yield* getPolicy(accountId, output.policyId)
        : undefined;
      if (!observed) {
        observed = yield* findByPattern(accountId, news.pattern);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* emailSecurity.createSettingAllowPolicy({
          accountId,
          ...desired,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — diff observed cloud state against desired and patch only
      //    on a delta.
      const dirty =
        (observed.pattern ?? "") !== desired.pattern ||
        (observed.patternType ?? "") !== desired.patternType ||
        (observed.isRegex ?? false) !== desired.isRegex ||
        (observed.isAcceptableSender ?? false) !== desired.isAcceptableSender ||
        (observed.isExemptRecipient ?? false) !== desired.isExemptRecipient ||
        (observed.isTrustedSender ?? false) !== desired.isTrustedSender ||
        (observed.verifySender ?? false) !== desired.verifySender ||
        (news.comments !== undefined &&
          (observed.comments ?? "") !== news.comments);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const patched = yield* emailSecurity.patchSettingAllowPolicy({
        accountId,
        policyId: observed.id,
        ...desired,
      });
      return toAttributes(patched, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* emailSecurity
        .deleteSettingAllowPolicy({
          accountId: output.accountId,
          policyId: output.policyId,
        })
        .pipe(Effect.catchTag("AllowPolicyNotFound", () => Effect.void));
    }),
  });

type ObservedAllowPolicy = emailSecurity.GetSettingAllowPolicyResponse;

/**
 * Read an allow policy by id, mapping "gone" (`AllowPolicyNotFound`,
 * HTTP 404) to `undefined`.
 */
const getPolicy = (accountId: string, policyId: string) =>
  emailSecurity.getSettingAllowPolicy({ accountId, policyId }).pipe(
    Effect.map((policy): ObservedAllowPolicy | undefined => policy),
    Effect.catchTag("AllowPolicyNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find an allow policy by exact pattern. The `pattern` query filter is a
 * server-side hint; the exact match is re-checked client-side. Picks the
 * oldest match for determinism.
 */
const findByPattern = (accountId: string, pattern: string) =>
  emailSecurity.listSettingAllowPolicies.items({ accountId, pattern }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter((p) => p.pattern === pattern)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(0),
    ),
  );

const withDefaults = (news: AllowPolicyProps) => ({
  pattern: news.pattern,
  patternType: news.patternType,
  isRegex: news.isRegex ?? false,
  isAcceptableSender: news.isAcceptableSender ?? false,
  isExemptRecipient: news.isExemptRecipient ?? false,
  isTrustedSender: news.isTrustedSender ?? false,
  verifySender: news.verifySender ?? true,
  comments: news.comments,
});

const toAttributes = (
  policy:
    | ObservedAllowPolicy
    | emailSecurity.CreateSettingAllowPolicyResponse
    | emailSecurity.PatchSettingAllowPolicyResponse,
  accountId: string,
): AllowPolicyAttributes => ({
  policyId: policy.id,
  accountId,
  pattern: policy.pattern ?? "",
  // UNKNOWN can only appear on legacy entries; new policies always echo
  // the type they were created with.
  patternType: (policy.patternType ?? "EMAIL") as PatternType,
  isRegex: policy.isRegex ?? false,
  isAcceptableSender: policy.isAcceptableSender ?? false,
  isExemptRecipient: policy.isExemptRecipient ?? false,
  isTrustedSender: policy.isTrustedSender ?? false,
  verifySender: policy.verifySender ?? false,
  comments: policy.comments ?? undefined,
  createdAt: policy.createdAt,
  modifiedAt: policy.modifiedAt ?? undefined,
});
