import * as managedTransforms from "@distilled.cloud/cloudflare/managed-transforms";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ManagedTransforms.ManagedTransforms" as const;
type TypeId = typeof TypeId;

/**
 * Identifier of a Cloudflare managed request transform — the built-in
 * request-header transforms Cloudflare offers on
 * `/zones/{zone_id}/managed_headers`. The open `(string & {})` tail keeps
 * the type forward-compatible with transforms Cloudflare adds later.
 */
export type ManagedRequestTransformId =
  | "add_bot_protection_headers"
  | "add_client_certificate_headers"
  | "add_true_client_ip_headers"
  | "add_visitor_location_headers"
  | "add_waf_credential_check_status_header"
  | "remove_visitor_ip_headers"
  | (string & {});

/**
 * Identifier of a Cloudflare managed response transform — the built-in
 * response-header transforms Cloudflare offers on
 * `/zones/{zone_id}/managed_headers`. The open `(string & {})` tail keeps
 * the type forward-compatible with transforms Cloudflare adds later.
 */
export type ManagedResponseTransformId =
  | "add_security_headers"
  | "remove_x-powered-by_header"
  | (string & {});

export interface Props {
  /**
   * Zone whose managed transforms are managed. Stable — changing the zone
   * triggers a replacement (the old zone's managed transforms are restored
   * to the enabled states they had before Alchemy managed them).
   */
  zoneId: string;
  /**
   * Desired enabled state per managed **request** transform id (e.g.
   * `{ add_visitor_location_headers: true }`). Only the ids you name here
   * are managed — every other transform on the zone is left untouched.
   *
   * Mutable — patched in place.
   *
   * @default {}
   */
  requestHeaders?: Partial<Record<ManagedRequestTransformId, boolean>>;
  /**
   * Desired enabled state per managed **response** transform id (e.g.
   * `{ "remove_x-powered-by_header": true }`). Only the ids you name here
   * are managed — every other transform on the zone is left untouched.
   *
   * Mutable — patched in place.
   *
   * @default {}
   */
  responseHeaders?: Partial<Record<ManagedResponseTransformId, boolean>>;
}

/**
 * Observed state of a single managed transform on the zone.
 */
export interface ManagedTransformState {
  /** The transform's identifier (e.g. `add_visitor_location_headers`). */
  id: string;
  /** Whether the transform is currently enabled on the zone. */
  enabled: boolean;
  /** Whether the transform conflicts with another enabled feature. */
  hasConflict: boolean;
  /** Ids of the transforms this one conflicts with, when Cloudflare reports them. */
  conflictsWith: string[] | undefined;
}

export interface Attributes {
  /** Zone that owns these managed transforms. */
  zoneId: string;
  /** Observed state of every managed request transform on the zone. */
  requestHeaders: ManagedTransformState[];
  /** Observed state of every managed response transform on the zone. */
  responseHeaders: ManagedTransformState[];
  /**
   * Snapshot of every request transform's enabled state observed **before**
   * this resource first wrote to the zone. `delete` restores the ids this
   * resource managed to these values.
   */
  initialRequestHeaders: Record<string, boolean>;
  /**
   * Snapshot of every response transform's enabled state observed
   * **before** this resource first wrote to the zone. `delete` restores the
   * ids this resource managed to these values.
   */
  initialResponseHeaders: Record<string, boolean>;
}

export type ManagedTransforms = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * The managed request/response header transforms of a Cloudflare zone
 * (`/zones/{zone_id}/managed_headers`) — a zone-scoped **singleton**: every
 * zone always carries the full catalog of managed transforms (each with an
 * enabled flag), so there is no create or delete on the Cloudflare side.
 *
 * Reconciling this resource adopts the singleton and patches **only the
 * transform ids you name** in `requestHeaders` / `responseHeaders` — every
 * other transform is left exactly as found (dashboard- or otherwise-managed
 * toggles are never clobbered).
 *
 * On destroy, the resource restores the ids it managed to the enabled
 * states observed before its first write (the `initialRequestHeaders` /
 * `initialResponseHeaders` snapshots). Transforms that were never named are
 * not touched.
 *
 * Some transforms are plan-gated (e.g. `add_bot_protection_headers`
 * requires Bot Management) — enabling those fails server-side on
 * unentitled zones.
 * @resource
 * @product Managed Transforms
 * @category Rules & Configuration
 * @section Request transforms
 * @example Add visitor location headers
 * ```typescript
 * yield* Cloudflare.ManagedTransforms.ManagedTransforms("Transforms", {
 *   zoneId: zone.zoneId,
 *   requestHeaders: { add_visitor_location_headers: true },
 * });
 * ```
 *
 * @example Remove visitor IP headers
 * ```typescript
 * yield* Cloudflare.ManagedTransforms.ManagedTransforms("Transforms", {
 *   zoneId: zone.zoneId,
 *   requestHeaders: { remove_visitor_ip_headers: true },
 * });
 * ```
 *
 * @section Response transforms
 * @example Harden responses
 * ```typescript
 * yield* Cloudflare.ManagedTransforms.ManagedTransforms("Transforms", {
 *   zoneId: zone.zoneId,
 *   responseHeaders: {
 *     add_security_headers: true,
 *     "remove_x-powered-by_header": true,
 *   },
 * });
 * ```
 *
 * @section Mixed
 * @example Manage request and response transforms together
 * ```typescript
 * yield* Cloudflare.ManagedTransforms.ManagedTransforms("Transforms", {
 *   zoneId: zone.zoneId,
 *   requestHeaders: { add_true_client_ip_headers: true },
 *   responseHeaders: { "remove_x-powered-by_header": false },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/rules/transform/managed-transforms/
 */
export const ManagedTransforms = Resource<ManagedTransforms>(TypeId, {
  aliases: ["Cloudflare.ManagedTransforms"],
});

/**
 * Returns true if the given value is a ManagedTransforms resource.
 */
export const isManagedTransforms = (
  value: unknown,
): value is ManagedTransforms =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ManagedTransformsProvider = () =>
  Provider.succeed(ManagedTransforms, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialRequestHeaders", "initialResponseHeaders"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The managed-transforms catalog is a per-zone singleton with no
      // account-wide list — enumerate every zone and read its catalog.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          observe(zoneId).pipe(
            Effect.map((observed) =>
              observed === undefined
                ? undefined
                : // Cold enumeration adopts the singleton freely — the
                  // observed enabled states become the snapshot baseline,
                  // matching the `read` cold-adopt path.
                  toAttributes(
                    zoneId,
                    observed,
                    snapshot(observed.managedRequestHeaders),
                    snapshot(observed.managedResponseHeaders),
                  ),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is Attributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as Props;
      const n = news as Props;
      // zoneId is Input<string>; compare only when both sides are concrete.
      const oldZone = output?.zoneId ?? o.zoneId;
      if (
        typeof oldZone === "string" &&
        typeof n.zoneId === "string" &&
        oldZone !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      // The transform catalog is a singleton — it exists iff the zone does.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* observe(zoneId);
      if (!observed) return undefined;
      // Singletons always exist with Cloudflare defaults — there is nothing
      // to "own", so a cold read adopts freely (never `Unowned`). The
      // enabled states observed at adoption time become the snapshot
      // restored on destroy.
      return toAttributes(
        zoneId,
        observed,
        output?.initialRequestHeaders ??
          snapshot(observed.managedRequestHeaders),
        output?.initialResponseHeaders ??
          snapshot(observed.managedResponseHeaders),
      );
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs are resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the singleton always exists for a live zone.
      let observed = normalize(
        yield* managedTransforms.listManagedTransforms({ zoneId }),
      );

      // 2. Snapshot — capture pre-management enabled states once; `output`
      //    acts as the cache that keeps the very first observation sticky.
      const initialRequestHeaders =
        output?.initialRequestHeaders ??
        snapshot(observed.managedRequestHeaders);
      const initialResponseHeaders =
        output?.initialResponseHeaders ??
        snapshot(observed.managedResponseHeaders);

      // 3. Sync — diff the managed ids' desired enabled flags against the
      //    observed states and PATCH only the deltas. Unnamed transforms
      //    are never sent, so they stay exactly as found.
      const requestDelta = delta(
        news.requestHeaders ?? {},
        observed.managedRequestHeaders,
      );
      const responseDelta = delta(
        news.responseHeaders ?? {},
        observed.managedResponseHeaders,
      );
      if (requestDelta.length > 0 || responseDelta.length > 0) {
        observed = normalize(
          yield* managedTransforms.patchManagedTransform({
            zoneId,
            managedRequestHeaders: requestDelta,
            managedResponseHeaders: responseDelta,
          }),
        );
      }

      // 4. Return fresh attributes.
      return toAttributes(
        zoneId,
        observed,
        initialRequestHeaders,
        initialResponseHeaders,
      );
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      // Singleton — nothing to delete on the Cloudflare side. Restore the
      // ids this resource managed (i.e. the ones named in the last-applied
      // props) to their pre-management snapshot values. Ids missing from
      // the snapshot (added by Cloudflare after adoption) are left as-is.
      const observed = yield* observe(output.zoneId);
      if (!observed) return; // zone is gone — nothing to restore
      const o = (olds ?? {}) as Props;
      const requestRestore = restoreDelta(
        o.requestHeaders ?? {},
        output.initialRequestHeaders ?? {},
        observed.managedRequestHeaders,
      );
      const responseRestore = restoreDelta(
        o.responseHeaders ?? {},
        output.initialResponseHeaders ?? {},
        observed.managedResponseHeaders,
      );
      if (requestRestore.length > 0 || responseRestore.length > 0) {
        yield* managedTransforms
          .patchManagedTransform({
            zoneId: output.zoneId,
            managedRequestHeaders: requestRestore,
            managedResponseHeaders: responseRestore,
          })
          .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
      }
    }),
  });

interface ObservedTransform {
  id: string;
  enabled: boolean;
  hasConflict: boolean;
  conflictsWith?: string[] | null;
}

interface ObservedTransforms {
  managedRequestHeaders: readonly ObservedTransform[];
  managedResponseHeaders: readonly ObservedTransform[];
}

/**
 * Cloudflare returns `null` (not `[]`) for a transform list when the zone's
 * plan offers no transforms of that kind (e.g. all managed request
 * transforms are plan-gated on free zones). Normalize to empty arrays so the
 * rest of the provider only deals in lists.
 */
const normalize = (
  response:
    | managedTransforms.ListManagedTransformsResponse
    | managedTransforms.PatchManagedTransformResponse,
): ObservedTransforms => ({
  managedRequestHeaders: response.managedRequestHeaders ?? [],
  managedResponseHeaders: response.managedResponseHeaders ?? [],
});

/**
 * Read the zone's managed transforms, mapping a dead zone (`InvalidRoute`,
 * Cloudflare code 7003) to `undefined`.
 */
const observe = (zoneId: string) =>
  managedTransforms.listManagedTransforms({ zoneId }).pipe(
    Effect.map(normalize),
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );

/**
 * Project an observed transform list onto an id → enabled snapshot map.
 */
const snapshot = (
  transforms: readonly ObservedTransform[],
): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const t of transforms) out[t.id] = t.enabled;
  return out;
};

/**
 * The PATCH entries needed to bring the managed ids to their desired
 * enabled states — only ids whose observed state differs are included, so
 * a no-op reconcile sends nothing.
 */
const delta = (
  desired: Partial<Record<string, boolean>>,
  observed: readonly ObservedTransform[],
): { id: string; enabled: boolean }[] => {
  const current = snapshot(observed);
  const out: { id: string; enabled: boolean }[] = [];
  for (const [id, enabled] of Object.entries(desired)) {
    if (enabled !== undefined && current[id] !== enabled) {
      out.push({ id, enabled });
    }
  }
  return out;
};

/**
 * The PATCH entries needed to restore the managed ids to their snapshot
 * values — only ids that were managed, have a snapshot value, and currently
 * differ from it are included (idempotent re-delete after a crashed run).
 */
const restoreDelta = (
  managed: Partial<Record<string, boolean>>,
  initial: Record<string, boolean>,
  observed: readonly ObservedTransform[],
): { id: string; enabled: boolean }[] => {
  const current = snapshot(observed);
  const out: { id: string; enabled: boolean }[] = [];
  for (const id of Object.keys(managed)) {
    if (managed[id] === undefined) continue;
    const original = initial[id];
    if (original !== undefined && current[id] !== original) {
      out.push({ id, enabled: original });
    }
  }
  return out;
};

const toState = (t: ObservedTransform): ManagedTransformState => ({
  id: t.id,
  enabled: t.enabled,
  hasConflict: t.hasConflict,
  conflictsWith: t.conflictsWith == null ? undefined : [...t.conflictsWith],
});

const toAttributes = (
  zoneId: string,
  observed: ObservedTransforms,
  initialRequestHeaders: Record<string, boolean>,
  initialResponseHeaders: Record<string, boolean>,
): Attributes => ({
  zoneId,
  requestHeaders: observed.managedRequestHeaders.map(toState),
  responseHeaders: observed.managedResponseHeaders.map(toState),
  initialRequestHeaders,
  initialResponseHeaders,
});
