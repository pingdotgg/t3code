import * as registrar from "@distilled.cloud/cloudflare/registrar";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Registrar.Domain" as const;
type TypeId = typeof TypeId;

/**
 * The mutable Cloudflare Registrar settings on a registered domain. These
 * are the only fields the Registrar API can change — everything else about
 * a registration (contacts, nameservers, renewal) is managed in the
 * Cloudflare dashboard.
 */
export interface DomainSettings {
  /**
   * Whether the registration auto-renews before it expires.
   */
  autoRenew?: boolean;
  /**
   * Whether the registrar transfer lock is in place (blocks transfers to
   * another registrar).
   */
  locked?: boolean;
  /**
   * Whether WHOIS information is redacted.
   */
  privacy?: boolean;
}

export interface DomainProps {
  /**
   * The fully-qualified domain name of a domain that is **already
   * registered** with Cloudflare Registrar on this account (e.g.
   * `example.com`). Domains cannot be registered or released via the API —
   * registration happens in the Cloudflare dashboard.
   *
   * The domain name is the resource's identity — changing it triggers a
   * replacement (the old domain's settings are restored to the values they
   * had before Alchemy managed them).
   */
  domainName: string;
  /**
   * Whether the registration auto-renews before it expires. Mutable —
   * updated in place. When omitted, the current value is left untouched.
   */
  autoRenew?: boolean;
  /**
   * Whether the registrar transfer lock is in place. Mutable — updated in
   * place. When omitted, the current value is left untouched.
   */
  locked?: boolean;
  /**
   * Whether WHOIS information is redacted. Mutable — updated in place.
   * When omitted, the current value is left untouched.
   */
  privacy?: boolean;
}

export interface DomainAttributes {
  /** The fully-qualified domain name. */
  domainName: string;
  /** Account the domain is registered under. */
  accountId: string;
  /** Whether the registration auto-renews. */
  autoRenew: boolean | undefined;
  /** Whether the registrar transfer lock is in place. */
  locked: boolean | undefined;
  /** Whether WHOIS information is redacted. */
  privacy: boolean | undefined;
  /** Whether the domain is available to register (always `false` for a registered domain). */
  available: boolean | undefined;
  /** Whether the domain can be registered through Cloudflare. */
  canRegister: boolean | undefined;
  /** The registrar currently sponsoring the domain (e.g. `Cloudflare`). */
  currentRegistrar: string | undefined;
  /** ISO8601 timestamp when the registration expires. */
  expiresAt: string | undefined;
  /** ISO8601 timestamp when the registration was created, if reported. */
  createdAt: string | undefined;
  /** ISO8601 timestamp when the registration was last updated, if reported. */
  updatedAt: string | undefined;
  /** Comma-separated EPP statuses (e.g. `clienttransferprohibited`). */
  registryStatuses: string | undefined;
  /** Whether the domain's TLD is supported by Cloudflare Registrar. */
  supportedTld: boolean | undefined;
  /**
   * The settings the domain had before Alchemy first managed it. Restored
   * on destroy, so deleting the resource puts the registration back the
   * way it was found — the domain itself is never released.
   */
  initialSettings: DomainSettings;
}

export type Domain = Resource<
  TypeId,
  DomainProps,
  DomainAttributes,
  never,
  Providers
>;

/**
 * The mutable Cloudflare Registrar settings (`auto_renew`, `locked`,
 * `privacy`) on a domain that is already registered with Cloudflare
 * Registrar.
 *
 * Domains cannot be registered or released through the API — purchases,
 * transfers, and renewals happen in the Cloudflare dashboard. This resource
 * therefore never creates or deletes a registration: reconcile adopts the
 * existing domain and converges only the settings you declare, and destroy
 * restores the settings the domain had before Alchemy first managed it
 * (captured as `initialSettings`). The domain itself always survives a
 * destroy.
 *
 * Settings you omit are left untouched, both during reconcile and during
 * the restore on destroy.
 *
 * Note: updating registrar settings requires an API token with Registrar
 * write permission; without it the update fails with the typed
 * `RegistrarUpdateNotAllowed` error.
 * @resource
 * @product Registrar
 * @category Domains & DNS
 * @section Managing a registered domain
 * @example Pin auto-renew and the transfer lock
 * ```typescript
 * yield* Cloudflare.Registrar.Domain("ApexDomain", {
 *   domainName: "example.com",
 *   autoRenew: true,
 *   locked: true,
 * });
 * ```
 *
 * @example Enable WHOIS privacy only
 * ```typescript
 * // autoRenew and locked are omitted, so they are left untouched.
 * yield* Cloudflare.Registrar.Domain("ApexDomain", {
 *   domainName: "example.com",
 *   privacy: true,
 * });
 * ```
 *
 * @section Reading registration state
 * @example Use the registration expiry downstream
 * ```typescript
 * const domain = yield* Cloudflare.Registrar.Domain("ApexDomain", {
 *   domainName: "example.com",
 *   autoRenew: true,
 * });
 * // domain.expiresAt, domain.currentRegistrar, domain.registryStatuses, ...
 * ```
 *
 * @see https://developers.cloudflare.com/registrar/
 */
export const Domain = Resource<Domain>(TypeId);

/**
 * Returns true if the given value is a Domain resource.
 */
export const isDomain = (value: unknown): value is Domain =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    // `delete` never releases the registration (it only restores settings), so
    // a domain can never be removed by teardown and would re-appear on every
    // `nuke` scan. Skip it in account-wide teardown.
    nuke: { skip: true },
    stables: ["domainName", "accountId", "initialSettings"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The domain name is the resource's identity.
      const oldDomainName = output?.domainName ?? olds?.domainName;
      if (oldDomainName !== undefined && oldDomainName !== news.domainName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const domainName = output?.domainName ?? olds?.domainName;
      if (!domainName) return undefined;
      const observed = yield* findDomain(acct, domainName);
      if (!observed) return undefined;
      // The underlying registration always pre-exists (it can only be
      // created in the dashboard) — there is no notion of creating it
      // ourselves, so a cold read adopts freely (never `Unowned`). The
      // observed settings at adoption time become the `initialSettings`
      // restored on destroy.
      const initialSettings =
        output !== undefined
          ? output.initialSettings
          : captureSettings(observed);
      return toAttributes(domainName, acct, observed, initialSettings);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const domainName = news.domainName;

      // 1. Observe — the registration must already exist on the account;
      //    the API cannot create one.
      const observed = yield* findDomain(accountId, domainName);
      if (!observed) {
        return yield* Effect.fail(
          new Error(
            `Domain "${domainName}" is not registered with Cloudflare Registrar ` +
              `on account ${accountId}. Cloudflare.Registrar.Domain only manages ` +
              `settings on an existing registration — register or transfer the ` +
              `domain in the Cloudflare dashboard first.`,
          ),
        );
      }

      // 2. Capture — the pre-management settings, restored on destroy.
      //    `output` (including an adoption read) already carries them;
      //    otherwise this is our first touch and the observed settings are
      //    the registration's originals.
      const initialSettings =
        output !== undefined
          ? output.initialSettings
          : captureSettings(observed);

      // 3. Sync — diff the observed settings against the declared props and
      //    PUT only on a delta. Omitted props are left untouched.
      const delta = settingsDelta(observed, news);
      if (delta === undefined) {
        return toAttributes(domainName, accountId, observed, initialSettings);
      }
      yield* registrar.putDomain({ accountId, domainName, ...delta });

      // 4. Return — re-read so attributes reflect live state; registrar
      //    updates can apply asynchronously, so overlay the desired
      //    settings on what we just put.
      const fresh = (yield* findDomain(accountId, domainName)) ?? observed;
      return toAttributes(domainName, accountId, fresh, initialSettings, news);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { domainName, accountId, initialSettings } = output;
      // Never release the registration — destroy only restores the
      // settings the domain had before Alchemy managed it.
      const observed = yield* findDomain(accountId, domainName);
      // Domain gone (transferred out / expired out-of-band) — nothing to
      // restore.
      if (!observed) return;
      const delta = settingsDelta(observed, initialSettings);
      if (delta === undefined) return;
      yield* registrar.putDomain({ accountId, domainName, ...delta }).pipe(
        // Lost ownership between the observe and the put — gone is done.
        Effect.catchTag("RegistrarDomainNotOwned", () => Effect.void),
      );
    }),

    // Account-scoped collection: enumerate every domain registered with
    // Cloudflare Registrar on the account, exhaustively paginated, and
    // hydrate each into the exact `read` Attributes shape. There is no prior
    // managed state for an enumerated domain, so — exactly like a cold
    // adoption read — the observed settings become the `initialSettings`.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* registrar.listDomains.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (domain): domain is ObservedDomain & { name: string } =>
                  typeof domain.name === "string",
              )
              .map((domain) =>
                toAttributes(
                  domain.name,
                  accountId,
                  domain,
                  captureSettings(domain),
                ),
              ),
          ),
        ),
      );
    }),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ObservedDomain = registrar.ListDomainsResponse["result"][number];

/**
 * Find a registered domain by name on the account. `getDomain` answers 200
 * with a minimal availability stub (`{ name, supported_tld }`) for domains
 * that are *not* registered on the account, so scanning the typed list is
 * both the reliable existence check and the typed read.
 */
const findDomain = (accountId: string, domainName: string) =>
  registrar.listDomains.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (domain): domain is ObservedDomain => domain.name === domainName,
      ),
    ),
  );

/** Snapshot the mutable registrar settings of an observed domain. */
const captureSettings = (observed: ObservedDomain): DomainSettings => ({
  autoRenew: observed.autoRenew ?? undefined,
  locked: observed.locked ?? undefined,
  privacy: observed.privacy ?? undefined,
});

/**
 * Diff observed settings against desired ones. Only fields that are
 * explicitly desired (not `undefined`) participate. Returns `undefined`
 * when nothing needs to change, so the PUT can be skipped entirely.
 */
const settingsDelta = (
  observed: ObservedDomain,
  desired: DomainSettings,
): DomainSettings | undefined => {
  const delta: DomainSettings = {};
  let dirty = false;
  if (
    desired.autoRenew !== undefined &&
    desired.autoRenew !== (observed.autoRenew ?? undefined)
  ) {
    delta.autoRenew = desired.autoRenew;
    dirty = true;
  }
  if (
    desired.locked !== undefined &&
    desired.locked !== (observed.locked ?? undefined)
  ) {
    delta.locked = desired.locked;
    dirty = true;
  }
  if (
    desired.privacy !== undefined &&
    desired.privacy !== (observed.privacy ?? undefined)
  ) {
    delta.privacy = desired.privacy;
    dirty = true;
  }
  return dirty ? delta : undefined;
};

const toAttributes = (
  domainName: string,
  accountId: string,
  observed: ObservedDomain,
  initialSettings: DomainSettings,
  desired?: DomainSettings,
): DomainAttributes => ({
  domainName,
  accountId,
  // Registrar setting updates can apply asynchronously — overlay the
  // settings we just PUT over the (possibly lagging) observed values.
  autoRenew: desired?.autoRenew ?? observed.autoRenew ?? undefined,
  locked: desired?.locked ?? observed.locked ?? undefined,
  privacy: desired?.privacy ?? observed.privacy ?? undefined,
  available: observed.available ?? undefined,
  canRegister: observed.canRegister ?? undefined,
  currentRegistrar: observed.currentRegistrar ?? undefined,
  expiresAt: observed.expiresAt ?? undefined,
  createdAt: observed.createdAt ?? undefined,
  updatedAt: observed.updatedAt ?? undefined,
  registryStatuses: observed.registryStatuses ?? undefined,
  supportedTld: observed.supportedTld ?? undefined,
  initialSettings,
});
