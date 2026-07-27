import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

export interface WorkerRouteProps {
  /**
   * Zone the route lives in. Stable — routes are scoped to a zone, so
   * changing the zone triggers a replacement.
   */
  zoneId: string;
  /**
   * Pattern to match incoming requests against, e.g.
   * `api.example.com/*`. The pattern must match a hostname inside the
   * zone identified by {@link zoneId}.
   *
   * Mutable — Cloudflare's PUT endpoint accepts a new pattern in place.
   * Declared as plain `string` (not `string`) so the reconciler
   * can locate an existing route by pattern after state loss.
   */
  pattern: string;
  /**
   * Name of the Worker script to run when the route matches. Accepts a
   * reference to a deployed Worker's `workerName`. When omitted, the
   * route disables Workers for matching requests (useful to opt a path
   * out of a broader wildcard route).
   *
   * Mutable — updated in place.
   */
  script?: string;
}

export interface WorkerRouteAttributes {
  /** Cloudflare-assigned route identifier. */
  routeId: string;
  /** Zone that owns this route. */
  zoneId: string;
  /** Pattern the route matches. */
  pattern: string;
  /** Worker script the route runs, or `undefined` for an opt-out route. */
  script: string | undefined;
}

export type WorkerRoute = Resource<
  "Cloudflare.Workers.Route",
  WorkerRouteProps,
  WorkerRouteAttributes,
  never,
  Providers
>;

/**
 * A Workers Route — a zone-level mapping from a URL pattern to a Worker
 * script.
 *
 * Routes are the classic way to serve a Worker on a zone hostname or
 * path. The matched hostname must resolve through Cloudflare's proxy,
 * so pair the route with a proxied DNS record (an `AAAA 100::`
 * placeholder is the conventional choice when the Worker is the only
 * origin).
 *
 * Safety: routes carry no ownership markers, and Cloudflare enforces
 * one route per pattern per zone. When there is no prior state, `read`
 * scans the zone for an existing route with the same pattern and
 * reports it as `Unowned`, so the engine refuses to take it over unless
 * `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Routing a hostname to a Worker
 * @example Route all requests on a subdomain to a Worker
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Api", {
 *   main: "./src/api.ts",
 * });
 *
 * yield* Cloudflare.Workers.WorkerRoute("ApiRoute", {
 *   zoneId: zone.zoneId,
 *   pattern: "api.example.com/*",
 *   script: worker.workerName,
 * });
 *
 * // Workers only run on proxied hostnames — give the host an origin.
 * yield* Cloudflare.DNS.Record("ApiPlaceholder", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   type: "AAAA",
 *   content: "100::",
 *   proxied: true,
 * });
 * ```
 *
 * @section Disabling Workers on a path
 * @example Opt a path out of a wildcard route
 * ```typescript
 * // No `script` — matching requests bypass Workers entirely.
 * yield* Cloudflare.Workers.WorkerRoute("AssetsBypass", {
 *   zoneId: zone.zoneId,
 *   pattern: "example.com/assets/*",
 * });
 * ```
 */
export const WorkerRoute = Resource<WorkerRoute>("Cloudflare.Workers.Route");

export const isWorkerRoute = (value: unknown): value is WorkerRoute =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Workers.Route";

export const WorkerRouteProvider = () =>
  Provider.succeed(WorkerRoute, {
    stables: ["routeId", "zoneId"],

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as WorkerRouteProps;
      const n = news as WorkerRouteProps;
      // zoneId is Input<string>; by diff time both sides are concrete
      // strings when statically knowable.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      // Owned path: refresh by our persisted route id.
      if (output?.routeId) {
        const observed = yield* observeById(output.zoneId, output.routeId);
        if (observed) {
          return toAttributes(observed, output.zoneId);
        }
      }
      // Adoption path: no state of our own, but Cloudflare enforces one
      // route per pattern per zone, so a `(zoneId, pattern)` match is
      // the same logical route. Routes carry no ownership markers, so
      // brand it `Unowned` and let the engine gate takeover behind the
      // adopt policy.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const pattern = output?.pattern ?? olds?.pattern;
      if (zoneId && pattern) {
        const observed = yield* findByPattern(zoneId, pattern);
        if (observed) {
          return Unowned(toAttributes(observed, zoneId));
        }
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const script = news.script as string | undefined;

      // 1. Observe by cached id first.
      let observed = output?.routeId
        ? yield* observeById(zoneId, output.routeId)
        : undefined;

      // 2. Fall back to scanning the zone for the pattern. Ownership has
      //    already been verified upstream — `read` reports existing
      //    routes as `Unowned` and the engine gates takeover behind the
      //    adopt policy before reconcile ever runs.
      if (!observed) {
        observed = yield* findByPattern(zoneId, news.pattern);
      }

      // 3. Ensure. A duplicate-pattern failure means another actor (or a
      //    crashed previous reconcile) created the route between our
      //    observation and now — treat it as a race and converge via PUT.
      if (!observed) {
        observed = yield* workers
          .createRoute({ zoneId, pattern: news.pattern, script })
          .pipe(
            Effect.map(normalizeRoute),
            Effect.catchTag("InvalidRoute", (originalError) =>
              Effect.gen(function* () {
                const match = yield* findByPattern(zoneId, news.pattern);
                if (!match) {
                  return yield* Effect.fail(originalError);
                }
                return match;
              }),
            ),
          );
      }

      // 4. Sync — PUT resends the full desired body when the observed
      //    route drifts from the desired pattern/script.
      if (observed.pattern !== news.pattern || observed.script !== script) {
        observed = normalizeRoute(
          yield* workers.updateRoute({
            zoneId,
            routeId: observed.id,
            pattern: news.pattern,
            script,
          }),
        );
      }

      // 5. Return.
      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* workers
        .deleteRoute({
          zoneId: output.zoneId,
          routeId: output.routeId,
        })
        .pipe(Effect.catchTag("RouteNotFound", () => Effect.void));
    }),

    // Routes are zone-scoped (`/zones/{id}/workers/routes`) with no account-
    // wide enumeration API. Fan out over every zone via `listAllZones`,
    // exhaustively paginate `listRoutes` per zone, and hydrate each into the
    // same Attributes shape `read` returns. Zones the scoped token can't
    // reach (Forbidden) or that reject the route (InvalidRoute) are skipped
    // with a typed catch rather than failing the whole enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          workers.listRoutes.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((route) =>
                  toAttributes(normalizeRoute(route), zone.id),
                ),
              ),
            ),
            Effect.catchTag(["InvalidRoute", "Forbidden"], () =>
              Effect.succeed([] as WorkerRouteAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

interface ObservedRoute {
  readonly id: string;
  readonly pattern: string;
  readonly script: string | undefined;
}

/**
 * Distilled types `script` as `string | null | undefined`; an opt-out
 * route comes back as `null` (or empty string from older API versions).
 * Normalize both to `undefined` so drift comparison is stable.
 */
const normalizeRoute = (raw: {
  id: string;
  pattern: string;
  script?: string | null;
}): ObservedRoute => ({
  id: raw.id,
  pattern: raw.pattern,
  script: raw.script == null || raw.script === "" ? undefined : raw.script,
});

const toAttributes = (
  observed: ObservedRoute,
  zoneId: string,
): WorkerRouteAttributes => ({
  routeId: observed.id,
  zoneId,
  pattern: observed.pattern,
  script: observed.script,
});

const observeById = (zoneId: string, routeId: string) =>
  workers.getRoute({ zoneId, routeId }).pipe(
    Effect.map(normalizeRoute),
    // A missing route surfaces as a 404 whose CF error code varies —
    // `RouteNotFound` (10009 or a bare 404 envelope) or `WorkerNotFound`
    // (10007, how some API versions tag a GET on a missing route). Both
    // are in `getRoute`'s typed union; swallow them so the reconciler
    // falls through to the find-by-pattern path.
    Effect.catchTag(["RouteNotFound", "WorkerNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Locate an existing route by `(zoneId, pattern)`. Cloudflare enforces
 * pattern uniqueness within a zone, so a match identifies the route.
 */
const findByPattern = (zoneId: string, pattern: string) =>
  workers.listRoutes.items({ zoneId }).pipe(
    Stream.filter((r) => r.pattern === pattern),
    Stream.runCollect,
    Effect.map((chunk) => {
      const found = Array.from(chunk)[0];
      return found === undefined ? undefined : normalizeRoute(found);
    }),
  );
