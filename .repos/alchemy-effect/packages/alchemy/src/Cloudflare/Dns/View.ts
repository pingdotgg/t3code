import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const DnsViewTypeId = "Cloudflare.DNS.View" as const;
type DnsViewTypeId = typeof DnsViewTypeId;

export interface ViewProps {
  /**
   * Name of the view. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   *
   * Mutable — patched in place.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Zones (by id) linked to this view. Internal DNS queries resolved
   * through the view consult these zones.
   *
   * Mutable — patched in place.
   */
  zones: string[];
}

export interface ViewAttributes {
  /** Identifier of the view. */
  viewId: string;
  /** The Cloudflare account the view belongs to. */
  accountId: string;
  /** Name of the view. */
  name: string;
  /** Zone ids linked to the view. */
  zones: string[];
  /** When the view was created. */
  createdTime: string;
  /** When the view was last modified. */
  modifiedTime: string;
}

export type View = Resource<
  DnsViewTypeId,
  ViewProps,
  ViewAttributes,
  never,
  Providers
>;

/**
 * An Internal DNS view (`/accounts/{account_id}/dns_settings/views`) —
 * a named set of internal zones that DNS queries can be resolved
 * against, for split-horizon / internal DNS setups.
 *
 * Requires the Enterprise Internal DNS entitlement on the account
 * (creation fails with `InternalDnsNotAvailable` otherwise). Both
 * `name` and `zones` are mutable in place.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Creating a View
 * @example View over internal zones
 * ```typescript
 * const view = yield* Cloudflare.DNS.View("Internal", {
 *   zones: [internalZone.zoneId],
 * });
 * ```
 *
 * @example View with an explicit name
 * ```typescript
 * const view = yield* Cloudflare.DNS.View("Internal", {
 *   name: "datacenter-east",
 *   zones: [zoneA.zoneId, zoneB.zoneId],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/internal-dns/
 */
export const View = Resource<View>(DnsViewTypeId, {
  aliases: ["Cloudflare.Dns.View"],
});

/**
 * Returns true if the given value is a View resource.
 */
export const isView = (value: unknown): value is View =>
  Predicate.hasProperty(value, "Type") && value.Type === DnsViewTypeId;

export const ViewProvider = () =>
  Provider.succeed(View, {
    stables: ["viewId", "accountId", "createdTime"],

    // Account collection — internal DNS views are enumerated per account
    // via the paginated list endpoint. Each item already carries the full
    // observed shape, so map straight into the `read` Attributes.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* dns.listSettingAccountViews.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((view) => toAttributes(view, accountId)),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.viewId) {
        const observed = yield* getView(acct, output.viewId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the
      // deterministic physical name. Views carry no ownership markers,
      // so gate takeover behind adoption.
      const name = yield* createViewName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? Unowned(toAttributes(match, acct)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createViewName(id, news.name);
      // Inputs are resolved to concrete values by Plan.
      const zones = news.zones as string[];

      // Observe — the id cached on `output` is a hint, not a guarantee.
      const observed = output?.viewId
        ? yield* getView(output.accountId ?? accountId, output.viewId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete). Names are not
        // unique, so there is no AlreadyExists race to tolerate.
        const created = yield* dns.createSettingAccountView({
          accountId,
          name,
          zones,
        });
        return toAttributes(created, accountId);
      }

      // Sync — patch only when the observed view differs.
      if (observed.name === name && sameZones(observed.zones, zones)) {
        return toAttributes(observed, output?.accountId ?? accountId);
      }
      const updated = yield* dns.patchSettingAccountView({
        accountId: output?.accountId ?? accountId,
        viewId: observed.id,
        name,
        zones,
      });
      return toAttributes(updated, output?.accountId ?? accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteSettingAccountView({
          accountId: output.accountId,
          viewId: output.viewId,
        })
        .pipe(Effect.catchTag("ViewNotFound", () => Effect.void));
    }),
  });

type ObservedView =
  | dns.GetSettingAccountViewResponse
  | dns.CreateSettingAccountViewResponse
  | dns.PatchSettingAccountViewResponse;

/** Read a view by id, mapping "gone" (code 1015) to `undefined`. */
const getView = (accountId: string, viewId: string) =>
  dns
    .getSettingAccountView({ accountId, viewId })
    .pipe(Effect.catchTag("ViewNotFound", () => Effect.succeed(undefined)));

/**
 * Find a view by exact name. The `name.exact` filter narrows
 * server-side; re-check exactly client-side and pick the oldest for
 * determinism.
 */
const findByName = (accountId: string, name: string) =>
  dns.listSettingAccountViews({ accountId, name: { exact: name } }).pipe(
    Effect.map((list) =>
      list.result
        .filter((v) => v.name === name)
        .sort((a, b) => a.createdTime.localeCompare(b.createdTime))
        .at(0),
    ),
  );

const createViewName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const sameZones = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  view: ObservedView,
  accountId: string,
): ViewAttributes => ({
  viewId: view.id,
  accountId,
  name: view.name,
  zones: [...view.zones],
  createdTime: view.createdTime,
  modifiedTime: view.modifiedTime,
});
