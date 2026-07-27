import * as cache from "@distilled.cloud/cloudflare/cache";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEquals } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Cache.Variants" as const;
type TypeId = typeof TypeId;

/**
 * The file extensions the Variants setting can configure. Each key maps to
 * the list of additional content types Cloudflare may serve (and cache) for
 * URLs ending in that extension, e.g. `jpeg: ["image/webp", "image/avif"]`.
 */
export interface VariantsValue {
  /** Additional content types to allow for `.avif` URLs. */
  avif?: string[];
  /** Additional content types to allow for `.bmp` URLs. */
  bmp?: string[];
  /** Additional content types to allow for `.gif` URLs. */
  gif?: string[];
  /** Additional content types to allow for `.jp2` URLs. */
  jp2?: string[];
  /** Additional content types to allow for `.jpeg` URLs. */
  jpeg?: string[];
  /** Additional content types to allow for `.jpg` URLs. */
  jpg?: string[];
  /** Additional content types to allow for `.jpg2` URLs. */
  jpg2?: string[];
  /** Additional content types to allow for `.png` URLs. */
  png?: string[];
  /** Additional content types to allow for `.tif` URLs. */
  tif?: string[];
  /** Additional content types to allow for `.tiff` URLs. */
  tiff?: string[];
  /** Additional content types to allow for `.webp` URLs. */
  webp?: string[];
}

export interface VariantsProps extends VariantsValue {
  /**
   * Zone whose Variants cache setting is managed. Stable — changing the
   * zone triggers a replacement (the old zone's setting is deleted, the
   * new zone's setting is created).
   */
  zoneId: string;
}

export interface VariantsAttributes {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** Resolved current value of the setting (per-extension content types). */
  value: VariantsValue;
  /**
   * Whether the setting can be modified on the zone's current plan
   * (`false` means the setting is plan-gated).
   */
  editable: boolean;
  /** When the setting was last modified, if Cloudflare reports it. */
  modifiedOn: string | undefined;
}

export type Variants = Resource<
  TypeId,
  VariantsProps,
  VariantsAttributes,
  never,
  Providers
>;

/**
 * The Variants cache setting of a Cloudflare zone
 * (`/zones/{zone_id}/cache/variants`).
 *
 * Variants lets a zone cache and serve multiple content types for the same
 * URL — e.g. serve `image/webp` to browsers that accept it for a `.jpeg`
 * URL — which is the setting behind "Serve WebP/AVIF to supported clients"
 * workflows (typically combined with an image-resizing origin or worker).
 *
 * Unlike most zone cache settings, Variants has true create/delete
 * semantics: the setting does not exist until it is first written
 * (reads return a typed `VariantsNotConfigured` error), and `DELETE`
 * removes it entirely, restoring the zone's default behavior. This
 * resource therefore creates the setting on first deploy and deletes it
 * on destroy.
 *
 * Only one `Variants` resource per zone makes sense — the setting is a
 * zone singleton, and two instances managing the same zone would fight
 * over it.
 * @resource
 * @product Cache
 * @category Performance & Reliability
 * @section Managing Variants
 * @example Serve WebP for JPEG URLs
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Cache.Variants("ImageVariants", {
 *   zoneId: zone.zoneId,
 *   jpeg: ["image/webp"],
 *   jpg: ["image/webp"],
 * });
 * ```
 *
 * @example Allow WebP and AVIF for all common image extensions
 * ```typescript
 * yield* Cloudflare.Cache.Variants("ImageVariants", {
 *   zoneId: zone.zoneId,
 *   jpeg: ["image/webp", "image/avif"],
 *   jpg: ["image/webp", "image/avif"],
 *   png: ["image/webp", "image/avif"],
 *   gif: ["image/webp", "image/avif"],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cache/advanced-configuration/variants/
 */
export const Variants = Resource<Variants>(TypeId);

/**
 * Returns true if the given value is a Variants resource.
 */
export const isVariants = (value: unknown): value is Variants =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/** The file-extension keys the Variants setting supports. */
const EXTENSION_KEYS = [
  "avif",
  "bmp",
  "gif",
  "jp2",
  "jpeg",
  "jpg",
  "jpg2",
  "png",
  "tif",
  "tiff",
  "webp",
] as const;

/**
 * Build the desired `value` object from props: only extensions with a
 * non-empty content-type list are sent (the PATCH replaces the full value,
 * so omitted keys are unset).
 */
const desiredValue = (props: VariantsProps): VariantsValue => {
  const value: VariantsValue = {};
  for (const key of EXTENSION_KEYS) {
    const types = props[key];
    if (types !== undefined && types.length > 0) {
      value[key] = [...types];
    }
  }
  return value;
};

/**
 * Normalize an observed `value` (whose entries may be `null` or readonly)
 * into the attribute shape: `null`/empty entries dropped, arrays copied.
 */
const normalizeValue = (
  observed: cache.GetVariantResponse["value"],
): VariantsValue => {
  const value: VariantsValue = {};
  for (const key of EXTENSION_KEYS) {
    const types = observed[key];
    if (types !== null && types !== undefined && types.length > 0) {
      value[key] = [...types];
    }
  }
  return value;
};

/** Deep-equality of two variants values (per-extension, order-sensitive). */
const valuesEqual = (a: VariantsValue, b: VariantsValue): boolean =>
  EXTENSION_KEYS.every((key) => arrayEquals(a[key], b[key]));

export const VariantsProvider = () =>
  Provider.succeed(Variants, {
    stables: ["zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this per-zone setting — enumerate every
      // zone in the account and read its variants setting. Unlike most
      // zone singletons, Variants has true create/delete semantics, so a
      // zone that never configured it returns `VariantsNotConfigured`;
      // those zones (and plan-gated / deleted zones) are skipped.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          cache.getVariant({ zoneId }).pipe(
            Effect.map((observed) => toAttributes(zoneId, observed)),
            // Setting never configured on this zone — nothing to enumerate.
            Effect.catchTag("VariantsNotConfigured", () =>
              Effect.succeed(undefined),
            ),
            // Plan-gated zones reject the setting (`Forbidden`, code 1135
            // "not available for your plan type") or the route entirely
            // (`InvalidRoute`); skip them.
            Effect.catchTag(["Forbidden", "InvalidRoute"], () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is VariantsAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as VariantsProps;
      const n = news as VariantsProps;
      // zoneId is Input<string>; compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
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
      if (!zoneId) return undefined;
      const observed = yield* cache.getVariant({ zoneId }).pipe(
        // The setting has never been written (or was deleted) — gone.
        Effect.catchTag("VariantsNotConfigured", () =>
          Effect.succeed(undefined),
        ),
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      // The setting is a zone singleton with no ownership tags — a cold
      // read adopts freely; reconcile converges it to the desired value.
      return toAttributes(zoneId, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the setting may not exist yet (typed 404).
      const observed = yield* cache
        .getVariant({ zoneId })
        .pipe(
          Effect.catchTag("VariantsNotConfigured", () =>
            Effect.succeed(undefined),
          ),
        );

      // 2. Sync — PATCH both creates and replaces the full value, so a
      //    single upsert call converges missing and divergent states.
      //    Skip the API entirely when the observed value already matches.
      const desired = desiredValue(news);
      if (
        observed !== undefined &&
        valuesEqual(normalizeValue(observed.value), desired)
      ) {
        return toAttributes(zoneId, observed);
      }
      const patched = yield* cache.patchVariant({ zoneId, value: desired });
      return toAttributes(zoneId, patched);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId } = output;
      // DELETE removes the setting; tolerate the already-gone cases so
      // re-delete after a crashed run (or an out-of-band zone delete)
      // succeeds idempotently.
      yield* cache.deleteVariant({ zoneId }).pipe(
        Effect.catchTag("VariantsNotConfigured", () => Effect.void),
        Effect.catchTag("InvalidRoute", () => Effect.void),
      );
    }),
  });

const toAttributes = (
  zoneId: string,
  setting: cache.GetVariantResponse | cache.PatchVariantResponse,
): VariantsAttributes => ({
  zoneId,
  value: normalizeValue(setting.value),
  editable: setting.editable,
  modifiedOn: setting.modifiedOn ?? undefined,
});
