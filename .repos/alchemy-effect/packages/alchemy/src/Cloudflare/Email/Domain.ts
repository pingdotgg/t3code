import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const EmailSecurityDomainTypeId = "Cloudflare.Email.Domain" as const;
type EmailSecurityDomainTypeId = typeof EmailSecurityDomainTypeId;

/**
 * Delivery modes a domain accepts messages through.
 */
export type DeliveryMode = "DIRECT" | "BCC" | "JOURNAL" | "API" | "RETRO_SCAN";

/**
 * Message dispositions that can be dropped before delivery.
 */
export type DropDisposition =
  | "MALICIOUS"
  | "MALICIOUS-BEC"
  | "SUSPICIOUS"
  | "SPOOF"
  | "SPAM"
  | "BULK"
  | "ENCRYPTED"
  | "EXTERNAL"
  | "UNKNOWN"
  | "NONE";

export interface DomainProps {
  /**
   * The fully-qualified domain name of a domain that is **already
   * onboarded** to Email Security (via MX/BCC/journal or an API
   * integration). Domains cannot be created via the API — onboarding
   * happens in the Email Security dashboard. The domain name is the
   * resource's identity — changing it triggers a replacement (re-adopting
   * a different domain).
   */
  domain: string;
  /**
   * Delivery modes the domain accepts messages through.
   */
  allowedDeliveryModes?: DeliveryMode[];
  /**
   * Message dispositions that are dropped before delivery.
   */
  dropDispositions?: DropDisposition[];
  /**
   * IP/CIDR restrictions for inbound delivery.
   */
  ipRestrictions?: string[];
  /**
   * Folder messages are scanned in for API-deployed domains.
   */
  folder?: "AllItems" | "Inbox";
  /**
   * The API integration (e.g. Office 365) the domain is associated with.
   */
  integrationId?: string;
  /**
   * Number of message hops to look back when determining the original
   * sender.
   */
  lookbackHops?: number;
  /**
   * Require TLS for inbound mail.
   */
  requireTlsInbound?: boolean;
  /**
   * Require TLS for outbound (onward) delivery.
   */
  requireTlsOutbound?: boolean;
  /**
   * Onward delivery host for the domain.
   */
  transport?: string;
}

export interface DomainAttributes {
  /** Cloudflare-assigned domain identifier. */
  domainId: string;
  /** The account the domain belongs to. */
  accountId: string;
  /** The fully-qualified domain name. */
  domain: string;
  /** Domain authorization status, if reported. */
  authorization: { authorized: boolean; timestamp: string } | undefined;
  /** Delivery modes the domain accepts messages through. */
  allowedDeliveryModes: DeliveryMode[];
  /** Message dispositions dropped before delivery. */
  dropDispositions: DropDisposition[];
  /** IP/CIDR restrictions for inbound delivery. */
  ipRestrictions: string[];
  /** Folder messages are scanned in for API-deployed domains. */
  folder: "AllItems" | "Inbox" | undefined;
  /** The API integration the domain is associated with, if any. */
  integrationId: string | undefined;
  /** Number of lookback hops, if configured. */
  lookbackHops: number | undefined;
  /** Whether TLS is required for inbound mail. */
  requireTlsInbound: boolean | undefined;
  /** Whether TLS is required for outbound delivery. */
  requireTlsOutbound: boolean | undefined;
  /** Onward delivery host. */
  transport: string;
  /** Office 365 tenant id for API-deployed domains, if any. */
  o365TenantId: string | undefined;
  /** Regions the domain's mail is processed in. */
  regions: string[];
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 last-modified timestamp, if the domain has been modified. */
  modifiedAt: string | undefined;
}

export type Domain = Resource<
  EmailSecurityDomainTypeId,
  DomainProps,
  DomainAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Email Security (Area 1) domain's settings.
 *
 * Domains cannot be created via the API — they appear when the domain is
 * onboarded to Email Security (MX/BCC/journal or an API integration) in
 * the dashboard. This resource **adopts and configures** an existing
 * domain: `read` finds it by name and reports it as unowned, so taking it
 * under management is gated behind `--adopt` (or `adopt(true)`).
 *
 * :::warning
 * **Destroying this resource offboards the domain from Email Security**
 * (the underlying API call is `DELETE .../settings/domains/{id}`). Mail
 * flow for the domain is no longer scanned afterwards. Plan destroys with
 * care.
 * :::
 *
 * Requires the Email Security enterprise add-on; accounts without the
 * entitlement receive the typed `EmailSecurityNotEntitled` error.
 * @resource
 * @product Email Security
 * @category Email
 * @section Configuring a Domain
 * @example Drop malicious mail before delivery
 * ```typescript
 * yield* Cloudflare.Email.Domain("MailDomain", {
 *   domain: "example.com",
 *   dropDispositions: ["MALICIOUS", "SPOOF"],
 * });
 * ```
 *
 * @example Restrict inbound delivery and require TLS
 * ```typescript
 * yield* Cloudflare.Email.Domain("MailDomain", {
 *   domain: "example.com",
 *   ipRestrictions: ["203.0.113.0/24"],
 *   requireTlsInbound: true,
 *   requireTlsOutbound: true,
 *   transport: "mx.example.com",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/email-security/
 */
export const Domain = Resource<Domain>(EmailSecurityDomainTypeId, {
  aliases: ["Cloudflare.EmailSecurity.Domain"],
});

/**
 * Returns true if the given value is an Domain resource.
 */
export const isDomain = (value: unknown): value is Domain =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === EmailSecurityDomainTypeId;

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["domainId", "accountId", "domain", "o365TenantId", "createdAt"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The domain name is the resource's identity — changing it means
      // re-adopting a different onboarded domain.
      const oldDomain = output?.domain ?? olds?.domain;
      if (oldDomain !== undefined && oldDomain !== news.domain) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted domain id.
      if (output?.domainId) {
        const observed = yield* getDomain(acct, output.domainId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold lookup: the domain pre-exists (onboarded in the dashboard) and
      // carries no ownership markers — report it `Unowned` so taking it
      // under management is gated behind the adopt policy.
      const domain = output?.domain ?? olds?.domain;
      if (domain !== undefined) {
        const observed = yield* findByName(acct, domain);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the domain must already be onboarded; the API cannot
      //    create one.
      let observed = output?.domainId
        ? yield* getDomain(accountId, output.domainId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, news.domain);
      }
      if (!observed) {
        return yield* Effect.fail(
          new Error(
            `Domain "${news.domain}" is not onboarded to Email Security on ` +
              `account ${accountId}. Cloudflare.Email.Domain only ` +
              `manages settings on an existing domain — onboard the domain ` +
              `in the Email Security dashboard first.`,
          ),
        );
      }

      // 2. Sync — diff observed settings against the declared props and
      //    patch only on a delta. Omitted props are left untouched.
      const delta = settingsDelta(observed, news);
      if (delta === undefined) {
        return toAttributes(observed, accountId);
      }
      const patched = yield* emailSecurity.patchSettingDomain({
        accountId,
        domainId: observed.id ?? "",
        ...delta,
      });
      return toAttributes(patched, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // DESTRUCTIVE: this offboards the domain from Email Security — its
      // mail flow is no longer scanned. Already-gone is success.
      yield* emailSecurity
        .deleteSettingDomain({
          accountId: output.accountId,
          domainId: output.domainId,
        })
        .pipe(
          Effect.catchTag("EmailSecurityDomainNotFound", () => Effect.void),
        );
    }),

    // Account-scoped collection: enumerate every onboarded domain via the
    // paginated account-level list API and hydrate each into the exact
    // `read` Attributes shape. Accounts without the Email Security add-on
    // (`EmailSecurityNotEntitled`) or lacking access (`Forbidden`) have
    // nothing to enumerate — return [].
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* emailSecurity.listSettingDomains.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((d) =>
              toAttributes(d as ObservedDomain, accountId),
            ),
          ),
        ),
        Effect.catchTag(["EmailSecurityNotEntitled", "Forbidden"], () =>
          Effect.succeed([] as DomainAttributes[]),
        ),
      );
    }),
  });

type ObservedDomain = emailSecurity.GetSettingDomainResponse;

/**
 * Read a domain by id, mapping "gone" (`EmailSecurityDomainNotFound`,
 * HTTP 404) to `undefined`.
 */
const getDomain = (accountId: string, domainId: string) =>
  emailSecurity.getSettingDomain({ accountId, domainId }).pipe(
    Effect.map((domain): ObservedDomain | undefined => domain),
    Effect.catchTag("EmailSecurityDomainNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find an onboarded domain by exact name.
 */
const findByName = (accountId: string, domain: string) =>
  emailSecurity.listSettingDomains.items({ accountId, domain: [domain] }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find((d): d is ObservedDomain => d.domain === domain),
    ),
  );

const sameArray = (
  observed: readonly string[] | null | undefined,
  desired: readonly string[],
) => {
  const a = [...(observed ?? [])].sort();
  const b = [...desired].sort();
  return a.length === b.length && a.join(",") === b.join(",");
};

/**
 * Diff observed domain settings against desired props. Only fields that
 * are explicitly declared (not `undefined`) participate. Returns
 * `undefined` when nothing needs to change, so the PATCH can be skipped
 * entirely. Inputs have been resolved to concrete values by Plan.
 */
const settingsDelta = (
  observed: ObservedDomain,
  news: DomainProps,
):
  | Omit<emailSecurity.PatchSettingDomainRequest, "accountId" | "domainId">
  | undefined => {
  const delta: Omit<
    emailSecurity.PatchSettingDomainRequest,
    "accountId" | "domainId"
  > = {};
  let dirty = false;
  if (
    news.allowedDeliveryModes !== undefined &&
    !sameArray(observed.allowedDeliveryModes, news.allowedDeliveryModes)
  ) {
    delta.allowedDeliveryModes = news.allowedDeliveryModes;
    dirty = true;
  }
  if (
    news.dropDispositions !== undefined &&
    !sameArray(observed.dropDispositions, news.dropDispositions)
  ) {
    delta.dropDispositions = news.dropDispositions;
    dirty = true;
  }
  if (
    news.ipRestrictions !== undefined &&
    !sameArray(observed.ipRestrictions, news.ipRestrictions)
  ) {
    delta.ipRestrictions = news.ipRestrictions;
    dirty = true;
  }
  if (news.folder !== undefined && (observed.folder ?? "") !== news.folder) {
    delta.folder = news.folder;
    dirty = true;
  }
  const integrationId = news.integrationId as string | undefined;
  if (
    integrationId !== undefined &&
    (observed.integrationId ?? "") !== integrationId
  ) {
    delta.integrationId = integrationId;
    dirty = true;
  }
  if (
    news.lookbackHops !== undefined &&
    observed.lookbackHops !== news.lookbackHops
  ) {
    delta.lookbackHops = news.lookbackHops;
    dirty = true;
  }
  if (
    news.requireTlsInbound !== undefined &&
    (observed.requireTlsInbound ?? false) !== news.requireTlsInbound
  ) {
    delta.requireTlsInbound = news.requireTlsInbound;
    dirty = true;
  }
  if (
    news.requireTlsOutbound !== undefined &&
    (observed.requireTlsOutbound ?? false) !== news.requireTlsOutbound
  ) {
    delta.requireTlsOutbound = news.requireTlsOutbound;
    dirty = true;
  }
  if (
    news.transport !== undefined &&
    (observed.transport ?? "") !== news.transport
  ) {
    delta.transport = news.transport;
    dirty = true;
  }
  return dirty ? delta : undefined;
};

const toAttributes = (
  domain: ObservedDomain | emailSecurity.PatchSettingDomainResponse,
  accountId: string,
): DomainAttributes => ({
  domainId: domain.id ?? "",
  accountId,
  domain: domain.domain ?? "",
  authorization: domain.authorization
    ? {
        authorized: domain.authorization.authorized,
        timestamp: domain.authorization.timestamp,
      }
    : undefined,
  allowedDeliveryModes: [
    ...(domain.allowedDeliveryModes ?? []),
  ] as DeliveryMode[],
  dropDispositions: [...(domain.dropDispositions ?? [])] as DropDisposition[],
  ipRestrictions: [...(domain.ipRestrictions ?? [])],
  folder: (domain.folder ?? undefined) as "AllItems" | "Inbox" | undefined,
  integrationId: domain.integrationId ?? undefined,
  lookbackHops: domain.lookbackHops ?? undefined,
  requireTlsInbound: domain.requireTlsInbound ?? undefined,
  requireTlsOutbound: domain.requireTlsOutbound ?? undefined,
  transport: domain.transport ?? "",
  o365TenantId: domain.o365TenantId ?? undefined,
  regions: [...(domain.regions ?? [])],
  createdAt: domain.createdAt ?? "",
  modifiedAt: domain.modifiedAt ?? undefined,
});
