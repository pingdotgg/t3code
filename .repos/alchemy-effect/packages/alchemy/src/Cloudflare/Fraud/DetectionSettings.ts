import * as fraud from "@distilled.cloud/cloudflare/fraud";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Fraud.DetectionSettings" as const;
type TypeId = typeof TypeId;

/**
 * Criterion for classifying a login authentication outcome from the origin
 * response. Currently only status-code matching is supported.
 */
export interface AuthenticationCriteria {
  /**
   * How the origin response is matched. Only `"status_code"` is supported.
   */
  kind: "status_code";
  /**
   * HTTP status codes from the origin that satisfy this criterion
   * (e.g. `[200]` for success, `[401, 403]` for failure).
   */
  statusCodes?: number[];
}

/**
 * Configuration for classifying login authentication outcomes based on the
 * origin response. Requires `userProfiles` to be `"enabled"`.
 */
export interface AuthenticationSettings {
  /**
   * Origin responses that count as a successful authentication.
   */
  successCriteria?: AuthenticationCriteria;
  /**
   * Origin responses that count as a failed authentication.
   */
  failureCriteria?: AuthenticationCriteria;
}

/**
 * The writable fraud-detection settings of a zone. Only fields you
 * explicitly set are ever sent to Cloudflare — unset fields are left
 * untouched on the zone.
 */
export interface DetectionSettingsValues {
  /**
   * Whether Fraud User Profiles is enabled for the zone.
   *
   * Writing this field (even `"disabled"`) requires a fraud detection
   * subscription on the zone.
   * @default "disabled"
   */
  userProfiles?: "enabled" | "disabled";
  /**
   * Wirefilter expressions used to detect usernames in write HTTP
   * requests (maximum of 10). The full desired list is always sent, so
   * setting `[]` clears all expressions.
   */
  usernameExpressions?: string[];
  /**
   * Configuration for classifying login authentication outcomes based on
   * the origin response. Requires `userProfiles` to be `"enabled"`.
   */
  authenticationSettings?: AuthenticationSettings;
}

export interface DetectionSettingsProps extends DetectionSettingsValues {
  /**
   * Zone whose fraud-detection settings are managed. Stable — changing
   * the zone triggers a replacement (which re-adopts the new zone's
   * singleton and restores the old zone's snapshot).
   */
  zoneId: string;
}

export interface DetectionSettingsAttributes extends DetectionSettingsValues {
  /**
   * Zone that owns this fraud-detection configuration.
   */
  zoneId: string;
  /**
   * Snapshot of the writable settings observed **before** this resource
   * first wrote to the zone. `delete` restores these values for the
   * fields this resource managed.
   */
  initialSettings: DetectionSettingsValues;
}

export type DetectionSettings = Resource<
  TypeId,
  DetectionSettingsProps,
  DetectionSettingsAttributes,
  never,
  Providers
>;

/**
 * The fraud-detection (Fraud User Profiles) settings of a Cloudflare zone
 * (`/zones/{zone_id}/fraud_detection/settings`) — a zone-scoped
 * **singleton**: every zone always has exactly one fraud-detection
 * settings object, so there is no create or delete on the Cloudflare
 * side. Reconciling this resource adopts the singleton and PUTs only the
 * fields you explicitly set, leaving every other field untouched.
 *
 * Fraud Detection is a beta, subscription-gated product: writing
 * `userProfiles`, non-empty `usernameExpressions`, or
 * `authenticationSettings` fails with `FraudDetectionNotEntitled` unless
 * the zone has a fraud detection subscription.
 *
 * On destroy, the resource restores the fields it managed to the values
 * observed before its first write (the `initialSettings` snapshot).
 * Fields that were never set by this resource are not touched.
 * `authenticationSettings` that did not exist before the first write
 * cannot be cleared and are left as-is.
 * @resource
 * @product Fraud Detection
 * @category Application Security
 * @section Fraud User Profiles
 * @example Enable user profiles with a username expression
 * ```typescript
 * yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
 *   zoneId: zone.zoneId,
 *   userProfiles: "enabled",
 *   usernameExpressions: [
 *     'lookup_json_string(http.request.body.raw, "username")',
 *   ],
 * });
 * ```
 *
 * @section Authentication outcome classification
 * @example Classify login success and failure by origin status code
 * ```typescript
 * yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
 *   zoneId: zone.zoneId,
 *   userProfiles: "enabled",
 *   authenticationSettings: {
 *     successCriteria: { kind: "status_code", statusCodes: [200] },
 *     failureCriteria: { kind: "status_code", statusCodes: [401, 403] },
 *   },
 * });
 * ```
 *
 * @section Username expressions only
 * @example Clear all username expressions
 * ```typescript
 * yield* Cloudflare.Fraud.DetectionSettings("Fraud", {
 *   zoneId: zone.zoneId,
 *   usernameExpressions: [],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/bots/additional-configurations/fraud-detection/
 */
export const DetectionSettings = Resource<DetectionSettings>(TypeId, {
  aliases: ["Cloudflare.FraudDetectionSettings"],
});

/**
 * Returns true if the given value is a DetectionSettings resource.
 */
export const isDetectionSettings = (
  value: unknown,
): value is DetectionSettings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Every writable settings key, used to project observed cloud state and
 * user props into the only-send-what-is-set PUT body.
 */
const SETTINGS_KEYS = [
  "userProfiles",
  "usernameExpressions",
  "authenticationSettings",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

export const DetectionSettingsProvider = () =>
  Provider.succeed(DetectionSettings, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialSettings"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its settings (every live zone has
      // exactly one). `getFraud` only reads, so the entitlement gate
      // (which is on `putFraud`) never trips here.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          observe(zoneId).pipe(
            Effect.map((observed) =>
              observed === undefined
                ? undefined
                : toAttributes(zoneId, observed, pickSettings(observed)),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is DetectionSettingsAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // zoneId is Input<string>; compare only when both sides are concrete.
      const oldZone =
        output?.zoneId ??
        (olds !== undefined && typeof olds.zoneId === "string"
          ? olds.zoneId
          : undefined);
      if (oldZone !== undefined && oldZone !== news.zoneId) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      // The settings object is a singleton — it exists iff the zone exists.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* observe(zoneId);
      if (!observed) return undefined;
      // Singletons always exist with a Cloudflare default — there is
      // nothing to "own", so a cold read adopts freely (never `Unowned`).
      // The observed values at adoption time become the snapshot restored
      // on destroy.
      return toAttributes(
        zoneId,
        observed,
        output?.initialSettings ?? pickSettings(observed),
      );
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs are resolved to concrete strings by Plan.
      const zoneId = (output?.zoneId ?? news.zoneId) as string;

      // 1. Observe — the singleton always exists for a live zone.
      let observed: ObservedFraudSettings = yield* fraud.getFraud({ zoneId });

      // 2. Snapshot — capture pre-management values once; `output` acts
      //    as the cache that keeps the very first observation sticky.
      const initialSettings = output?.initialSettings ?? pickSettings(observed);

      // 3. Sync — diff observed against the fields the user set and PUT
      //    only when something actually differs. Unset fields are never
      //    sent (omit-means-unchanged on Cloudflare's side), and set
      //    fields are always sent in full (the API treats the expression
      //    list and each criteria object as whole values).
      const desired = pickSettings(news);
      if (!settingsEqual(desired, pickSettings(observed))) {
        observed = yield* fraud.putFraud({ zoneId, ...desired });
      }

      // 4. Return fresh attributes.
      return toAttributes(zoneId, observed, initialSettings);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      // Singleton — nothing to delete on the Cloudflare side. Restore the
      // fields this resource managed (i.e. the props that were set) to
      // their pre-management snapshot values. Fields whose snapshot value
      // is absent (e.g. authenticationSettings that never existed before
      // our first write) cannot be restored and are left as-is.
      const observed = yield* observe(output.zoneId);
      if (!observed) return; // zone is gone — nothing to restore
      const managed = pickSettings(olds ?? {});
      const current = pickSettings(observed);
      const restore: DetectionSettingsValues = {};
      for (const key of SETTINGS_KEYS) {
        const snapshot = output.initialSettings?.[key];
        if (
          managed[key] !== undefined &&
          snapshot !== undefined &&
          !deepEqual(current[key], snapshot)
        ) {
          (restore as Record<SettingsKey, unknown>)[key] = snapshot;
        }
      }
      if (Object.keys(restore).length > 0) {
        yield* fraud.putFraud({ zoneId: output.zoneId, ...restore }).pipe(
          // The zone lost its fraud detection subscription out-of-band —
          // the snapshot cannot be restored, but delete stays idempotent.
          Effect.catchTag("FraudDetectionNotEntitled", () => Effect.void),
        );
      }
    }),
  });

/**
 * The distilled responses type nested fields as nullable; widen to a flat
 * bag so observation code can normalize without per-field narrowing.
 */
type ObservedFraudSettings = fraud.GetFraudResponse | fraud.PutFraudResponse;

/**
 * Read the zone's fraud-detection settings, mapping a dead zone
 * (`InvalidRoute`, Cloudflare code 7003) to `undefined`.
 */
const observe = (zoneId: string) =>
  fraud
    .getFraud({ zoneId })
    .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const normalizeCriteria = (
  criteria:
    | { kind: "status_code"; statusCodes?: readonly number[] | null }
    | null
    | undefined,
): AuthenticationCriteria | undefined => {
  if (criteria == null) return undefined;
  const statusCodes = undef(criteria.statusCodes);
  return {
    kind: criteria.kind,
    ...(statusCodes !== undefined ? { statusCodes: [...statusCodes] } : {}),
  };
};

const normalizeAuthenticationSettings = (
  settings: ObservedFraudSettings["authenticationSettings"],
): AuthenticationSettings | undefined => {
  if (settings == null) return undefined;
  const successCriteria = normalizeCriteria(settings.successCriteria);
  const failureCriteria = normalizeCriteria(settings.failureCriteria);
  if (successCriteria === undefined && failureCriteria === undefined) {
    return undefined;
  }
  return {
    ...(successCriteria !== undefined ? { successCriteria } : {}),
    ...(failureCriteria !== undefined ? { failureCriteria } : {}),
  };
};

/**
 * Project any source (observed response, props, attrs) onto the writable
 * settings keys, dropping `null`/`undefined` values and normalizing
 * nested nullable fields.
 */
const pickSettings = (
  source: ObservedFraudSettings | DetectionSettingsValues,
): DetectionSettingsValues => {
  const out: DetectionSettingsValues = {};
  const userProfiles = undef(source.userProfiles);
  if (userProfiles === "enabled") {
    out.userProfiles = "enabled";
  } else if (userProfiles === "disabled") {
    out.userProfiles = "disabled";
  }
  const usernameExpressions = undef(source.usernameExpressions);
  if (usernameExpressions !== undefined) {
    out.usernameExpressions = [...usernameExpressions];
  }
  const authenticationSettings = normalizeAuthenticationSettings(
    source.authenticationSettings,
  );
  if (authenticationSettings !== undefined) {
    out.authenticationSettings = authenticationSettings;
  }
  return out;
};

/**
 * True when every field set in `desired` matches `observed`. Unset
 * desired fields are ignored — they are dashboard-managed.
 */
const settingsEqual = (
  desired: DetectionSettingsValues,
  observed: DetectionSettingsValues,
): boolean =>
  SETTINGS_KEYS.every(
    (key) =>
      desired[key] === undefined || deepEqual(desired[key], observed[key]),
  );

const toAttributes = (
  zoneId: string,
  observed: ObservedFraudSettings,
  initialSettings: DetectionSettingsValues,
): DetectionSettingsAttributes => ({
  zoneId,
  ...pickSettings(observed),
  initialSettings,
});
