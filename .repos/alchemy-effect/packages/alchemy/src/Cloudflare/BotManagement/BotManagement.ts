import * as botManagement from "@distilled.cloud/cloudflare/bot-management";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.BotManagement.BotManagement" as const;
type TypeId = typeof TypeId;

/**
 * Action for AI scrapers and crawlers.
 */
export type AiBotsProtection = "block" | "disabled" | "only_on_ad_pages";

/**
 * Robots Access Control License variant.
 */
export type CfRobotsVariant = "off" | "policy_only";

/**
 * Super Bot Fight Mode action for definitely / likely automated traffic.
 */
export type SbfmAction = "allow" | "block" | "managed_challenge";

/**
 * Super Bot Fight Mode action for verified bot traffic.
 */
export type SbfmVerifiedBotsAction = "allow" | "block";

/**
 * The writable bot-management settings. Which fields the Cloudflare API
 * accepts depends on the zone's plan:
 *
 * - **Free** — `fightMode` (Bot Fight Mode)
 * - **Pro** — `sbfmDefinitelyAutomated`, `sbfmVerifiedBots`,
 *   `sbfmStaticResourceProtection`, `optimizeWordpress`
 * - **Business / Enterprise (without the Bot Management add-on)** — Pro
 *   fields plus `sbfmLikelyAutomated`
 * - **Enterprise with Bot Management add-on** — `autoUpdateModel`,
 *   `bmCookieEnabled`, `suppressSessionScore`
 *
 * `aiBotsProtection`, `crawlerProtection`, `contentBotsProtection`,
 * `cfRobotsVariant`, `enableJs`, and `isRobotsTxtManaged` are shared
 * across plans (though some accounts reject writes to a subset of them).
 *
 * Only fields you explicitly set are ever sent to Cloudflare — sending a
 * field outside the zone's plan shape fails validation server-side.
 */
export interface Settings {
  /**
   * Action for AI scrapers and crawlers ("block AI bots"). Note
   * `only_on_ad_pages` is not available for Enterprise zones.
   */
  aiBotsProtection?: AiBotsProtection;
  /**
   * Punish AI scrapers and crawlers via a link maze (AI Labyrinth).
   */
  crawlerProtection?: "enabled" | "disabled";
  /**
   * Block content bots — automated traffic with low bot scores, excluding
   * safe verified bot categories.
   */
  contentBotsProtection?: "block" | "disabled";
  /**
   * Robots Access Control License variant to use.
   */
  cfRobotsVariant?: CfRobotsVariant;
  /**
   * Use lightweight, invisible JavaScript detections to improve Bot
   * Management.
   */
  enableJs?: boolean;
  /**
   * Serve a Cloudflare-managed robots.txt. If the origin already serves
   * one, the managed file is prepended to it.
   */
  isRobotsTxtManaged?: boolean;
  /**
   * Bot Fight Mode (Free-plan zones). Mutually exclusive with the SBFM
   * fields below.
   */
  fightMode?: boolean;
  /**
   * Super Bot Fight Mode action for definitely automated requests
   * (Pro and above).
   */
  sbfmDefinitelyAutomated?: SbfmAction;
  /**
   * Super Bot Fight Mode action for likely automated requests
   * (Business and above).
   */
  sbfmLikelyAutomated?: SbfmAction;
  /**
   * Super Bot Fight Mode action for verified bot requests (Pro and above).
   */
  sbfmVerifiedBots?: SbfmVerifiedBotsAction;
  /**
   * Super Bot Fight Mode static resource protection (Pro and above).
   * Enabling can challenge legitimate static-asset consumers.
   */
  sbfmStaticResourceProtection?: boolean;
  /**
   * Optimize Super Bot Fight Mode protections for WordPress
   * (Pro and above).
   */
  optimizeWordpress?: boolean;
  /**
   * Automatically update to the newest bot detection model (Enterprise
   * Bot Management add-on).
   */
  autoUpdateModel?: boolean;
  /**
   * Whether the bot management cookie may be placed on end-user devices
   * (Enterprise Bot Management add-on).
   * @default true
   */
  bmCookieEnabled?: boolean;
  /**
   * Disable tracking the highest bot score for a session in the Bot
   * Management cookie (Enterprise Bot Management add-on).
   * @default false
   */
  suppressSessionScore?: boolean;
}

export interface Props extends Settings {
  /**
   * Zone whose bot-management configuration is managed. Stable — changing
   * the zone triggers a replacement (which simply re-adopts the new
   * zone's singleton and restores the old zone's snapshot).
   */
  zoneId: string;
}

export interface Attributes extends Settings {
  /**
   * Zone that owns this bot-management configuration.
   */
  zoneId: string;
  /**
   * Whether the zone is running the latest ML model (read-only,
   * Enterprise Bot Management add-on).
   */
  usingLatestModel: boolean | undefined;
  /**
   * Snapshot of the writable settings observed **before** this resource
   * first wrote to the zone. `delete` restores these values for the
   * fields this resource managed.
   */
  initialSettings: Settings;
}

export type BotManagement = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * The bot-management configuration of a Cloudflare zone — a zone-scoped
 * **singleton**: every zone always has exactly one bot-management config,
 * so there is no create or delete on the Cloudflare side. Reconciling this
 * resource adopts the singleton and PUTs only the fields you explicitly
 * set, leaving every other field untouched.
 *
 * Which fields are writable depends on the zone's plan (see
 * {@link Settings}). Setting a field outside the zone's plan
 * shape fails validation on Cloudflare's side.
 *
 * On destroy, the resource restores the fields it managed to the values
 * observed before its first write (the `initialSettings` snapshot).
 * Fields that were never set by this resource are not touched. Settings
 * changed out-of-band after the snapshot was taken, or fields the zone's
 * plan no longer accepts, cannot be restored.
 * @resource
 * @product Bot Management
 * @category Application Security
 * @section Super Bot Fight Mode
 * @example Challenge definitely automated traffic (Pro and above)
 * ```typescript
 * yield* Cloudflare.BotManagement.BotManagement("Bots", {
 *   zoneId: zone.zoneId,
 *   sbfmDefinitelyAutomated: "managed_challenge",
 *   sbfmVerifiedBots: "allow",
 * });
 * ```
 *
 * @example Static resource protection and WordPress optimization
 * ```typescript
 * yield* Cloudflare.BotManagement.BotManagement("Bots", {
 *   zoneId: zone.zoneId,
 *   sbfmDefinitelyAutomated: "block",
 *   sbfmStaticResourceProtection: true,
 *   optimizeWordpress: true,
 * });
 * ```
 *
 * @section AI bot protection
 * @example Block AI scrapers and crawlers
 * ```typescript
 * yield* Cloudflare.BotManagement.BotManagement("Bots", {
 *   zoneId: zone.zoneId,
 *   aiBotsProtection: "block",
 *   crawlerProtection: "enabled",
 * });
 * ```
 *
 * @section Bot Fight Mode (Free plans)
 * @example Enable Bot Fight Mode
 * ```typescript
 * yield* Cloudflare.BotManagement.BotManagement("Bots", {
 *   zoneId: zone.zoneId,
 *   fightMode: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/bots/
 */
export const BotManagement = Resource<BotManagement>(TypeId, {
  aliases: ["Cloudflare.BotManagement"],
});

/**
 * Returns true if the given value is a BotManagement resource.
 */
export const isBotManagement = (value: unknown): value is BotManagement =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Every writable settings key, used to project observed cloud state and
 * user props into the only-send-what-is-set PUT body.
 */
const SETTINGS_KEYS = [
  "aiBotsProtection",
  "crawlerProtection",
  "contentBotsProtection",
  "cfRobotsVariant",
  "enableJs",
  "isRobotsTxtManaged",
  "fightMode",
  "sbfmDefinitelyAutomated",
  "sbfmLikelyAutomated",
  "sbfmVerifiedBots",
  "sbfmStaticResourceProtection",
  "optimizeWordpress",
  "autoUpdateModel",
  "bmCookieEnabled",
  "suppressSessionScore",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

export const BotManagementProvider = () =>
  Provider.succeed(BotManagement, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialSettings"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its bot-management config (every
      // live zone always has exactly one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          // `observe` maps a dead zone (`InvalidRoute`) to undefined; a
          // plan-gated zone forbids the read — skip both.
          observe(zoneId).pipe(
            Effect.map((observed) =>
              observed === undefined
                ? undefined
                : toAttributes(zoneId, observed, pickSettings(observed)),
            ),
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
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
      // The config is a singleton — it exists iff the zone exists.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* observe(zoneId);
      if (!observed) return undefined;
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
      let observed = yield* botManagement.getBotManagement({ zoneId });

      // 2. Snapshot — capture pre-management values once; `output` acts
      //    as the cache that keeps the very first observation sticky.
      const initialSettings = output?.initialSettings ?? pickSettings(observed);

      // 3. Sync — diff observed against the fields the user set and PUT
      //    only when something actually differs. Unset fields are never
      //    sent (plan-shape validation + don't clobber dashboard config).
      const desired = pickSettings(news);
      if (!settingsEqual(desired, pickSettings(observed))) {
        observed = yield* botManagement.putBotManagement({
          zoneId,
          ...desired,
        });
      }

      // 4. Return fresh attributes.
      return toAttributes(zoneId, observed, initialSettings);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      // Singleton — nothing to delete on the Cloudflare side. Restore the
      // fields this resource managed (i.e. the props that were set) to
      // their pre-management snapshot values. Fields whose snapshot value
      // is absent (the plan never exposed them, or Cloudflare returned
      // null) cannot be restored and are left as-is.
      const observed = yield* observe(output.zoneId);
      if (!observed) return; // zone is gone — nothing to restore
      const managed = pickSettings(olds ?? {});
      const current = pickSettings(observed);
      const restore: Settings = {};
      for (const key of SETTINGS_KEYS) {
        const snapshot = output.initialSettings?.[key];
        if (
          managed[key] !== undefined &&
          snapshot !== undefined &&
          current[key] !== snapshot
        ) {
          (restore as Record<SettingsKey, unknown>)[key] = snapshot;
        }
      }
      if (Object.keys(restore).length > 0) {
        yield* botManagement.putBotManagement({
          zoneId: output.zoneId,
          ...restore,
        });
      }
    }),
  });

/**
 * The distilled response is a 4-way union of plan shapes. Widen to a flat
 * bag of optional fields so observation code can read any field without
 * narrowing on the plan.
 */
interface ObservedBotManagement {
  readonly aiBotsProtection?: string | null;
  readonly crawlerProtection?: string | null;
  readonly contentBotsProtection?: string | null;
  readonly cfRobotsVariant?: string | null;
  readonly enableJs?: boolean | null;
  readonly isRobotsTxtManaged?: boolean | null;
  readonly fightMode?: boolean | null;
  readonly sbfmDefinitelyAutomated?: string | null;
  readonly sbfmLikelyAutomated?: string | null;
  readonly sbfmVerifiedBots?: string | null;
  readonly sbfmStaticResourceProtection?: boolean | null;
  readonly optimizeWordpress?: boolean | null;
  readonly autoUpdateModel?: boolean | null;
  readonly bmCookieEnabled?: boolean | null;
  readonly suppressSessionScore?: boolean | null;
  readonly usingLatestModel?: boolean | null;
}

/**
 * Read the zone's bot-management config, mapping a dead zone
 * (`InvalidRoute`, Cloudflare code 7003) to `undefined`.
 */
const observe = (zoneId: string) =>
  botManagement
    .getBotManagement({ zoneId })
    .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

/**
 * Project any source (observed union member, props, attrs) onto the
 * writable settings keys, dropping `null`/`undefined` values.
 */
const pickSettings = (source: ObservedBotManagement | Settings): Settings => {
  const bag = source as Record<SettingsKey, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const value = undef(bag[key]);
    if (value !== undefined) out[key] = value;
  }
  return out as Settings;
};

/**
 * True when every field set in `desired` matches `observed`. Unset
 * desired fields are ignored — they are dashboard/plan-managed.
 */
const settingsEqual = (desired: Settings, observed: Settings): boolean =>
  SETTINGS_KEYS.every(
    (key) => desired[key] === undefined || desired[key] === observed[key],
  );

const toAttributes = (
  zoneId: string,
  observed: ObservedBotManagement,
  initialSettings: Settings,
): Attributes => ({
  zoneId,
  ...pickSettings(observed),
  usingLatestModel: undef(observed.usingLatestModel),
  initialSettings,
});
