import * as lcc from "@distilled.cloud/cloudflare/leaked-credential-checks";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.LeakedCredentialCheck.Detection" as const;
type TypeId = typeof TypeId;

export interface LeakedCredentialDetectionProps {
  /**
   * Zone the custom detection belongs to. Stable — moving a detection
   * between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * Ruleset expression locating the username in the request, e.g.
   * `lookup_json_string(http.request.body.raw, "user")`. Mutable —
   * updated in place via PUT. At least one of `username`/`password`
   * should be set.
   */
  username?: string;
  /**
   * Ruleset expression locating the password in the request, e.g.
   * `lookup_json_string(http.request.body.raw, "secret")`. This is an
   * expression over the request (not a secret value). Mutable — updated
   * in place via PUT.
   */
  password?: string;
}

export interface LeakedCredentialDetectionAttributes {
  /** Cloudflare-assigned identifier of the custom detection. */
  detectionId: string;
  /** Zone the detection belongs to. */
  zoneId: string;
  /** The username-locating ruleset expression, if set. */
  username: string | undefined;
  /** The password-locating ruleset expression, if set. */
  password: string | undefined;
}

export type LeakedCredentialDetection = Resource<
  TypeId,
  LeakedCredentialDetectionProps,
  LeakedCredentialDetectionAttributes,
  never,
  Providers
>;

/**
 * A custom detection location for Cloudflare Leaked Credential Checks
 * (`/zones/{zone_id}/leaked-credential-checks/detections`) — a pair of
 * ruleset expressions telling the WAF where to find the username and
 * password in your application's login requests, so credentials submitted
 * in non-standard payloads can still be checked against breach data.
 *
 * Requires Leaked Credential Checks to be **enabled** on the zone (see
 * {@link LeakedCredentialCheck}) — every detection operation fails with the
 * typed `LeakedCredentialChecksDisabled` error otherwise. The number of
 * custom detections is plan-gated (the free plan allows none — creation
 * fails with the typed `DetectionQuotaExceeded` error).
 *
 * Safety: detections carry no ownership markers. When there is no prior
 * state, `read` scans the zone for an existing detection with the same
 * expressions and reports it as `Unowned`, so the engine refuses to take
 * it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Leaked Credential Checks
 * @category Application Security
 * @section Custom detection locations
 * @example Detect credentials in a JSON login body
 * ```typescript
 * const check = yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
 *   zoneId: zone.zoneId,
 * });
 *
 * yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection("LoginBody", {
 *   // Reference the check's zoneId so the toggle deploys first.
 *   zoneId: check.zoneId,
 *   username: 'lookup_json_string(http.request.body.raw, "user")',
 *   password: 'lookup_json_string(http.request.body.raw, "secret")',
 * });
 * ```
 *
 * @example Username-only detection
 * ```typescript
 * yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialDetection("UsernameHeader",  {
 *   zoneId: check.zoneId,
 *   username: 'http.request.headers["x-username"][0]',
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/detections/leaked-credentials/#custom-detection-locations
 */
export const LeakedCredentialDetection =
  Resource<LeakedCredentialDetection>(TypeId);

/**
 * Returns true if the given value is a LeakedCredentialDetection resource.
 */
export const isLeakedCredentialDetection = (
  value: unknown,
): value is LeakedCredentialDetection =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const LeakedCredentialDetectionProvider = () =>
  Provider.succeed(LeakedCredentialDetection, {
    stables: ["detectionId", "zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Detections live inside a zone (`/zones/{id}/.../detections`) with
      // no account-wide enumeration API — fan out across every zone and
      // exhaustively paginate the per-zone list.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          lcc.listDetections.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map(
                  (d): LeakedCredentialDetectionAttributes =>
                    toAttributes(zone.id, d),
                ),
              ),
            ),
            // Zones without the LCC toggle on refuse all detection reads;
            // a freshly-minted scoped token can also 403 mid edge-
            // propagation. Either way the zone contributes nothing.
            Effect.catchTag(
              "LeakedCredentialChecksDisabled",
              (): Effect.Effect<LeakedCredentialDetectionAttributes[]> =>
                Effect.succeed([]),
            ),
            Effect.catchTag(
              "Forbidden",
              (): Effect.Effect<LeakedCredentialDetectionAttributes[]> =>
                Effect.succeed([]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as LeakedCredentialDetectionProps;
      const n = news as LeakedCredentialDetectionProps;
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

      // Owned path: refresh by our persisted detection id.
      if (output?.detectionId) {
        const observed = yield* getDetection(zoneId, output.detectionId);
        if (observed) return toAttributes(zoneId, observed);
      }

      // Adoption path: a detection with these expressions may already
      // exist on the zone. Detections carry no ownership markers, so we
      // cannot prove we created it — brand it `Unowned` so the engine
      // refuses to take over unless `adopt` is set.
      const username = output?.username ?? olds?.username;
      const password = output?.password ?? olds?.password;
      if (username !== undefined || password !== undefined) {
        const observed = yield* findByExpressions(zoneId, username, password);
        if (observed) return Unowned(toAttributes(zoneId, observed));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the detection id cached on `output` is a hint, not
      //    a guarantee: a missing detection falls through to the
      //    expression scan and then to create.
      let observed = output?.detectionId
        ? yield* getDetection(zoneId, output.detectionId)
        : undefined;

      // 2. Fall back to scanning the zone for an expression match.
      //    Ownership has already been verified upstream — `read` reports
      //    existing detections as `Unowned` and the engine gates takeover
      //    behind the adopt policy before reconcile ever runs.
      if (!observed) {
        observed = yield* findByExpressions(
          zoneId,
          news.username,
          news.password,
        );
      }

      // 3. Ensure — create when missing. Requires the zone's Leaked
      //    Credential Checks toggle to be on; otherwise this fails with
      //    the typed `LeakedCredentialChecksDisabled` error.
      if (!observed) {
        observed = yield* lcc.createDetection({
          zoneId,
          username: news.username,
          password: news.password,
        });
      }

      // 4. Sync — PUT only when the observed expressions differ.
      const dirty =
        (observed.username ?? undefined) !== news.username ||
        (observed.password ?? undefined) !== news.password;
      if (dirty) {
        observed = yield* lcc.updateDetection({
          zoneId,
          detectionId: observed.id ?? "",
          username: news.username,
          password: news.password,
        });
      }

      return toAttributes(zoneId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lcc
        .deleteDetection({
          zoneId: output.zoneId,
          detectionId: output.detectionId,
        })
        .pipe(
          // Already gone — idempotent re-delete after a crashed run.
          Effect.catchTag("DetectionNotFound", () => Effect.void),
          // The zone's toggle was switched off out-of-band; the API
          // refuses all detection operations then. The detection is
          // unreachable either way — treat as converged.
          Effect.catchTag("LeakedCredentialChecksDisabled", () => Effect.void),
        );
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type ObservedDetection = {
  id?: string | null;
  username?: string | null;
  password?: string | null;
};

/**
 * Read a detection by id, mapping "gone" (`DetectionNotFound`, Cloudflare
 * error code 11002) and "product off" (`LeakedCredentialChecksDisabled`,
 * code 11001 — the API refuses all detection reads while the zone toggle is
 * off) to `undefined`.
 */
const getDetection = (zoneId: string, detectionId: string) =>
  lcc.getDetection({ zoneId, detectionId }).pipe(
    Effect.map((d): ObservedDetection | undefined => d),
    Effect.catchTag("DetectionNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("LeakedCredentialChecksDisabled", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a detection by exact username+password expression pair within the
 * zone. Used for cold reads (state lost) and as the create fallback.
 */
const findByExpressions = (
  zoneId: string,
  username: string | undefined,
  password: string | undefined,
) =>
  lcc.listDetections.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (d): d is ObservedDetection =>
          (d.username ?? undefined) === username &&
          (d.password ?? undefined) === password,
      ),
    ),
    Effect.catchTag("LeakedCredentialChecksDisabled", () =>
      Effect.succeed(undefined),
    ),
  );

const toAttributes = (
  zoneId: string,
  detection: ObservedDetection,
): LeakedCredentialDetectionAttributes => ({
  detectionId: detection.id ?? "",
  zoneId,
  username: detection.username ?? undefined,
  password: detection.password ?? undefined,
});
