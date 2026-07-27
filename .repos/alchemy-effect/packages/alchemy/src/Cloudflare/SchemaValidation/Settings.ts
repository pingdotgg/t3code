import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.SchemaValidation.Settings" as const;
type TypeId = typeof TypeId;

/**
 * Mitigation action applied when a request does not conform to a schema:
 * `log` records the request, `block` denies it, `none` does nothing.
 */
export type MitigationAction = "none" | "log" | "block";

export interface SettingsProps {
  /**
   * Zone the settings belong to. Stable — changing the zone triggers a
   * replacement (the old zone's settings are restored to the values they
   * had before Alchemy managed them).
   */
  zoneId: string;
  /**
   * The default mitigation action used when a request does not conform to
   * an enabled schema: `log` records it, `block` denies it, `none` does
   * nothing. `log` and `block` may be plan-gated (API Shield entitlement).
   */
  validationDefaultMitigationAction: MitigationAction;
  /**
   * Zone-wide kill switch. When set to `"none"`, schema validation is
   * skipped entirely for every request, overriding both the zone default
   * and any per-operation settings. `null` clears the override.
   * @default null
   */
  validationOverrideMitigationAction?: "none" | null;
}

export interface SettingsAttributes {
  /** Zone the settings belong to. */
  zoneId: string;
  /** The default mitigation action for non-conforming requests. */
  validationDefaultMitigationAction: MitigationAction;
  /** The zone-wide override (`"none"` = validation disabled), if set. */
  validationOverrideMitigationAction: "none" | null;
  /**
   * The default action the zone had before Alchemy first managed these
   * settings. Restored on destroy.
   */
  initialDefaultMitigationAction: MitigationAction;
  /**
   * The override the zone had before Alchemy first managed these settings.
   * Restored on destroy.
   */
  initialOverrideMitigationAction: "none" | null;
}

export type Settings = Resource<
  TypeId,
  SettingsProps,
  SettingsAttributes,
  never,
  Providers
>;

/**
 * Zone-level schema validation settings
 * (`/zones/{zone_id}/schema_validation/settings`) — the default mitigation
 * action applied to requests that do not conform to an enabled schema, plus
 * an optional zone-wide kill switch.
 *
 * The settings are a zone singleton: they always exist (Cloudflare default
 * is `none`), so this resource never creates or deletes anything physical.
 * Reconcile PUTs the desired state when the observed state differs; destroy
 * restores the values the zone had before Alchemy first managed them.
 *
 * The `log` action is plan-gated (API Shield entitlement) on some zones —
 * setting it there fails with the typed `UnentitledMitigationAction` error.
 * @resource
 * @product Schema Validation
 * @category Application Security
 * @section Managing the zone default
 * @example Block non-conforming requests
 * ```typescript
 * yield* Cloudflare.SchemaValidation.Settings("Validation", {
 *   zoneId: zone.zoneId,
 *   validationDefaultMitigationAction: "block",
 * });
 * ```
 *
 * @section Kill switch
 * @example Temporarily disable validation zone-wide
 * ```typescript
 * yield* Cloudflare.SchemaValidation.Settings("Validation", {
 *   zoneId: zone.zoneId,
 *   validationDefaultMitigationAction: "block",
 *   // overrides every schema and per-operation setting:
 *   validationOverrideMitigationAction: "none",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/security/schema-validation/
 */
export const Settings = Resource<Settings>(TypeId);

/**
 * Returns true if the given value is a Settings resource.
 */
export const isSettings = (value: unknown): value is Settings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SettingsProvider = () =>
  Provider.succeed(Settings, {
    nuke: { singleton: true },
    stables: [
      "zoneId",
      "initialDefaultMitigationAction",
      "initialOverrideMitigationAction",
    ],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting (every zone has one,
      // defaulting to `none`).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          schemaValidation.getSetting({ zoneId }).pipe(
            // A cold read adopts freely; the observed state is the
            // initial state (nothing has been managed yet).
            Effect.map((observed) =>
              toAttributes(zoneId, observed, observedState(observed)),
            ),
            // A scoped token may lack access to some zones; skip them.
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is SettingsAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as SettingsProps;
      const n = news as SettingsProps;
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
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (zoneId === undefined) return undefined;
      const observed = yield* schemaValidation.getSetting({ zoneId });
      // The settings are a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts freely
      // (never `Unowned`). The observed values at adoption time become the
      // initial values restored on destroy.
      return toAttributes(
        zoneId,
        observed,
        output !== undefined
          ? {
              defaultAction: output.initialDefaultMitigationAction,
              overrideAction: output.initialOverrideMitigationAction,
            }
          : observedState(observed),
      );
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desired = {
        defaultAction: news.validationDefaultMitigationAction,
        overrideAction: news.validationOverrideMitigationAction ?? null,
      };

      // 1. Observe — the settings always exist; read the live state.
      const observed = yield* schemaValidation.getSetting({ zoneId });

      // 2. Capture — the pre-management values, restored on destroy.
      //    `output` (including an adoption read) already carries them;
      //    otherwise this is our first touch and the observed state is the
      //    zone's original.
      const initial =
        output !== undefined
          ? {
              defaultAction: output.initialDefaultMitigationAction,
              overrideAction: output.initialOverrideMitigationAction,
            }
          : observedState(observed);

      // 3. Sync — PUT the full desired state only when it differs.
      const current = observedState(observed);
      if (
        current.defaultAction === desired.defaultAction &&
        current.overrideAction === desired.overrideAction
      ) {
        return toAttributes(zoneId, observed, initial);
      }
      const updated = yield* schemaValidation.putSetting({
        zoneId,
        validationDefaultMitigationAction: desired.defaultAction,
        validationOverrideMitigationAction: desired.overrideAction,
      });
      return toAttributes(zoneId, updated, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const {
        zoneId,
        initialDefaultMitigationAction,
        initialOverrideMitigationAction,
      } = output;
      // The singleton cannot be deleted — restore the pre-management
      // state. Skip the call when it already matches (idempotent re-delete
      // after a crashed run).
      const observed = yield* schemaValidation.getSetting({ zoneId });
      const current = observedState(observed);
      if (
        current.defaultAction === initialDefaultMitigationAction &&
        current.overrideAction === initialOverrideMitigationAction
      ) {
        return;
      }
      yield* schemaValidation.putSetting({
        zoneId,
        validationDefaultMitigationAction: initialDefaultMitigationAction,
        validationOverrideMitigationAction: initialOverrideMitigationAction,
      });
      yield* Effect.logInfo(
        "Cloudflare schema validation settings are a zone singleton and cannot be deleted; restored the pre-management values instead.",
      );
    }),
  });

type SettingResponse =
  | schemaValidation.GetSettingResponse
  | schemaValidation.PutSettingResponse;

const observedState = (setting: SettingResponse) => ({
  // Distilled widens the generated enum to an open union (`string & {}`).
  defaultAction: setting.validationDefaultMitigationAction as MitigationAction,
  overrideAction: setting.validationOverrideMitigationAction ?? null,
});

const toAttributes = (
  zoneId: string,
  setting: SettingResponse,
  initial: {
    defaultAction: MitigationAction;
    overrideAction: "none" | null;
  },
): SettingsAttributes => {
  const current = observedState(setting);
  return {
    zoneId,
    validationDefaultMitigationAction: current.defaultAction,
    validationOverrideMitigationAction: current.overrideAction,
    initialDefaultMitigationAction: initial.defaultAction,
    initialOverrideMitigationAction: initial.overrideAction,
  };
};
