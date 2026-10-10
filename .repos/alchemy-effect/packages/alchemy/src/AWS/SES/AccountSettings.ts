import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { SuppressionListReason } from "./ConfigurationSet.ts";

/**
 * Whether an SES account feature is `ENABLED` or `DISABLED`.
 */
export type FeatureStatus = sesv2.FeatureStatus;

export interface AccountVdmSettings {
  /**
   * Whether Virtual Deliverability Manager (VDM) is enabled for the account.
   */
  enabled: FeatureStatus;
  /**
   * Whether the VDM dashboard's per-message engagement tracking (opens and
   * clicks) is enabled.
   */
  dashboardEngagementMetrics?: FeatureStatus;
  /**
   * Whether VDM Guardian's optimized shared delivery is enabled.
   */
  guardianOptimizedSharedDelivery?: FeatureStatus;
}

export interface AccountSuppressionSettings {
  /**
   * The bounce/complaint reasons for which SES adds destinations to the
   * account-level suppression list.
   *
   * Required: SES treats `putAccountSuppressionAttributes` with no reasons as
   * "suppress nothing", so an optional member would let `suppression: {}`
   * silently clear the account-wide list.
   */
  reasons: SuppressionListReason[];
}

export interface AccountSettingsProps {
  /**
   * Whether email sending is enabled for the whole account.
   *
   * :::caution
   * Setting this to `false` **stops all sending for the entire account**, not
   * just this stack's mail. Only manage it when you intend to pause account-wide
   * sending.
   * :::
   */
  sendingEnabled?: boolean;
  /**
   * Account-level suppression list configuration, applied via
   * `putAccountSuppressionAttributes`.
   */
  suppression?: AccountSuppressionSettings;
  /**
   * Virtual Deliverability Manager configuration, applied via
   * `putAccountVdmAttributes`.
   */
  vdm?: AccountVdmSettings;
}

export interface AccountSettings extends Resource<
  "AWS.SES.AccountSettings",
  AccountSettingsProps,
  {
    /** Whether email sending is enabled for the account. */
    sendingEnabled: boolean;
    /** Whether VDM is enabled for the account. */
    vdmEnabled: FeatureStatus;
    /** The account-level suppression reasons currently configured. */
    suppressedReasons: SuppressionListReason[];
  },
  never,
  Providers
> {}

/**
 * Account-level Amazon SES v2 settings — an account/region singleton that
 * manages account-wide sending status, the account suppression list, and
 * Virtual Deliverability Manager (VDM) configuration.
 *
 * Only the aspects you specify are managed: omit `sendingEnabled`, `suppression`,
 * or `vdm` to leave that setting untouched.
 *
 * Deleting this resource is a **no-op** — it leaves the account settings exactly
 * as they are. Unlike a normal resource there is nothing to tear down: these are
 * account-global toggles with no single safe default, and resetting them (e.g.
 * disabling sending or clearing the suppression list) would affect live mail
 * beyond this stack. Change the props and re-deploy to adjust them.
 * ### Configuring the Account
 * **Example:** Enable VDM with Engagement Tracking
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const settings = yield* SES.AccountSettings("Account", {
 *   vdm: {
 *     enabled: "ENABLED",
 *     dashboardEngagementMetrics: "ENABLED",
 *   },
 * });
 * ```
 *
 * **Example:** Configure the Suppression List
 * ```typescript
 * const settings = yield* SES.AccountSettings("Account", {
 *   suppression: { reasons: ["BOUNCE", "COMPLAINT"] },
 * });
 * ```
 *
 * **Example:** Enable Guardian Optimized Shared Delivery
 * ```typescript
 * const settings = yield* SES.AccountSettings("Account", {
 *   vdm: {
 *     enabled: "ENABLED",
 *     guardianOptimizedSharedDelivery: "ENABLED",
 *   },
 * });
 * ```
 *
 * ### Pausing Account-Wide Sending
 * **Example:** Stop All Sending for the Account
 * ```typescript
 * // WARNING: this halts every outbound email in the account, including mail
 * // sent by stacks and systems outside this one. Prefer a configuration
 * // set's sendingEnabled to pause a single sending path.
 * const settings = yield* SES.AccountSettings("Account", {
 *   sendingEnabled: false,
 * });
 * ```
 *
 * **Example:** Manage Only VDM and Leave Sending Alone
 * ```typescript
 * // Omitted aspects are never touched — this deploy will not read or write
 * // the account's sending status or suppression list.
 * const settings = yield* SES.AccountSettings("Account", {
 *   vdm: { enabled: "ENABLED" },
 * });
 * ```
 *
 * @resource
 */
export const AccountSettings = Resource<AccountSettings>(
  "AWS.SES.AccountSettings",
);

const sameReasons = (
  a: ReadonlyArray<SuppressionListReason> | undefined,
  b: ReadonlyArray<SuppressionListReason> | undefined,
): boolean => {
  const key = (reasons: ReadonlyArray<SuppressionListReason> | undefined) =>
    JSON.stringify([...(reasons ?? [])].sort());
  return key(a) === key(b);
};

export const AccountSettingsProvider = () =>
  Provider.effect(
    AccountSettings,
    Effect.gen(function* () {
      const observe = sesv2.getAccount({}).pipe(
        Effect.map((response) => ({
          sendingEnabled: response.SendingEnabled ?? false,
          vdmEnabled: response.VdmAttributes?.VdmEnabled ?? "DISABLED",
          // distilled types SuppressedReasons open (`| (string & {})`) so the
          // SDK survives new SES reasons. Narrow to the closed union the props
          // use, dropping anything we do not model, so attributes assign back
          // into props.
          suppressedReasons: (
            response.SuppressionAttributes?.SuppressedReasons ?? []
          ).filter(
            (reason): reason is SuppressionListReason =>
              reason === "BOUNCE" || reason === "COMPLAINT",
          ),
          dashboardEngagementMetrics:
            response.VdmAttributes?.DashboardAttributes?.EngagementMetrics,
          guardianOptimizedSharedDelivery:
            response.VdmAttributes?.GuardianAttributes?.OptimizedSharedDelivery,
        })),
      );

      const toAttrs = (observed: {
        sendingEnabled: boolean;
        vdmEnabled: FeatureStatus;
        suppressedReasons: SuppressionListReason[];
      }) => ({
        sendingEnabled: observed.sendingEnabled,
        vdmEnabled: observed.vdmEnabled,
        suppressedReasons: observed.suppressedReasons,
      });

      return AccountSettings.Provider.of({
        // Account-global singleton: nuke must not reset it.
        nuke: { singleton: true },
        stables: [],

        // The account settings always exist.
        list: Effect.fn(function* () {
          return [toAttrs(yield* observe)];
        }),

        read: Effect.fn(function* () {
          return toAttrs(yield* observe);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // OBSERVE the live account settings; only call each put on a real
          // delta for the aspects the caller actually manages.
          let observed = yield* observe;

          if (
            news.sendingEnabled !== undefined &&
            observed.sendingEnabled !== news.sendingEnabled
          ) {
            yield* sesv2.putAccountSendingAttributes({
              SendingEnabled: news.sendingEnabled,
            });
          }

          if (
            news.suppression !== undefined &&
            !sameReasons(observed.suppressedReasons, news.suppression.reasons)
          ) {
            yield* sesv2.putAccountSuppressionAttributes({
              SuppressedReasons: news.suppression.reasons,
            });
          }

          if (
            news.vdm !== undefined &&
            (observed.vdmEnabled !== news.vdm.enabled ||
              observed.dashboardEngagementMetrics !==
                news.vdm.dashboardEngagementMetrics ||
              observed.guardianOptimizedSharedDelivery !==
                news.vdm.guardianOptimizedSharedDelivery)
          ) {
            yield* sesv2.putAccountVdmAttributes({
              VdmAttributes: {
                VdmEnabled: news.vdm.enabled,
                DashboardAttributes:
                  news.vdm.dashboardEngagementMetrics !== undefined
                    ? { EngagementMetrics: news.vdm.dashboardEngagementMetrics }
                    : undefined,
                GuardianAttributes:
                  news.vdm.guardianOptimizedSharedDelivery !== undefined
                    ? {
                        OptimizedSharedDelivery:
                          news.vdm.guardianOptimizedSharedDelivery,
                      }
                    : undefined,
              },
            });
          }

          // Re-read so the returned attributes reflect the converged state.
          observed = yield* observe;
          yield* session.note(
            `sending=${observed.sendingEnabled} vdm=${observed.vdmEnabled}`,
          );
          return toAttrs(observed);
        }),

        // Account-global singleton: deleting only stops managing the settings.
        // We deliberately leave them in place — there is no single safe default
        // to reset to, and changing them would affect account-wide mail.
        delete: Effect.fn(function* () {}),
      });
    }),
  );
