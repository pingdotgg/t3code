import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const EmailSecurityTrustedDomainTypeId =
  "Cloudflare.Email.TrustedDomain" as const;
type EmailSecurityTrustedDomainTypeId = typeof EmailSecurityTrustedDomainTypeId;

export interface TrustedDomainProps {
  /**
   * The domain (or regular expression) to trust. The pattern is the
   * entry's identity for cold-state recovery — a pre-existing entry with
   * the same pattern is reported as unowned and only taken over when
   * adoption is enabled.
   */
  pattern: string;
  /**
   * Prevents recently registered domains from triggering a Suspicious or
   * Malicious disposition.
   * @default false
   */
  isRecent?: boolean;
  /**
   * For partner or other approved domains with similar spelling to your
   * connected domains — prevents the listed domains from triggering a
   * Spoof disposition.
   * @default false
   */
  isSimilarity?: boolean;
  /**
   * Whether `pattern` is a regular expression.
   * @default false
   */
  isRegex?: boolean;
  /**
   * Free-form notes about the trusted domain.
   */
  comments?: string;
}

export interface TrustedDomainAttributes {
  /** Cloudflare-assigned trusted domain identifier. */
  trustedDomainId: string;
  /** The account the entry belongs to. */
  accountId: string;
  /** The trusted domain pattern. */
  pattern: string;
  /** Whether recently registered domain protection is disabled. */
  isRecent: boolean;
  /** Whether lookalike/partner domain Spoof protection is disabled. */
  isSimilarity: boolean;
  /** Whether the pattern is a regular expression. */
  isRegex: boolean;
  /** Free-form notes about the entry, if set. */
  comments: string | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-modified timestamp, if the entry has been modified. */
  modifiedAt: string | undefined;
}

export type TrustedDomain = Resource<
  EmailSecurityTrustedDomainTypeId,
  TrustedDomainProps,
  TrustedDomainAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Email Security (Area 1) trusted domain — exempts a domain
 * from recently-registered and lookalike (similarity) detections.
 *
 * All fields are mutable in place. Requires the Email Security enterprise
 * add-on; accounts without the entitlement receive the typed
 * `EmailSecurityNotEntitled` error.
 * @resource
 * @product Email Security
 * @category Email
 * @section Trusting Domains
 * @example Trust a partner domain with similar spelling
 * ```typescript
 * yield* Cloudflare.Email.TrustedDomain("PartnerLookalike", {
 *   pattern: "examp1e-partner.com",
 *   isSimilarity: true,
 *   comments: "legitimate partner domain",
 * });
 * ```
 *
 * @example Trust a recently registered domain
 * ```typescript
 * yield* Cloudflare.Email.TrustedDomain("NewSubsidiary", {
 *   pattern: "brand-new-subsidiary.example",
 *   isRecent: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/email-security/
 */
export const TrustedDomain = Resource<TrustedDomain>(
  EmailSecurityTrustedDomainTypeId,
  { aliases: ["Cloudflare.EmailSecurity.TrustedDomain"] },
);

/**
 * Returns true if the given value is an TrustedDomain resource.
 */
export const isTrustedDomain = (value: unknown): value is TrustedDomain =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === EmailSecurityTrustedDomainTypeId;

export const TrustedDomainProvider = () =>
  Provider.succeed(TrustedDomain, {
    stables: ["trustedDomainId", "accountId", "createdAt"],

    // Account-scoped collection. Exhaustively paginate the account's trusted
    // domains and hydrate each into the `read` Attributes shape. Accounts
    // without the Email Security add-on surface the typed
    // `EmailSecurityNotEntitled` error — treat that as an empty enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* emailSecurity.listSettingTrustedDomains
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((entry) =>
                toAttributes(entry, accountId),
              ),
            ),
          ),
          Effect.catchTag("EmailSecurityNotEntitled", () =>
            Effect.succeed([] as TrustedDomainAttributes[]),
          ),
        );
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted entry id.
      if (output?.trustedDomainId) {
        const observed = yield* getTrustedDomain(acct, output.trustedDomainId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold lookup: recover by pattern; matches are reported as `Unowned`
      // so takeover is gated behind the adopt policy.
      const pattern = output?.pattern ?? olds?.pattern;
      if (pattern !== undefined) {
        const observed = yield* findByPattern(acct, pattern);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — id hint first, then pattern scan.
      let observed = output?.trustedDomainId
        ? yield* getTrustedDomain(accountId, output.trustedDomainId)
        : undefined;
      if (!observed) {
        observed = yield* findByPattern(accountId, news.pattern);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* emailSecurity.createSettingTrustedDomain({
          accountId,
          pattern: news.pattern,
          isRecent: news.isRecent ?? false,
          isSimilarity: news.isSimilarity ?? false,
          isRegex: news.isRegex ?? false,
          comments: news.comments,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — patch only on a delta.
      const dirty =
        (observed.pattern ?? "") !== news.pattern ||
        (observed.isRecent ?? false) !== (news.isRecent ?? false) ||
        (observed.isSimilarity ?? false) !== (news.isSimilarity ?? false) ||
        (observed.isRegex ?? false) !== (news.isRegex ?? false) ||
        (news.comments !== undefined &&
          (observed.comments ?? "") !== news.comments);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const patched = yield* emailSecurity.patchSettingTrustedDomain({
        accountId,
        trustedDomainId: observed.id ?? "",
        pattern: news.pattern,
        isRecent: news.isRecent ?? false,
        isSimilarity: news.isSimilarity ?? false,
        isRegex: news.isRegex ?? false,
        comments: news.comments,
      });
      return toAttributes(patched, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* emailSecurity
        .deleteSettingTrustedDomain({
          accountId: output.accountId,
          trustedDomainId: output.trustedDomainId,
        })
        .pipe(Effect.catchTag("TrustedDomainNotFound", () => Effect.void));
    }),
  });

type ObservedTrustedDomain = emailSecurity.GetSettingTrustedDomainResponse;

/**
 * Read a trusted domain by id, mapping "gone" (`TrustedDomainNotFound`,
 * HTTP 404) to `undefined`.
 */
const getTrustedDomain = (accountId: string, trustedDomainId: string) =>
  emailSecurity.getSettingTrustedDomain({ accountId, trustedDomainId }).pipe(
    Effect.map((entry): ObservedTrustedDomain | undefined => entry),
    Effect.catchTag("TrustedDomainNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a trusted domain by exact pattern. The `pattern` query filter is a
 * server-side hint; the exact match is re-checked client-side. Picks the
 * oldest match for determinism.
 */
const findByPattern = (accountId: string, pattern: string) =>
  emailSecurity.listSettingTrustedDomains.items({ accountId, pattern }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter((entry) => entry.pattern === pattern)
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
        .at(0),
    ),
  );

const toAttributes = (
  entry:
    | ObservedTrustedDomain
    | emailSecurity.CreateSettingTrustedDomainResponse
    | emailSecurity.PatchSettingTrustedDomainResponse
    | emailSecurity.ListSettingTrustedDomainsResponse["result"][number],
  accountId: string,
): TrustedDomainAttributes => ({
  trustedDomainId: entry.id ?? "",
  accountId,
  pattern: entry.pattern ?? "",
  isRecent: entry.isRecent ?? false,
  isSimilarity: entry.isSimilarity ?? false,
  isRegex: entry.isRegex ?? false,
  comments: entry.comments ?? undefined,
  createdAt: entry.createdAt ?? "",
  modifiedAt: entry.modifiedAt ?? undefined,
});
