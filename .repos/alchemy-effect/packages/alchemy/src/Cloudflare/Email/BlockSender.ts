import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { PatternType } from "./AllowPolicy.ts";

const EmailSecurityBlockSenderTypeId = "Cloudflare.Email.BlockSender" as const;
type EmailSecurityBlockSenderTypeId = typeof EmailSecurityBlockSenderTypeId;

export interface BlockSenderProps {
  /**
   * The email address, domain, IP, or regular expression to block.
   * The pattern is the entry's identity for cold-state recovery — a
   * pre-existing entry with the same pattern is reported as unowned and
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
   * Free-form notes about the blocked sender.
   */
  comments?: string;
}

export interface BlockSenderAttributes {
  /** Cloudflare-assigned blocked sender pattern identifier. */
  blockSenderId: string;
  /** The account the entry belongs to. */
  accountId: string;
  /** The blocked pattern. */
  pattern: string;
  /** Type of pattern matching. */
  patternType: PatternType;
  /** Whether the pattern is a regular expression. */
  isRegex: boolean;
  /** Free-form notes about the entry, if set. */
  comments: string | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-modified timestamp, if the entry has been modified. */
  modifiedAt: string | undefined;
}

export type BlockSender = Resource<
  EmailSecurityBlockSenderTypeId,
  BlockSenderProps,
  BlockSenderAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Email Security (Area 1) blocked sender — messages matching
 * the pattern are blocked before delivery.
 *
 * All fields are mutable in place. Requires the Email Security enterprise
 * add-on; accounts without the entitlement receive the typed
 * `EmailSecurityNotEntitled` error.
 * @resource
 * @product Email Security
 * @category Email
 * @section Blocking Senders
 * @example Block a single email address
 * ```typescript
 * yield* Cloudflare.Email.BlockSender("KnownPhisher", {
 *   pattern: "phisher@malicious.example.com",
 *   patternType: "EMAIL",
 *   comments: "reported in incident 1234",
 * });
 * ```
 *
 * @example Block a whole sending domain
 * ```typescript
 * yield* Cloudflare.Email.BlockSender("SpamDomain", {
 *   pattern: "spam-source.example.net",
 *   patternType: "DOMAIN",
 * });
 * ```
 *
 * @example Block by regular expression
 * ```typescript
 * yield* Cloudflare.Email.BlockSender("LookalikeSenders", {
 *   pattern: ".*@examp1e\\.com$",
 *   patternType: "EMAIL",
 *   isRegex: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/email-security/
 */
export const BlockSender = Resource<BlockSender>(
  EmailSecurityBlockSenderTypeId,
  { aliases: ["Cloudflare.EmailSecurity.BlockSender"] },
);

/**
 * Returns true if the given value is an BlockSender resource.
 */
export const isBlockSender = (value: unknown): value is BlockSender =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === EmailSecurityBlockSenderTypeId;

export const BlockSenderProvider = () =>
  Provider.succeed(BlockSender, {
    stables: ["blockSenderId", "accountId", "createdAt"],

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted entry id.
      if (output?.blockSenderId) {
        const observed = yield* getBlockSender(acct, output.blockSenderId);
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
      let observed = output?.blockSenderId
        ? yield* getBlockSender(accountId, output.blockSenderId)
        : undefined;
      if (!observed) {
        observed = yield* findByPattern(accountId, news.pattern);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* emailSecurity.createSettingBlockSender({
          accountId,
          pattern: news.pattern,
          patternType: news.patternType,
          isRegex: news.isRegex ?? false,
          comments: news.comments,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — patch only on a delta.
      const dirty =
        (observed.pattern ?? "") !== news.pattern ||
        (observed.patternType ?? "") !== news.patternType ||
        (observed.isRegex ?? false) !== (news.isRegex ?? false) ||
        (news.comments !== undefined &&
          (observed.comments ?? "") !== news.comments);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const patched = yield* emailSecurity.patchSettingBlockSender({
        accountId,
        patternId: observed.id ?? "",
        pattern: news.pattern,
        patternType: news.patternType,
        isRegex: news.isRegex ?? false,
        comments: news.comments,
      });
      return toAttributes(patched, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* emailSecurity
        .deleteSettingBlockSender({
          accountId: output.accountId,
          patternId: output.blockSenderId,
        })
        .pipe(Effect.catchTag("BlockSenderNotFound", () => Effect.void));
    }),

    // Account collection: enumerate every blocked sender in the ambient
    // account, exhaustively paginating. Each list item already carries the
    // full entry shape, so it hydrates directly into `read`'s Attributes with
    // no per-item follow-up. Email Security is a paid add-on, so accounts
    // without the entitlement (or without permission) have nothing to
    // enumerate and yield an empty array.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* emailSecurity.listSettingBlockSenders
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
          Effect.catchTag("EmailSecurityNotEntitled", () => Effect.succeed([])),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );
    }),
  });

type ObservedBlockSender = emailSecurity.GetSettingBlockSenderResponse;

/**
 * Read a blocked sender by id, mapping "gone" (`BlockSenderNotFound`,
 * HTTP 404) to `undefined`.
 */
const getBlockSender = (accountId: string, patternId: string) =>
  emailSecurity.getSettingBlockSender({ accountId, patternId }).pipe(
    Effect.map((entry): ObservedBlockSender | undefined => entry),
    Effect.catchTag("BlockSenderNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a blocked sender by exact pattern. The `pattern` query filter is a
 * server-side hint; the exact match is re-checked client-side. Picks the
 * oldest match for determinism.
 */
const findByPattern = (accountId: string, pattern: string) =>
  emailSecurity.listSettingBlockSenders.items({ accountId, pattern }).pipe(
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
    | ObservedBlockSender
    | emailSecurity.CreateSettingBlockSenderResponse
    | emailSecurity.PatchSettingBlockSenderResponse
    | emailSecurity.ListSettingBlockSendersResponse["result"][number],
  accountId: string,
): BlockSenderAttributes => ({
  blockSenderId: entry.id ?? "",
  accountId,
  pattern: entry.pattern ?? "",
  patternType: (entry.patternType ?? "EMAIL") as PatternType,
  isRegex: entry.isRegex ?? false,
  comments: entry.comments ?? undefined,
  createdAt: entry.createdAt ?? "",
  modifiedAt: entry.modifiedAt ?? undefined,
});
