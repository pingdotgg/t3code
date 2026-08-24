import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type Reference } from "../Zone/index.ts";
import { listAllZones } from "../Zone/lookup.ts";

type RoutingAttributes = Routing["Attributes"];

const toAttributes = (
  zoneId: string,
  result: emailRouting.GetEmailRoutingResponse,
): RoutingAttributes => ({
  routingId: result.id,
  zoneId,
  name: result.name,
  enabled: result.enabled,
  status: (result.status ?? undefined) as RoutingStatus | undefined,
});

export type RoutingStatus =
  | "ready"
  | "unconfigured"
  | "misconfigured"
  | "misconfigured/locked"
  | "unlocked";

export type RoutingProps = {
  /**
   * Zone to enable email routing on. Accepts a zone id, a zone name
   * (`example.com`), or a `{ zoneId, name? }` object.
   */
  zone: Reference;
  /**
   * Whether to enable Email Routing on the zone.
   *
   * @default true
   */
  enabled?: boolean;
};

export type Routing = Resource<
  "Cloudflare.Email.Routing",
  RoutingProps,
  {
    routingId: string;
    zoneId: string;
    name: string;
    enabled: boolean;
    status: RoutingStatus | undefined;
  },
  never,
  Providers
>;

/**
 * Enables Cloudflare Email Routing on a zone. This is the prerequisite for
 * receiving mail at any address on the domain and for sending email from a
 * Worker via `send_email` bindings.
 * @resource
 * @product Email
 * @category Email
 * @section Enabling Email Routing
 * @example Enable on a zone you own
 * ```typescript
 * const routing = yield* Cloudflare.Email.Routing("Routing", {
 *   zone: "example.com",
 * });
 * ```
 */
export const Routing = Resource<Routing>("Cloudflare.Email.Routing", {
  aliases: ["Cloudflare.EmailRouting"],
});

const resolve = Effect.fn(function* (zone: Reference) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* resolveZoneId({
    accountId,
    zone,
    hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
  });
});

export const RoutingProvider = () =>
  Provider.succeed(Routing, {
    nuke: { singleton: true },
    stables: ["zoneId", "routingId"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Email Routing settings are a per-zone singleton — no account-wide
      // enumeration API. Enumerate every zone in the account and read the
      // settings in each (every zone has one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          emailRouting.getEmailRouting({ zoneId }).pipe(
            Effect.map((result) => toAttributes(zoneId, result)),
            // Plan-gated or partial zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is RoutingAttributes => row !== undefined);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!output) return undefined;
      if (!isResolved(news)) return undefined;
      const zoneId = yield* resolve(news.zone);
      if (zoneId !== output.zoneId) {
        return { action: "replace" } as const;
      }
      if ((news.enabled ?? true) !== output.enabled) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output?.zoneId) return undefined;
      const result = yield* emailRouting.getEmailRouting({
        zoneId: output.zoneId,
      });
      return {
        routingId: result.id,
        zoneId: output.zoneId,
        name: result.name,
        enabled: result.enabled,
        status: (result.status ?? undefined) as RoutingStatus | undefined,
      };
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
      const desired = news.enabled ?? true;

      if (desired) {
        const result = yield* emailRouting.enableEmailRouting({
          zoneId,
          body: {},
        });
        return {
          routingId: result.id,
          zoneId,
          name: result.name,
          enabled: result.enabled,
          status: (result.status ?? undefined) as RoutingStatus | undefined,
        };
      } else {
        const result = yield* emailRouting.disableEmailRouting({
          zoneId,
          body: {},
        });
        return {
          routingId: result.id,
          zoneId,
          name: result.name,
          enabled: result.enabled,
          status: (result.status ?? undefined) as RoutingStatus | undefined,
        };
      }
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* emailRouting
        .disableEmailRouting({ zoneId: output.zoneId, body: {} })
        .pipe(Effect.catch(() => Effect.void));
    }),
  });
