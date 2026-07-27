import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const EmailSecurityImpersonationRegistryEntryTypeId =
  "Cloudflare.Email.ImpersonationRegistryEntry" as const;
type EmailSecurityImpersonationRegistryEntryTypeId =
  typeof EmailSecurityImpersonationRegistryEntryTypeId;

export interface ImpersonationRegistryEntryProps {
  /**
   * The display name to protect (e.g. a VIP's name as it appears in the
   * `From` header). Together with `email` it forms the entry's identity
   * for cold-state recovery.
   */
  name: string;
  /**
   * The legitimate email address (or regular expression) for the display
   * name. Messages using the display name from a different address are
   * flagged as impersonation/BEC.
   */
  email: string;
  /**
   * Whether `email` is a regular expression.
   * @default false
   */
  isEmailRegex?: boolean;
  /**
   * Free-form notes about the entry.
   */
  comments?: string;
}

export interface ImpersonationRegistryEntryAttributes {
  /** Cloudflare-assigned impersonation registry entry identifier. */
  entryId: string;
  /** The account the entry belongs to. */
  accountId: string;
  /** The protected display name. */
  name: string;
  /** The legitimate email address (or regex). */
  email: string;
  /** Whether the email is a regular expression. */
  isEmailRegex: boolean;
  /** Free-form notes about the entry, if set. */
  comments: string | undefined;
  /**
   * Where the entry came from. Manually created entries are
   * `A1S_INTERNAL`; directory-synced entries carry the integration's
   * provenance.
   */
  provenance: string | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-modified timestamp, if the entry has been modified. */
  modifiedAt: string | undefined;
}

export type ImpersonationRegistryEntry = Resource<
  EmailSecurityImpersonationRegistryEntryTypeId,
  ImpersonationRegistryEntryProps,
  ImpersonationRegistryEntryAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Email Security (Area 1) impersonation registry entry —
 * maps a protected display name (e.g. a VIP) to their legitimate email
 * address for BEC/impersonation detection.
 *
 * All fields are mutable in place. Directory-synced fields
 * (`directory_id`, `directory_node_id`, `provenance`) are managed by
 * Office365/Google integrations and are not exposed as inputs. Requires
 * the Email Security enterprise add-on; accounts without the entitlement
 * receive the typed `EmailSecurityNotEntitled` error.
 * @resource
 * @product Email Security
 * @category Email
 * @section Registering Protected Identities
 * @example Protect an executive's display name
 * ```typescript
 * yield* Cloudflare.Email.ImpersonationRegistryEntry("Ceo", {
 *   name: "Jane Smith",
 *   email: "jane.smith@example.com",
 *   comments: "CEO — high-value BEC target",
 * });
 * ```
 *
 * @example Match several legitimate addresses with a regex
 * ```typescript
 * yield* Cloudflare.Email.ImpersonationRegistryEntry("Finance", {
 *   name: "Accounts Payable",
 *   email: "^ap(-[a-z]+)?@example\\.com$",
 *   isEmailRegex: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/email-security/
 */
export const ImpersonationRegistryEntry = Resource<ImpersonationRegistryEntry>(
  EmailSecurityImpersonationRegistryEntryTypeId,
  { aliases: ["Cloudflare.EmailSecurity.ImpersonationRegistryEntry"] },
);

/**
 * Returns true if the given value is an
 * ImpersonationRegistryEntry resource.
 */
export const isImpersonationRegistryEntry = (
  value: unknown,
): value is ImpersonationRegistryEntry =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === EmailSecurityImpersonationRegistryEntryTypeId;

export const ImpersonationRegistryEntryProvider = () =>
  Provider.succeed(ImpersonationRegistryEntry, {
    stables: ["entryId", "accountId", "createdAt"],

    // Account collection: exhaustively paginate the account-scoped registry
    // list and hydrate each row into the exact `read` Attributes shape.
    // Accounts without the Email Security add-on return the typed
    // `EmailSecurityNotEntitled` error → treat as an empty registry.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* emailSecurity.listSettingImpersonationRegistries
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
            Effect.succeed([] as ImpersonationRegistryEntryAttributes[]),
          ),
        );
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted entry id.
      if (output?.entryId) {
        const observed = yield* getEntry(acct, output.entryId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold lookup: recover by exact name + email; matches are reported
      // as `Unowned` so takeover is gated behind the adopt policy.
      const name = output?.name ?? olds?.name;
      const email = output?.email ?? olds?.email;
      if (name !== undefined && email !== undefined) {
        const observed = yield* findByIdentity(acct, name, email);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — id hint first, then identity scan.
      let observed = output?.entryId
        ? yield* getEntry(accountId, output.entryId)
        : undefined;
      if (!observed) {
        observed = yield* findByIdentity(accountId, news.name, news.email);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* emailSecurity.createSettingImpersonationRegistry(
          {
            accountId,
            name: news.name,
            email: news.email,
            isEmailRegex: news.isEmailRegex ?? false,
            comments: news.comments,
          },
        );
        return toAttributes(created, accountId);
      }

      // 3. Sync — patch only on a delta.
      const dirty =
        (observed.name ?? "") !== news.name ||
        (observed.email ?? "") !== news.email ||
        (observed.isEmailRegex ?? false) !== (news.isEmailRegex ?? false) ||
        (news.comments !== undefined &&
          (observed.comments ?? "") !== news.comments);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const patched = yield* emailSecurity.patchSettingImpersonationRegistry({
        accountId,
        impersonationRegistryId: observed.id ?? "",
        name: news.name,
        email: news.email,
        isEmailRegex: news.isEmailRegex ?? false,
        comments: news.comments,
      });
      return toAttributes(patched, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* emailSecurity
        .deleteSettingImpersonationRegistry({
          accountId: output.accountId,
          impersonationRegistryId: output.entryId,
        })
        .pipe(
          Effect.catchTag(
            "ImpersonationRegistryEntryNotFound",
            () => Effect.void,
          ),
        );
    }),
  });

type ObservedEntry = emailSecurity.GetSettingImpersonationRegistryResponse;

/**
 * Read an impersonation registry entry by id, mapping "gone"
 * (`ImpersonationRegistryEntryNotFound`, HTTP 404) to `undefined`.
 */
const getEntry = (accountId: string, impersonationRegistryId: string) =>
  emailSecurity
    .getSettingImpersonationRegistry({ accountId, impersonationRegistryId })
    .pipe(
      Effect.map((entry): ObservedEntry | undefined => entry),
      Effect.catchTag("ImpersonationRegistryEntryNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find an entry by exact display name + email. The `search` query is a
 * server-side hint; the exact match is re-checked client-side. Picks the
 * oldest match for determinism.
 */
const findByIdentity = (accountId: string, name: string, email: string) =>
  emailSecurity.listSettingImpersonationRegistries
    .items({ accountId, search: email })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .filter((entry) => entry.name === name && entry.email === email)
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
          .at(0),
      ),
    );

type ListedEntry =
  emailSecurity.ListSettingImpersonationRegistriesResponse["result"][number];

const toAttributes = (
  entry:
    | ObservedEntry
    | emailSecurity.CreateSettingImpersonationRegistryResponse
    | emailSecurity.PatchSettingImpersonationRegistryResponse
    | ListedEntry,
  accountId: string,
): ImpersonationRegistryEntryAttributes => ({
  entryId: entry.id ?? "",
  accountId,
  name: entry.name ?? "",
  email: entry.email ?? "",
  isEmailRegex: entry.isEmailRegex ?? false,
  comments: entry.comments ?? undefined,
  provenance: entry.provenance ?? undefined,
  createdAt: entry.createdAt ?? "",
  modifiedAt: entry.modifiedAt ?? undefined,
});
