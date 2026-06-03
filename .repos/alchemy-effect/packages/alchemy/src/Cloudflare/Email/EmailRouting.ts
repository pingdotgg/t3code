import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type ZoneReference } from "../Zone/index.ts";

export type EmailRoutingStatus =
  | "ready"
  | "unconfigured"
  | "misconfigured"
  | "misconfigured/locked"
  | "unlocked";

export type EmailRoutingProps = {
  /**
   * Zone to enable email routing on. Accepts a zone id, a zone name
   * (`example.com`), or a `{ zoneId, name? }` object.
   */
  zone: ZoneReference;
  /**
   * Whether to enable Email Routing on the zone.
   *
   * @default true
   */
  enabled?: boolean;
};

export type EmailRouting = Resource<
  "Cloudflare.EmailRouting",
  EmailRoutingProps,
  {
    routingId: string;
    zoneId: string;
    name: string;
    enabled: boolean;
    status: EmailRoutingStatus | undefined;
  },
  never,
  Providers
>;

/**
 * Enables Cloudflare Email Routing on a zone. This is the prerequisite for
 * receiving mail at any address on the domain and for sending email from a
 * Worker via `send_email` bindings.
 *
 * @section Enabling Email Routing
 * @example Enable on a zone you own
 * ```typescript
 * const routing = yield* Cloudflare.EmailRouting("Routing", {
 *   zone: "example.com",
 * });
 * ```
 */
export const EmailRouting = Resource<EmailRouting>("Cloudflare.EmailRouting");

export const EmailRoutingProvider = () =>
  Provider.effect(
    EmailRouting,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const enable = yield* emailRouting.enableEmailRouting;
      const disable = yield* emailRouting.disableEmailRouting;
      const get = yield* emailRouting.getEmailRouting;

      const resolve = (zone: ZoneReference) =>
        resolveZoneId({
          accountId,
          zone,
          hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
        });

      return {
        stables: ["zoneId", "routingId"],
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
          const result = yield* get({ zoneId: output.zoneId });
          return {
            routingId: result.id,
            zoneId: output.zoneId,
            name: result.name,
            enabled: result.enabled,
            status: (result.status ?? undefined) as
              | EmailRoutingStatus
              | undefined,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
          const desired = news.enabled ?? true;

          if (desired) {
            const result = yield* enable({ zoneId, body: {} });
            return {
              routingId: result.id,
              zoneId,
              name: result.name,
              enabled: result.enabled,
              status: (result.status ?? undefined) as
                | EmailRoutingStatus
                | undefined,
            };
          } else {
            const result = yield* disable({ zoneId, body: {} });
            return {
              routingId: result.id,
              zoneId,
              name: result.name,
              enabled: result.enabled,
              status: (result.status ?? undefined) as
                | EmailRoutingStatus
                | undefined,
            };
          }
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* disable({ zoneId: output.zoneId, body: {} }).pipe(
            Effect.catch(() => Effect.void),
          );
        }),
      };
    }),
  );
