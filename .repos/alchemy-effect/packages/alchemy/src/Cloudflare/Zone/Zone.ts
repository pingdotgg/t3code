import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { stripNullFields } from "../../Util/data.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { findZoneByName } from "./lookup.ts";

export type ZoneType = "full" | "partial" | "secondary" | "internal";
export type ZoneStatus = "initializing" | "pending" | "active" | "moved";

/** Metadata about the zone (Cloudflare `meta`). */
export type ZoneMeta = {
  /** @deprecated Always `false`. */
  cdnOnly: boolean | undefined;
  /** Number of allowed custom certificates. */
  customCertificateQuota: number | undefined;
  /** @deprecated Always `true`. */
  dnsOnly: boolean | undefined;
  /** Whether the zone is on Cloudflare's Foundation DNS plan. */
  foundationDns: boolean | undefined;
  /** Number of allowed Page Rules. */
  pageRuleQuota: number | undefined;
  /** Whether the zone has been flagged for phishing. */
  phishingDetected: boolean | undefined;
  /** Onboarding step the zone is currently on. */
  step: number | undefined;
};

/** The owner of the zone (Cloudflare `owner`). */
export type ZoneOwner = {
  /** Owner identifier. */
  id: string | undefined;
  /** Owner name. */
  name: string | undefined;
  /** Owner type (e.g. `user`, `organization`). */
  type: string | undefined;
};

/** An organizational unit (tenant) the zone belongs to. */
export type ZoneTenant = {
  /** Tenant identifier. */
  id: string | undefined;
  /** Tenant name. */
  name: string | undefined;
};

/** The immediate parent organizational unit of the zone. */
export type ZoneTenantUnit = {
  /** Tenant unit identifier. */
  id: string | undefined;
};

/**
 * Common shape returned by a managed {@link Zone} resource — anything that
 * needs to point at a Cloudflare Zone can accept this.
 *
 * Mirrors Cloudflare's zone object. `zoneId` and `accountId` are Alchemy's
 * flattened identifiers (Cloudflare exposes these as `id` and `account.id`);
 * every other field keeps Cloudflare's own (camelCased) name.
 */
export type ZoneAttributes = {
  /** Zone identifier (Cloudflare `id`). Stable across updates. */
  zoneId: string;
  /** The fully-qualified domain name (e.g. `example.com`). */
  name: string;
  /** Identifier of the account the zone belongs to (Cloudflare `account.id`). */
  accountId: string;
  /** Name of the account the zone belongs to (Cloudflare `account.name`). */
  accountName: string | undefined;
  /**
   * Zone type. A full zone hosts its DNS at Cloudflare; a partial zone is a
   * partner/CNAME setup.
   */
  type: ZoneType;
  /** The zone status on Cloudflare. */
  status: ZoneStatus | undefined;
  /**
   * Whether the zone is DNS-only (Cloudflare's proxy/security features
   * disabled).
   */
  paused: boolean;
  /** The name servers Cloudflare assigns to the zone. */
  nameServers: string[];
  /** The original name servers before the domain moved to Cloudflare. */
  originalNameServers: string[] | undefined;
  /** Custom (vanity) name servers. Business/Enterprise plans only. */
  vanityNameServers: string[] | undefined;
  /** The last time proof of ownership was detected and the zone activated. */
  activatedOn: string | undefined;
  /** When the zone was created. */
  createdOn: string;
  /**
   * The interval (in seconds) until development mode expires (positive) or
   * since it last expired (negative). `0` if never enabled.
   */
  developmentMode: number;
  /** When the zone was last modified. */
  modifiedOn: string;
  /** The DNS host at the time of switching to Cloudflare. */
  originalDnshost: string | undefined;
  /** The registrar for the domain at the time of switching to Cloudflare. */
  originalRegistrar: string | undefined;
  /** Allows the customer to use a custom apex (tenants-only configuration). */
  cnameSuffix: string | undefined;
  /** Verification key for partial zone setup. */
  verificationKey: string | undefined;
  /** Metadata about the zone. */
  meta: ZoneMeta;
  /** The owner of the zone. */
  owner: ZoneOwner;
  /** The root organizational unit (tenant) the zone belongs to. */
  tenant: ZoneTenant | undefined;
  /** The immediate parent organizational unit of the zone. */
  tenantUnit: ZoneTenantUnit | undefined;
};

export type ZoneProps = {
  /**
   * The fully-qualified zone name (e.g. `example.com`). Stable — changing it
   * triggers a replacement.
   */
  name: string;
  /**
   * Zone type. Full zones host their own DNS at Cloudflare; partial zones are
   * partner/CNAME setups.
   * @default "full"
   */
  type?: ZoneType;
  /**
   * Pause Cloudflare's proxy on the zone (DNS-only).
   * @default false
   */
  paused?: boolean;
  /**
   * Custom (vanity) name servers. Business/Enterprise only.
   */
  vanityNameServers?: string[];
};

export type Zone = Resource<
  "Cloudflare.Zone",
  ZoneProps,
  ZoneAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zone (DNS domain) managed by Alchemy.
 *
 * Zones default to **retain** on removal — destroying the stack does NOT
 * delete the zone in Cloudflare. Opt in to actual deletion by wrapping the
 * resource (or the whole stack) in {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * @section Creating a Zone
 * @example Create a new zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone("MyZone", {
 *   name: "example.com",
 * });
 * ```
 *
 * @example Allow destruction
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy";
 * yield* Cloudflare.Zone("MyZone", { name: "example.com" }).pipe(destroy());
 * ```
 *
 * @section Adopting an existing Zone
 * @example Take over a zone that already exists in Cloudflare
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 * // A zone carries no ownership markers, so the engine refuses to take over a
 * // pre-existing zone unless you opt in with `adopt(true)`.
 * const zone = yield* Cloudflare.Zone("MyZone", {
 *   name: "example.com",
 * }).pipe(adopt(true));
 * // zone.zoneId, zone.nameServers, zone.accountId, ...
 * ```
 */
export const Zone = Resource<Zone>("Cloudflare.Zone", {
  defaultRemovalPolicy: "retain",
});

export const ZoneProvider = () =>
  Provider.effect(
    Zone,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const get = yield* zones.getZone;
      const create = yield* zones.createZone;
      const patch = yield* zones.patchZone;
      const del = yield* zones.deleteZone;

      return {
        stables: ["name", "zoneId", "accountId"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!output) return undefined;
          if (!isResolved(news)) return undefined;
          if (news.name !== output.name) {
            return { action: "replace" } as const;
          }
          const desiredType = news.type ?? "full";
          const desiredPaused = news.paused ?? false;
          const desiredVanity = news.vanityNameServers ?? [];
          if (
            desiredType !== output.type ||
            desiredPaused !== output.paused ||
            !stringArrayEq(desiredVanity, output.vanityNameServers ?? [])
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const name = output?.name ?? olds?.name;
          // Owned path: we have persisted state (our own zoneId) — refresh it.
          if (output?.zoneId) {
            const result = yield* get({ zoneId: output.zoneId }).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (result) return toZoneAttributes(result, accountId);
          }
          // Adoption path: no state of our own, but a zone with this name
          // already exists in the cloud. Cloudflare zones carry no ownership
          // markers we can inspect, so we cannot prove we created it — brand
          // it `Unowned` so the engine refuses to take over unless `adopt` is
          // set.
          if (name) {
            const match = yield* findZoneByName({ accountId, name });
            if (!match) return undefined;
            const result = yield* get({ zoneId: match.id });
            return Unowned(toZoneAttributes(result, accountId));
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // 1. Observe — do we have a live zone for this name?
          let zoneId = output?.zoneId;
          if (!zoneId) {
            const match = yield* findZoneByName({
              accountId,
              name: news.name,
            });
            zoneId = match?.id;
          }

          // 2. Ensure — create if missing.
          if (!zoneId) {
            zoneId = yield* create({
              account: { id: accountId },
              name: news.name,
              type: news.type ?? "full",
            }).pipe(
              Effect.map((created) => created.id),
              // A concurrent deploy (or a prior crashed run) may have created
              // the zone between our observe and create — recover by resolving
              // its id rather than failing the reconcile.
              Effect.catchTag("ZoneAlreadyExists", () =>
                findZoneByName({ accountId, name: news.name }).pipe(
                  Effect.flatMap((match) =>
                    match
                      ? Effect.succeed(match.id)
                      : Effect.fail(
                          new Error(
                            `Cloudflare reported zone ${news.name} already exists but it could not be found`,
                          ),
                        ),
                  ),
                ),
              ),
            );
          }

          // 3. Sync — apply mutable settings (type/paused/vanity NS).
          const observed = yield* get({ zoneId });
          const desiredType = news.type ?? "full";
          const desiredPaused = news.paused ?? false;
          const desiredVanity = news.vanityNameServers ?? [];
          const needsPatch =
            (observed.type ?? "full") !== desiredType ||
            (observed.paused ?? false) !== desiredPaused ||
            !stringArrayEq(observed.vanityNameServers ?? [], desiredVanity);

          if (needsPatch) {
            yield* patch({
              zoneId,
              type: desiredType,
              paused: desiredPaused,
              vanityNameServers: desiredVanity,
            });
          }

          const final = yield* get({ zoneId });
          return toZoneAttributes(final, accountId);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output.zoneId) return;
          yield* del({ zoneId: output.zoneId }).pipe(
            // Zone already gone — idempotent delete.
            Effect.catchTag("InvalidZoneIdentifier", () => Effect.void),
          );
        }),
      };
    }),
  );

/** @internal — shape a distilled zones API result into `ZoneAttributes`. */
export const toZoneAttributes = (
  result: zones.GetZoneResponse,
  fallbackAccountId: string,
): ZoneAttributes => {
  // Cloudflare returns `null` for absent fields; drop them so every optional
  // attribute is simply `undefined` (matching `ZoneAttributes`).
  const z = stripNullFields(result);
  return {
    zoneId: z.id,
    name: z.name,
    accountId: z.account.id ?? fallbackAccountId,
    accountName: z.account.name,
    type: z.type ?? "full",
    status: z.status,
    paused: z.paused ?? false,
    nameServers: z.nameServers,
    originalNameServers: z.originalNameServers,
    vanityNameServers: z.vanityNameServers,
    activatedOn: z.activatedOn,
    createdOn: z.createdOn,
    developmentMode: z.developmentMode,
    modifiedOn: z.modifiedOn,
    originalDnshost: z.originalDnshost,
    originalRegistrar: z.originalRegistrar,
    cnameSuffix: z.cnameSuffix,
    verificationKey: z.verificationKey,
    meta: z.meta,
    owner: z.owner,
    tenant: z.tenant,
    tenantUnit: z.tenantUnit,
  } as ZoneAttributes;
};

const stringArrayEq = Array.makeEquivalence(Equivalence.String);
