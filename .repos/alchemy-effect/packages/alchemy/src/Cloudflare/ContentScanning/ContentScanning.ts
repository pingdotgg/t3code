import * as contentScanning from "@distilled.cloud/cloudflare/content-scanning";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ContentScanning.ContentScanning" as const;
type TypeId = typeof TypeId;

/** The wire status values Cloudflare uses for Content Scanning. */
type ContentScanningStatus = "enabled" | "disabled";

export interface Props {
  /**
   * Zone to manage WAF Content Scanning on. Stable — changing the zone
   * triggers a replacement (the old zone's status is restored to the
   * value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Content Scanning is enabled on the zone. Mutable — toggled
   * in place via the settings endpoint.
   *
   * Enabling requires the WAF Content Scanning Enterprise add-on;
   * without it Cloudflare rejects the call with the typed
   * `ContentScanningNotEntitled` error.
   *
   * @default true
   */
  enabled?: boolean;
}

export interface Attributes {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** Whether Content Scanning is currently enabled. */
  enabled: boolean;
  /** ISO 8601 timestamp of the last status modification, if reported. */
  modified: string | undefined;
  /**
   * The status (`enabled`/`disabled`) the zone had before Alchemy first
   * managed it. Restored on destroy, so deleting the resource puts the
   * zone back the way it was found.
   */
  initialValue: string;
}

export type ContentScanning = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * WAF Content Scanning (malicious uploads detection) on a Cloudflare zone —
 * the `/zones/{zone_id}/content-upload-scan/settings` singleton toggle.
 *
 * Content Scanning is a zone singleton: the setting always exists (default
 * `disabled`), so this resource never creates or deletes anything physical.
 * Reconcile PUTs the status only when the observed value differs from the
 * desired one; destroy restores the status the zone had before Alchemy
 * first managed it (captured as `initialValue`).
 *
 * Content Scanning is an Enterprise paid add-on. Reading the status works
 * on every plan, but enabling it on a zone without the add-on fails with
 * the typed `ContentScanningNotEntitled` error.
 * @resource
 * @product Content Scanning
 * @category Application Security
 * @section Enabling Content Scanning
 * @example Turn on malicious-upload scanning for a zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.ContentScanning.ContentScanning("UploadScanning", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Pin Content Scanning off
 * ```typescript
 * yield* Cloudflare.ContentScanning.ContentScanning("UploadScanning", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @section Custom scan expressions
 * @example Scan a JSON-embedded file field
 * ```typescript
 * const scanning = yield* Cloudflare.ContentScanning.ContentScanning("UploadScanning", {
 *   zoneId: zone.zoneId,
 * });
 *
 * yield* Cloudflare.ContentScanning.Expression("ScanJsonFile", {
 *   zoneId: scanning.zoneId,
 *   payload: 'lookup_json_string(http.request.body.raw, "file")',
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/detections/malicious-uploads/
 */
export const ContentScanning = Resource<ContentScanning>(TypeId, {
  aliases: ["Cloudflare.ContentScanning"],
});

/**
 * Returns true if the given value is a ContentScanning resource.
 */
export const isContentScanning = (value: unknown): value is ContentScanning =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ContentScanningProvider = () =>
  Provider.succeed(ContentScanning, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialValue"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its status (every zone has one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          contentScanning.getContentScanning({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(zoneId, observed, statusOf(observed)),
            ),
            // Plan-gated or partial zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is Attributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      // zoneId is Input<string>; compare only once both sides are concrete.
      if (!isResolved(news)) return undefined;
      const oldZoneId =
        output?.zoneId ??
        (olds !== undefined && isResolved(olds) ? olds.zoneId : undefined);
      if (oldZoneId !== undefined && oldZoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* contentScanning
        .getContentScanning({ zoneId })
        .pipe(
          // Zone deleted out-of-band — the setting is gone with it.
          Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
        );
      if (observed === undefined) return undefined;
      // The setting is a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts freely
      // (never `Unowned`). The observed status at adoption time becomes
      // the `initialValue` restored on destroy.
      const initialValue =
        output !== undefined ? output.initialValue : statusOf(observed);
      return toAttributes(zoneId, observed, initialValue);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the setting always exists; read its live status.
      const observed = yield* contentScanning.getContentScanning({ zoneId });

      // 2. Capture — the pre-management status, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed status is
      //    the zone's original.
      const initialValue =
        output !== undefined ? output.initialValue : statusOf(observed);

      // 3. Sync — PUT only when the observed status differs.
      const desired: ContentScanningStatus =
        news.enabled === false ? "disabled" : "enabled";
      if (statusOf(observed) === desired) {
        return toAttributes(zoneId, observed, initialValue);
      }
      const updated = yield* contentScanning.putContentScanning({
        zoneId,
        value: desired,
      });
      return toAttributes(zoneId, updated, initialValue);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialValue } = output;
      // Observe — if the zone itself is gone, so is the setting.
      const observed = yield* contentScanning
        .getContentScanning({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));
      if (observed === undefined) return;
      // Restore the pre-management status; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (statusOf(observed) === initialValue) return;
      yield* contentScanning
        .putContentScanning({ zoneId, value: initialValue })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

/**
 * Normalize the (nullable, open-typed) wire `value` to a concrete status.
 * Cloudflare's default for zones that have never touched the setting is
 * `disabled`.
 */
const statusOf = (
  setting:
    | contentScanning.GetContentScanningResponse
    | contentScanning.PutContentScanningResponse,
): ContentScanningStatus =>
  setting.value === "enabled" ? "enabled" : "disabled";

const toAttributes = (
  zoneId: string,
  setting:
    | contentScanning.GetContentScanningResponse
    | contentScanning.PutContentScanningResponse,
  initialValue: string,
): Attributes => ({
  zoneId,
  enabled: statusOf(setting) === "enabled",
  modified: setting.modified ?? undefined,
  initialValue,
});
