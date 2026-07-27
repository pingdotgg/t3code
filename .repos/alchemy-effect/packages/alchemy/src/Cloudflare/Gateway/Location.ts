import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Gateway.Location" as const;
type TypeId = typeof TypeId;

/**
 * A source network range (CIDR) requests at a Gateway location may
 * originate from.
 */
export interface LocationNetwork {
  /**
   * IPv4 CIDR, e.g. `203.0.113.0/24`.
   */
  network: string;
}

/**
 * Destination endpoint configuration for a Gateway location. Re-exports
 * distilled's request shape so every server-recognised knob (DoH networks
 * and token requirement, DoT, IPv4/IPv6 toggles) is available without
 * re-declaring the structure.
 */
export type LocationEndpoints = NonNullable<
  zeroTrust.UpdateGatewayLocationRequest["endpoints"]
>;

export interface LocationProps {
  /**
   * Display name for the location. Used as a stable identifier so the
   * provider can locate it by name during adoption / state recovery. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Whether this location is the default for the account. Cloudflare
   * rejects demoting the current default directly — promote another
   * location instead. Mutable.
   *
   * @default false
   */
  clientDefault?: boolean;
  /**
   * Whether the location must resolve EDNS (EDNS Client Subnet) queries.
   * Mutable.
   *
   * @default false
   */
  ecsSupport?: boolean;
  /**
   * Identifier of the pair of DNS destination IPv4 addresses assigned to
   * this location. When absent, Cloudflare's shared IPv4 pair is used.
   * Mutable.
   */
  dnsDestinationIpsId?: string;
  /**
   * Destination endpoint configuration (DoH / DoT / IPv4 / IPv6 toggles
   * and source networks). Mutable.
   */
  endpoints?: LocationEndpoints;
  /**
   * Source network ranges (IPv4 CIDRs) requests at this location originate
   * from. Only takes effect when non-empty and the IPv4 endpoint is
   * enabled. Mutable.
   *
   * @default []
   */
  networks?: LocationNetwork[];
}

export interface LocationAttributes {
  /** UUID of the location, assigned by Cloudflare. */
  locationId: string;
  /** Cloudflare account that owns the location. */
  accountId: string;
  /** Display name of the location. */
  name: string;
  /** Whether this location is the account default. */
  clientDefault: boolean;
  /** Whether the location resolves EDNS queries. */
  ecsSupport: boolean;
  /**
   * Server-generated DNS-over-HTTPS subdomain that receives this
   * location's DNS requests (`https://<dohSubdomain>.cloudflare-gateway.com/dns-query`).
   */
  dohSubdomain: string | undefined;
  /** Auto-generated IPv6 destination IP assigned to this location. */
  ip: string | undefined;
  /** Primary DNS destination IPv4 address (read-only, server-assigned). */
  ipv4Destination: string | undefined;
  /** Identifier of the DNS destination IPv4 pair, if a dedicated pair is assigned. */
  dnsDestinationIpsId: string | undefined;
  /** Source network ranges configured for this location. */
  networks: LocationNetwork[];
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-update timestamp. */
  updatedAt: string | undefined;
}

export type Location = Resource<
  TypeId,
  LocationProps,
  LocationAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Gateway DNS location — a configured source of
 * DNS traffic (an office, a home network, a device fleet) with its own
 * DNS-over-HTTPS endpoint and optional dedicated destination IPs.
 *
 * Cloudflare assigns each location a stable `dohSubdomain`; point your
 * network's DoH resolver at
 * `https://<dohSubdomain>.cloudflare-gateway.com/dns-query` and Gateway
 * DNS policies apply to its traffic. All declared properties converge in
 * place — nothing on a location forces a replacement.
 * @resource
 * @product Gateway
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Location
 * @example DoH-only location
 * ```typescript
 * const office = yield* Cloudflare.Gateway.Location("Office", {
 *   ecsSupport: false,
 * });
 * // Point your resolver at the assigned DoH endpoint:
 * const doh = office.dohSubdomain;
 * ```
 *
 * @example Location with IPv4 source networks
 * ```typescript
 * const office = yield* Cloudflare.Gateway.Location("Office", {
 *   networks: [{ network: "203.0.113.0/24" }],
 *   endpoints: {
 *     doh: { enabled: true },
 *     dot: { enabled: false },
 *     ipv4: { enabled: true },
 *     ipv6: { enabled: false },
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/agentless/dns/locations/
 */
export const Location = Resource<Location>(TypeId);

/**
 * Returns true if the given value is a Location resource.
 */
export const isLocation = (value: unknown): value is Location =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Right after a location create/update, Cloudflare's edge intermittently
 * answers the write with a 401 `Unauthorized` carrying "This account does
 * not have access to this feature." even though the account is fully
 * entitled — the same transient edge/token-propagation blip the read path
 * rides out as a 403 `Forbidden`. It clears within a few hundred ms, so we
 * retry the mutation while we see exactly that message. A genuine
 * entitlement loss carries the same tag, but the bounded retry surfaces it
 * quickly instead of looping. Matching the message keeps real auth failures
 * (a bad/expired token) non-retryable.
 */
const isTransientFeatureAccessBlip = (e: {
  readonly _tag: string;
  readonly message?: string;
}): boolean =>
  e._tag === "Unauthorized" &&
  (e.message ?? "").includes("does not have access to this feature");

export const LocationProvider = () =>
  Provider.succeed(Location, {
    stables: ["locationId", "accountId", "dohSubdomain", "ip", "createdAt"],

    // Account-scoped collection: enumerate every Gateway location in the
    // ambient account, exhaustively paginating, and hydrate each into the
    // exact `read` Attributes shape. The list response already carries the
    // full per-location state, so no follow-up get is needed.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listGatewayLocations.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map((l) => toAttributes(l, accountId))
              // The account's default location can't be deleted while it is
              // the client default (`CannotDeleteDefaultGatewayLocation`);
              // never enumerate it for account-wide teardown.
              .filter((l) => !l.clientDefault),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Everything declared on a location converges via PUT.
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached location id.
      if (output?.locationId) {
        const observed = yield* getLocation(acct, output.locationId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold read — locate by deterministic name. Locations carry no
      // ownership markers, so report the match as Unowned to gate adoption.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* resolveName(id, news.name);

      // 1. Observe — the cached id is a hint; fall back to a name scan so
      //    out-of-band deletes / lost state converge.
      let observed = output?.locationId
        ? yield* getLocation(accountId, output.locationId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create with the full desired body when missing. Names
      //    are not unique on Cloudflare's side, so there is no
      //    AlreadyExists race to tolerate.
      if (!observed) {
        const created = yield* zeroTrust
          .createGatewayLocation({
            accountId,
            name,
            clientDefault: news.clientDefault,
            ecsSupport: news.ecsSupport,
            dnsDestinationIpsId: news.dnsDestinationIpsId,
            endpoints: news.endpoints,
            networks: news.networks,
          })
          // See `isTransientFeatureAccessBlip` — ride out the transient
          // 401 "does not have access to this feature" edge blip.
          .pipe(
            Effect.retry({
              while: isTransientFeatureAccessBlip,
              schedule: Schedule.exponential("500 millis"),
              times: 8,
            }),
          );
        return toAttributes(created, accountId);
      }

      // 3. Sync — diff observed cloud state against desired; the update
      //    API is a PUT of the full mutable state, so send everything but
      //    skip the call entirely on a no-op. Networks compare as an
      //    unordered set; endpoints stringify-compare only when declared.
      const desired = {
        name,
        clientDefault: news.clientDefault ?? observed.clientDefault ?? false,
        ecsSupport: news.ecsSupport ?? observed.ecsSupport ?? false,
        dnsDestinationIpsId: news.dnsDestinationIpsId,
        endpoints: news.endpoints,
        networks: news.networks,
      };
      const dirty =
        observed.name !== desired.name ||
        (observed.clientDefault ?? false) !== desired.clientDefault ||
        (observed.ecsSupport ?? false) !== desired.ecsSupport ||
        (news.dnsDestinationIpsId !== undefined &&
          observed.dnsDestinationIpsId !== news.dnsDestinationIpsId) ||
        (news.networks !== undefined &&
          !sameNetworks(observed.networks ?? [], news.networks)) ||
        (news.endpoints !== undefined &&
          !sameEndpoints(observed.endpoints, news.endpoints));
      if (dirty) {
        const updated = yield* zeroTrust
          .updateGatewayLocation({
            accountId,
            locationId: observed.id!,
            name: desired.name,
            clientDefault: desired.clientDefault,
            ecsSupport: desired.ecsSupport,
            dnsDestinationIpsId: desired.dnsDestinationIpsId,
            endpoints: desired.endpoints,
            networks: desired.networks,
          })
          // See `isTransientFeatureAccessBlip` — ride out the transient
          // 401 "does not have access to this feature" edge blip.
          .pipe(
            Effect.retry({
              while: isTransientFeatureAccessBlip,
              schedule: Schedule.exponential("500 millis"),
              times: 8,
            }),
          );
        return toAttributes(updated, accountId);
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting the default location while it is the client default is a
      // non-retryable 4xx (CannotDeleteDefaultGatewayLocation, code 1217)
      // and propagates. A missing location (GatewayLocationNotFound, code
      // 1103) means we're done.
      yield* zeroTrust
        .deleteGatewayLocation({
          accountId: output.accountId,
          locationId: output.locationId,
        })
        .pipe(Effect.catchTag("GatewayLocationNotFound", () => Effect.void));
    }),
  });

type ObservedLocation = zeroTrust.GetGatewayLocationResponse;

/**
 * Read a location by id, mapping "gone" (`GatewayLocationNotFound`,
 * Cloudflare error code 1103) to `undefined`.
 */
const getLocation = (accountId: string, locationId: string) =>
  zeroTrust.getGatewayLocation({ accountId, locationId }).pipe(
    Effect.map((l): ObservedLocation | undefined => l),
    Effect.catchTag("GatewayLocationNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a location by exact name. Names are not unique on Cloudflare's
 * side; pick the oldest match for determinism.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listGatewayLocations.items({ accountId }).pipe(
    Stream.filter((l) => l.name === name),
    Stream.runCollect,
    Effect.map(
      (chunk): ObservedLocation | undefined =>
        Array.from(chunk)
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
          .at(0) as ObservedLocation | undefined,
    ),
  );

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const sameNetworks = (
  observed: ReadonlyArray<LocationNetwork>,
  desired: ReadonlyArray<LocationNetwork>,
): boolean =>
  arrayEqualsUnordered(
    observed.map((n) => n.network),
    desired.map((n) => n.network),
  );

/**
 * Endpoints are a deeply nested object whose server echo includes extra
 * `null`/default fields. Compare only the fields the caller declared.
 */
const sameEndpoints = (
  observed: ObservedLocation["endpoints"],
  desired: LocationEndpoints,
): boolean => {
  if (!observed) return false;
  const sameNetworkList = (
    o: ReadonlyArray<{ network: string }> | null | undefined,
    d: ReadonlyArray<{ network: string }> | null | undefined,
  ) =>
    d === undefined ||
    arrayEqualsUnordered(
      (o ?? []).map((n) => n.network),
      (d ?? []).map((n) => n.network),
    );
  const sameToggle = (o: boolean | null | undefined, d: boolean | undefined) =>
    d === undefined || (o ?? false) === d;
  return (
    sameToggle(observed.doh.enabled, desired.doh.enabled) &&
    sameToggle(observed.doh.requireToken, desired.doh.requireToken) &&
    sameNetworkList(observed.doh.networks, desired.doh.networks) &&
    sameToggle(observed.dot.enabled, desired.dot.enabled) &&
    sameNetworkList(observed.dot.networks, desired.dot.networks) &&
    sameToggle(observed.ipv4.enabled, desired.ipv4.enabled) &&
    sameToggle(observed.ipv6.enabled, desired.ipv6.enabled) &&
    sameNetworkList(observed.ipv6.networks, desired.ipv6.networks)
  );
};

type ListedLocation = NonNullable<
  zeroTrust.ListGatewayLocationsResponse["result"]
>[number];

const toAttributes = (
  location:
    | ObservedLocation
    | zeroTrust.UpdateGatewayLocationResponse
    | ListedLocation,
  accountId: string,
): LocationAttributes => ({
  locationId: location.id ?? "",
  accountId,
  name: location.name ?? "",
  clientDefault: location.clientDefault ?? false,
  ecsSupport: location.ecsSupport ?? false,
  dohSubdomain: location.dohSubdomain ?? undefined,
  ip: location.ip ?? undefined,
  ipv4Destination: location.ipv4Destination ?? undefined,
  dnsDestinationIpsId: location.dnsDestinationIpsId ?? undefined,
  networks: (location.networks ?? []).map((n) => ({ network: n.network })),
  createdAt: location.createdAt ?? undefined,
  updatedAt: location.updatedAt ?? undefined,
});
