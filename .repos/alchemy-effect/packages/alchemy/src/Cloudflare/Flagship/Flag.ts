import * as flagship from "@distilled.cloud/cloudflare/flagship";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Flagship.Flag" as const;
type TypeId = typeof TypeId;

/**
 * Comparison operator applied to a targeting condition.
 */
export type FlagConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equals"
  | "less_than_or_equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in";

/**
 * A single targeting condition: either a flat attribute comparison or a
 * nested group of clauses combined with AND/OR.
 */
export type FlagCondition =
  | {
      /**
       * Evaluation-context attribute to match on (e.g. `country`, `userId`).
       */
      attribute: string;
      /**
       * Comparison operator.
       */
      operator: FlagConditionOperator;
      /**
       * Value to compare against.
       */
      value: unknown;
    }
  | {
      /**
       * Nested conditions combined with `logicalOperator`.
       */
      clauses: FlagCondition[];
      /**
       * How the clauses combine.
       */
      logicalOperator: "AND" | "OR";
    };

/**
 * Percentage rollout applied after a rule's conditions match.
 */
export type FlagRollout = {
  /**
   * Percentage of matching contexts served the rule's variation (0-100).
   */
  percentage: number;
  /**
   * Context attribute used for rollout bucketing.
   * @default the context's targeting key
   */
  attribute?: string;
};

/**
 * A targeting rule. Rules are evaluated in ascending `priority`; the first
 * matching rule wins.
 */
export type FlagRule = {
  /**
   * Conditions that must all match for the rule to apply.
   */
  conditions: FlagCondition[];
  /**
   * Evaluation order — lower runs first.
   */
  priority: number;
  /**
   * Variation (key in `variations`) served when the rule matches.
   */
  serveVariation: string;
  /**
   * Optional percentage rollout applied after the conditions match.
   */
  rollout?: FlagRollout;
};

/**
 * Value type of a flag's variations.
 */
export type FlagType = "boolean" | "string" | "number" | "json";

export type FlagProps = {
  /**
   * The Flagship app the flag belongs to. Changing the app triggers a
   * replacement.
   */
  appId: string;
  /**
   * Unique flag key within the app — used in all evaluation and SDK calls.
   * Changing the key triggers a replacement. If omitted, a unique key is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  key?: string;
  /**
   * When false, the flag bypasses all rules and always serves
   * `defaultVariation`.
   * @default true
   */
  enabled?: boolean;
  /**
   * Variation served when no rule matches or the flag is disabled. Must be a
   * key in `variations`.
   */
  defaultVariation: string;
  /**
   * Map of variation name to value. All values must be the same type
   * (boolean, string, number, or JSON object/array). Each serialized value
   * must be 10KB or smaller.
   */
  variations: Record<string, unknown>;
  /**
   * Targeting rules evaluated in ascending `priority`; the first matching
   * rule wins. An empty array means the flag always serves
   * `defaultVariation`.
   * @default []
   */
  rules?: FlagRule[];
  /**
   * Human readable description of the flag.
   */
  description?: string;
  /**
   * Value type of the flag's variations. Inferred from the variation values
   * on write, so it can usually be omitted.
   */
  type?: FlagType;
};

export type FlagAttributes = {
  /**
   * The Flagship app the flag belongs to.
   */
  appId: string;
  /**
   * The Cloudflare account the flag belongs to.
   */
  accountId: string;
  /**
   * Unique flag key within the app.
   */
  key: string;
  /**
   * Whether the flag's rules are evaluated.
   */
  enabled: boolean;
  /**
   * Variation served when no rule matches or the flag is disabled.
   */
  defaultVariation: string;
  /**
   * Map of variation name to value.
   */
  variations: Record<string, unknown>;
  /**
   * Targeting rules.
   */
  rules: FlagRule[];
  /**
   * Human readable description of the flag.
   */
  description: string | undefined;
  /**
   * Value type of the flag's variations, as inferred by Cloudflare.
   */
  type: FlagType | undefined;
  /**
   * When the flag was last modified.
   */
  updatedAt: string | undefined;
  /**
   * Email of the actor who last modified the flag, or `edge-gateway` for
   * gateway-authenticated changes.
   */
  updatedBy: string | undefined;
};

export type Flag = Resource<
  TypeId,
  FlagProps,
  FlagAttributes,
  never,
  Providers
>;

/**
 * A feature flag in a Cloudflare Flagship app.
 *
 * A flag maps a key to a set of variations plus targeting rules. Workers
 * evaluate flags through the `Flagship` binding (or the REST evaluate
 * endpoint); changing variations, rules, enablement, or the default
 * variation takes effect without redeploying code. Everything except the
 * flag key and the parent app is mutable in place.
 * @resource
 * @product Flagship
 * @category Developer Platform
 * @section Creating a Flag
 * @example Boolean flag
 * ```typescript
 * const app = yield* Cloudflare.Flagship.App("Flags", {});
 *
 * const flag = yield* Cloudflare.Flagship.Flag("NewCheckout", {
 *   appId: app.appId,
 *   key: "new-checkout",
 *   defaultVariation: "off",
 *   variations: { off: false, on: true },
 * });
 * ```
 *
 * @example String flag with multiple variations
 * ```typescript
 * const flag = yield* Cloudflare.Flagship.Flag("CheckoutFlow", {
 *   appId: app.appId,
 *   key: "checkout-flow",
 *   defaultVariation: "v1",
 *   variations: { v1: "classic", v2: "express", v3: "one-click" },
 * });
 * ```
 *
 * @section Targeting Rules
 * @example Serve a variation to a specific country
 * ```typescript
 * const flag = yield* Cloudflare.Flagship.Flag("DarkMode", {
 *   appId: app.appId,
 *   key: "dark-mode",
 *   defaultVariation: "off",
 *   variations: { off: false, on: true },
 *   rules: [
 *     {
 *       priority: 1,
 *       conditions: [
 *         { attribute: "country", operator: "equals", value: "US" },
 *       ],
 *       serveVariation: "on",
 *     },
 *   ],
 * });
 * ```
 *
 * @example Percentage rollout
 * ```typescript
 * const flag = yield* Cloudflare.Flagship.Flag("NewSearch", {
 *   appId: app.appId,
 *   key: "new-search",
 *   defaultVariation: "off",
 *   variations: { off: false, on: true },
 *   rules: [
 *     {
 *       priority: 1,
 *       conditions: [],
 *       serveVariation: "on",
 *       rollout: { percentage: 25 },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Toggling a Flag
 * @example Disable a flag without removing its rules
 * ```typescript
 * const flag = yield* Cloudflare.Flagship.Flag("NewCheckout", {
 *   appId: app.appId,
 *   key: "new-checkout",
 *   enabled: false,
 *   defaultVariation: "off",
 *   variations: { off: false, on: true },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/flagship/
 * @see https://developers.cloudflare.com/api/resources/flagship/
 */
export const Flag = Resource<Flag>(TypeId);

/**
 * Returns true if the given value is a Flagship Flag resource.
 */
export const isFlag = (value: unknown): value is Flag =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const FlagProvider = () =>
  Provider.succeed(Flag, {
    stables: ["appId", "accountId", "key"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The app is a path parameter — a flag cannot move between apps in
      // place. By diff time both sides are resolved strings.
      const oldAppId = output?.appId ?? olds?.appId;
      if (
        typeof oldAppId === "string" &&
        typeof news.appId === "string" &&
        oldAppId !== news.appId
      ) {
        return { action: "replace" } as const;
      }
      // The key is the flag's identity within the app.
      const oldKey = output?.key ?? olds?.key;
      if (
        typeof oldKey === "string" &&
        typeof news.key === "string" &&
        oldKey !== news.key
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const appId = output?.appId ?? (olds?.appId as string | undefined);
      if (appId === undefined) return undefined;

      // The key is deterministic (explicit or generated from the logical
      // ID), so a cold read and a warm read are the same lookup.
      const key = output?.key ?? (yield* createFlagKey(id, olds?.key));
      const observed = yield* getFlag(acct, appId, key);
      return observed ? toAttributes(observed, acct, appId) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const appId = news.appId as string;
      const key = yield* createFlagKey(id, news.key);
      const desired = {
        enabled: news.enabled ?? true,
        defaultVariation: news.defaultVariation,
        variations: news.variations,
        rules: news.rules ?? [],
        description: news.description,
      };

      // Observe — flag identity is (appId, key); a missing flag falls
      // through and we recreate.
      const observed = yield* getFlag(
        output?.accountId ?? accountId,
        appId,
        key,
      );

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete). A concurrent create
        // of the same key surfaces as FlagshipFlagAlreadyExists; treat it
        // as a race and converge via the update path below.
        const created = yield* flagship
          .createAppFlag({
            accountId,
            appId,
            key,
            ...desired,
            type: news.type,
          })
          .pipe(
            Effect.catchTag("FlagshipFlagAlreadyExists", () =>
              Effect.succeed(undefined),
            ),
          );
        if (created) {
          return toAttributes(created, accountId, appId);
        }
      }

      // Sync — diff observed cloud state against desired; the update API is
      // a PUT that takes the full body, so send everything, but skip the
      // call entirely on a no-op.
      const live = observed ?? (yield* getFlag(accountId, appId, key));
      if (live) {
        const observedShape = {
          enabled: live.enabled,
          defaultVariation: live.defaultVariation,
          variations: live.variations,
          rules: normalizeRules(live.rules),
          description: live.description ?? undefined,
        };
        const desiredShape = {
          ...desired,
          rules: normalizeRules(desired.rules),
        };
        if (deepEqual(observedShape, desiredShape)) {
          return toAttributes(live, accountId, appId);
        }
      }
      const updated = yield* flagship.updateAppFlag({
        accountId,
        appId,
        flagKey: key,
        key,
        ...desired,
        type: news.type,
      });
      return toAttributes(updated, accountId, appId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* flagship
        .deleteAppFlag({
          accountId: output.accountId,
          appId: output.appId,
          flagKey: output.key,
        })
        // A missing flag or a missing parent app both mean it's already
        // gone.
        .pipe(
          Effect.catchTag(
            ["FlagshipFlagNotFound", "FlagshipAppNotFound"],
            () => Effect.void,
          ),
        );
    }),
    // Flags are sub-resources keyed by (accountId, appId, key). There is no
    // account-wide flag enumeration, so enumerate every Flagship app first,
    // then fan out the per-app flag list and flatten.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const apps = yield* flagship.listApps.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.result ?? []),
        ),
      );
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          flagship.listAppFlags.pages({ accountId, appId: app.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((flag) =>
                  toAttributes(flag, accountId, app.id),
                ),
              ),
            ),
            // The parent app can be deleted between enumeration and the
            // per-app flag list; treat a gone app as having no flags.
            Effect.catchTag("FlagshipAppNotFound", () =>
              Effect.succeed<FlagAttributes[]>([]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

/**
 * Read a flag by key, mapping "gone" (`FlagshipFlagNotFound`, or a deleted
 * parent app surfacing as `FlagshipAppNotFound`) to `undefined`.
 */
const getFlag = (accountId: string, appId: string, flagKey: string) =>
  flagship
    .getAppFlag({ accountId, appId, flagKey })
    .pipe(
      Effect.catchTag(["FlagshipFlagNotFound", "FlagshipAppNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const createFlagKey = (id: string, key: string | undefined) =>
  Effect.gen(function* () {
    return key ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * Wire rules carry readonly markers, open-union widening, and explicit
 * nulls; strip them so rules diff structurally against the user's props.
 */
const normalizeRules = (rules: readonly WireRule[] | FlagRule[]): FlagRule[] =>
  rules.map((rule) => ({
    conditions: normalizeConditions(rule.conditions),
    priority: rule.priority,
    serveVariation: rule.serveVariation,
    ...(rule.rollout
      ? {
          rollout: {
            percentage: rule.rollout.percentage,
            ...(rule.rollout.attribute != null
              ? { attribute: rule.rollout.attribute }
              : {}),
          },
        }
      : {}),
  }));

type WireRule = {
  conditions: readonly unknown[];
  priority: number;
  serveVariation: string;
  rollout?: { percentage: number; attribute?: string | null } | null;
};

const normalizeConditions = (conditions: readonly unknown[]): FlagCondition[] =>
  conditions.flatMap((condition): FlagCondition[] => {
    if (Predicate.hasProperty(condition, "clauses")) {
      const group = condition as {
        clauses: readonly unknown[];
        logicalOperator: string;
      };
      return [
        {
          clauses: normalizeConditions(group.clauses),
          logicalOperator: group.logicalOperator as "AND" | "OR",
        },
      ];
    }
    if (Predicate.hasProperty(condition, "attribute")) {
      const flat = condition as {
        attribute: string;
        operator: string;
        value: unknown;
      };
      return [
        {
          attribute: flat.attribute,
          operator: flat.operator as FlagConditionOperator,
          value: flat.value,
        },
      ];
    }
    return [];
  });

const toAttributes = (
  flag:
    | flagship.GetAppFlagResponse
    | flagship.CreateAppFlagResponse
    | flagship.UpdateAppFlagResponse
    | flagship.ListAppFlagsResponse["result"][number],
  accountId: string,
  appId: string,
): FlagAttributes => ({
  appId,
  accountId,
  key: flag.key,
  enabled: flag.enabled,
  defaultVariation: flag.defaultVariation,
  variations: flag.variations,
  rules: normalizeRules(flag.rules),
  description: flag.description ?? undefined,
  type: (flag.type as FlagType | null | undefined) ?? undefined,
  updatedAt: flag.updatedAt ?? undefined,
  updatedBy: flag.updatedBy ?? undefined,
});
