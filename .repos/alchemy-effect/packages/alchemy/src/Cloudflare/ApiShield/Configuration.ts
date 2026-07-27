import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ApiShield.Configuration" as const;
type TypeId = typeof TypeId;

/**
 * A session identifier ("auth ID characteristic") used by API Shield to
 * correlate API requests to individual API consumers. Header and cookie
 * characteristics name the header/cookie carrying the session token; `jwt`
 * characteristics take a claim path expression in `name`.
 */
export type AuthIdCharacteristic =
  | {
      /** Name of the header or cookie carrying the session identifier. */
      name: string;
      /** Where the session identifier lives on the request. */
      type: "header" | "cookie";
    }
  | {
      /** Claim path expression locating the session identifier in the JWT. */
      name: string;
      /** The session identifier is a claim inside a validated JWT. */
      type: "jwt";
    };

export interface ConfigurationProps {
  /**
   * Zone whose API Shield configuration is managed.
   *
   * Immutable — moving the configuration between zones triggers a
   * replacement (the old zone's configuration is restored to the value it
   * had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * The session identifiers ("auth ID characteristics") API Shield uses to
   * attribute API requests to individual consumers — used by API Discovery
   * and volumetric abuse detection. At most 10.
   *
   * Mutable — written in place via PUT.
   */
  authIdCharacteristics: AuthIdCharacteristic[];
}

export interface ConfigurationAttributes {
  /** Zone whose API Shield configuration is managed. */
  zoneId: string;
  /** The session identifiers currently configured on the zone. */
  authIdCharacteristics: AuthIdCharacteristic[];
  /**
   * The session identifiers the zone had before Alchemy first managed the
   * configuration. Restored on destroy, so deleting the resource puts the
   * zone back the way it was found.
   */
  initialAuthIdCharacteristics: AuthIdCharacteristic[];
}

export type Configuration = Resource<
  TypeId,
  ConfigurationProps,
  ConfigurationAttributes,
  never,
  Providers
>;

/**
 * The API Shield configuration of a Cloudflare zone — the session
 * identifiers ("auth ID characteristics") used to attribute API traffic to
 * individual consumers for API Discovery and volumetric abuse detection.
 *
 * The configuration is a zone singleton: it always exists (defaulting to an
 * empty list), so this resource never creates or deletes anything physical.
 * Reconcile PUTs the configuration when the observed characteristics differ
 * from the desired ones; destroy restores the characteristics the zone had
 * before Alchemy first managed them.
 *
 * Requires an API Shield entitlement (Enterprise) — on other plans every
 * operation fails with Cloudflare's `NotEntitled` error (code 10403).
 * @resource
 * @product API Shield
 * @category Application Security
 * @section Configuring session identifiers
 * @example Identify sessions by an Authorization header
 * ```typescript
 * yield* Cloudflare.ApiShield.Configuration("SessionIds", {
 *   zoneId: zone.zoneId,
 *   authIdCharacteristics: [{ name: "authorization", type: "header" }],
 * });
 * ```
 *
 * @example Identify sessions by a cookie and a JWT claim
 * ```typescript
 * yield* Cloudflare.ApiShield.Configuration("SessionIds", {
 *   zoneId: zone.zoneId,
 *   authIdCharacteristics: [
 *     { name: "session_id", type: "cookie" },
 *     { name: '$.cf.token_configurations[?(@.title=="api")].sub', type: "jwt" },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/get-started/#session-identifiers
 */
export const Configuration = Resource<Configuration>(TypeId);

/**
 * Returns true if the given value is an Configuration resource.
 */
export const isConfiguration = (value: unknown): value is Configuration =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ConfigurationProvider = () =>
  Provider.succeed(Configuration, {
    stables: ["zoneId", "initialAuthIdCharacteristics"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its configuration (it always exists,
      // defaulting to an empty list, on every entitled zone).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          apiGateway.getConfiguration({ zoneId }).pipe(
            Effect.map((observed) => {
              const characteristics = toCharacteristics(
                observed.authIdCharacteristics,
              );
              return toAttributes(
                zoneId,
                observed.authIdCharacteristics,
                // A freshly listed item adopts its observed value as the
                // pre-management baseline, mirroring a cold `read`.
                characteristics,
              );
            }),
            // API Shield is entitlement-gated and zones may be partial or
            // deleted out-of-band — skip any zone we can't read.
            Effect.catchTag(
              ["NotEntitled", "InvalidObjectIdentifier", "Forbidden"],
              () => Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is ConfigurationAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      const o = olds as ConfigurationProps | undefined;
      const n = news as ConfigurationProps;
      // zoneId is Input<string>; compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ??
        (typeof o?.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;
      const observed = yield* apiGateway.getConfiguration({ zoneId }).pipe(
        // Zone deleted out-of-band — the configuration is gone with it.
        Effect.catchTag("InvalidObjectIdentifier", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return undefined;
      // The configuration is a singleton that always exists with a default
      // (empty) value — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed value at adoption time
      // becomes the baseline restored on destroy.
      const initial =
        output !== undefined
          ? output.initialAuthIdCharacteristics
          : toCharacteristics(observed.authIdCharacteristics);
      return toAttributes(zoneId, observed.authIdCharacteristics, initial);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the configuration always exists; read its live value.
      const observed = yield* apiGateway.getConfiguration({ zoneId });

      // 2. Capture — the pre-management characteristics, restored on
      //    destroy. `output` (including an adoption read) already carries
      //    them; otherwise this is our first touch and the observed value
      //    is the zone's original.
      const initial =
        output !== undefined
          ? output.initialAuthIdCharacteristics
          : toCharacteristics(observed.authIdCharacteristics);

      // 3. Sync — PUT only when the observed characteristics differ.
      if (
        characteristicsEqual(
          toCharacteristics(observed.authIdCharacteristics),
          news.authIdCharacteristics,
        )
      ) {
        return toAttributes(zoneId, observed.authIdCharacteristics, initial);
      }
      const synced = yield* apiGateway.putConfiguration({
        zoneId,
        authIdCharacteristics: news.authIdCharacteristics,
      });
      return toAttributes(zoneId, synced.authIdCharacteristics, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialAuthIdCharacteristics } = output;
      // Observe — if the zone itself is gone, so is the configuration.
      const observed = yield* apiGateway
        .getConfiguration({ zoneId })
        .pipe(
          Effect.catchTag("InvalidObjectIdentifier", () =>
            Effect.succeed(undefined),
          ),
        );
      if (observed === undefined) return;
      // Restore the pre-management characteristics; skip the call when
      // they already match (idempotent re-delete after a crashed run).
      if (
        characteristicsEqual(
          toCharacteristics(observed.authIdCharacteristics),
          initialAuthIdCharacteristics,
        )
      ) {
        return;
      }
      yield* apiGateway
        .putConfiguration({
          zoneId,
          authIdCharacteristics: initialAuthIdCharacteristics,
        })
        .pipe(Effect.catchTag("InvalidObjectIdentifier", () => Effect.void));
    }),
  });

/**
 * Narrow distilled's open-union characteristics (`"header" | "cookie" |
 * (string & {})`) to the resource's closed attribute type.
 */
const toCharacteristics = (
  characteristics: readonly { name: string; type: string }[],
): AuthIdCharacteristic[] =>
  characteristics.map(
    (c) =>
      ({
        name: c.name,
        type: c.type,
      }) as AuthIdCharacteristic,
  );

/**
 * Order-insensitive equality of two characteristic lists — Cloudflare
 * treats the configuration as a set.
 */
const characteristicsEqual = (
  a: AuthIdCharacteristic[],
  b: AuthIdCharacteristic[],
): boolean => {
  if (a.length !== b.length) return false;
  const key = (c: AuthIdCharacteristic) => `${c.type} ${c.name}`;
  const as = a.map(key).sort();
  const bs = b.map(key).sort();
  return as.every((k, i) => k === bs[i]);
};

const toAttributes = (
  zoneId: string,
  observed: readonly { name: string; type: string }[],
  initial: AuthIdCharacteristic[],
): ConfigurationAttributes => ({
  zoneId,
  authIdCharacteristics: toCharacteristics(observed),
  initialAuthIdCharacteristics: initial,
});
