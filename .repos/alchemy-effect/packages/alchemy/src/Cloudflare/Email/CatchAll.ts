import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type Reference } from "../Zone/index.ts";
import { listAllZones } from "../Zone/lookup.ts";
import type { Action } from "./Rule.ts";

const CatchAllTypeId = "Cloudflare.Email.CatchAll" as const;
type CatchAllTypeId = typeof CatchAllTypeId;

export type CatchAllProps = {
  /**
   * Zone whose catch-all rule to manage. Accepts a zone id, a zone name
   * (`example.com`), or a `{ zoneId, name? }` object. Stable — the
   * catch-all rule is a per-zone singleton, so changing the zone triggers
   * a replacement (the old zone's catch-all is restored to the state it
   * had before Alchemy managed it).
   */
  zone: Reference;
  /**
   * Display name for the catch-all rule. When omitted, the current name
   * on the rule is left untouched.
   */
  name?: string;
  /**
   * Whether the catch-all rule is active.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Actions to take for emails that match no other routing rule
   * (`drop`, `forward` to verified destination addresses, or `worker`).
   * Matchers are fixed to `[{ type: "all" }]` by the API.
   */
  actions: Action[];
};

export type CatchAllAttributes = {
  /** Routing rule identifier of the zone's catch-all rule. */
  ruleId: string;
  /** Zone the catch-all rule belongs to. */
  zoneId: string;
  /** Display name of the catch-all rule. */
  name: string;
  /** Whether the catch-all rule is active. */
  enabled: boolean;
  /** Actions taken for emails that match no other routing rule. */
  actions: Action[];
  /**
   * The name the catch-all rule had before Alchemy first managed it.
   * Restored on destroy.
   */
  initialName: string;
  /**
   * Whether the catch-all rule was enabled before Alchemy first managed
   * it. Restored on destroy.
   */
  initialEnabled: boolean;
  /**
   * The actions the catch-all rule had before Alchemy first managed it.
   * Restored on destroy.
   */
  initialActions: Action[];
};

export type CatchAll = Resource<
  CatchAllTypeId,
  CatchAllProps,
  CatchAllAttributes,
  never,
  Providers
>;

/**
 * The Cloudflare Email Routing catch-all rule for a zone.
 *
 * The catch-all rule handles every inbound email that no other routing
 * rule matched. It is a per-zone singleton — once Email Routing is enabled
 * the rule always exists (disabled, dropping mail, by default), so this
 * resource never creates or deletes anything physical. Reconcile `PUT`s the
 * desired configuration; destroy restores the configuration the rule had
 * before Alchemy first managed it.
 *
 * Email Routing must be enabled on the zone first (see
 * `Cloudflare.Email.Routing`), and `forward` actions require the destination
 * address to be verified (see `Cloudflare.Email.Address`).
 * @resource
 * @product Email
 * @category Email
 * @section Catching unmatched mail
 * @example Forward everything else to a verified destination
 * ```typescript
 * const routing = yield* Cloudflare.Email.Routing("Routing", {
 *   zone: "example.com",
 * });
 *
 * yield* Cloudflare.Email.CatchAll("CatchAll", {
 *   zone: routing.zoneId,
 *   actions: [{ type: "forward", value: ["ops@example.com"] }],
 * });
 * ```
 *
 * @example Silently drop unmatched mail
 * ```typescript
 * yield* Cloudflare.Email.CatchAll("DropTheRest", {
 *   zone: routing.zoneId,
 *   name: "drop unmatched",
 *   actions: [{ type: "drop" }],
 * });
 * ```
 *
 * @section Workers
 * @example Hand unmatched mail to an email Worker
 * ```typescript
 * yield* Cloudflare.Email.CatchAll("CatchAllWorker", {
 *   zone: routing.zoneId,
 *   actions: [{ type: "worker", value: ["my-email-worker"] }],
 * });
 * ```
 */
export const CatchAll = Resource<CatchAll>(CatchAllTypeId, {
  aliases: ["Cloudflare.EmailCatchAll"],
});

/**
 * Returns true if the given value is an CatchAll resource.
 */
export const isCatchAll = (value: unknown): value is CatchAll =>
  Predicate.hasProperty(value, "Type") && value.Type === CatchAllTypeId;

export const CatchAllProvider = () =>
  Provider.succeed(CatchAll, {
    nuke: { singleton: true },
    stables: [
      "ruleId",
      "zoneId",
      "initialName",
      "initialEnabled",
      "initialActions",
    ],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The catch-all rule is a per-zone singleton with no account-wide
      // enumeration API — enumerate every zone and read its rule. The
      // observed state at read time is the initial* baseline.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          emailRouting.getRuleCatchAll({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(zoneId, observed, observedInitial(observed)),
            ),
            // Zones without Email Routing enabled (or that the token can no
            // longer see) reject the route; skip them.
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is CatchAllAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!output) return undefined;
      if (!isResolved(news)) return undefined;
      const zoneId = yield* resolve(news.zone);
      if (zoneId !== output.zoneId) {
        // Different zone = different singleton.
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        // `olds.zone` may be `undefined` when a `creating` row was persisted
        // before upstream Outputs resolved — report "not found" then.
        output?.zoneId ??
        (olds?.zone !== undefined ? yield* resolve(olds.zone) : undefined);
      if (!zoneId) return undefined;
      const observed = yield* emailRouting.getRuleCatchAll({ zoneId }).pipe(
        // Zone deleted out-of-band (or the token can no longer see it) —
        // the catch-all rule is gone with it.
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      // The catch-all rule is a singleton that always exists once Email
      // Routing is enabled — there is nothing to "own", so a cold read
      // adopts freely (never `Unowned`). The observed state at adoption
      // time becomes the initial* baseline restored on destroy.
      const initial = output ?? observedInitial(observed);
      return toAttributes(zoneId, observed, initial);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // 1. Observe — the catch-all rule always exists once Email Routing
      //    is enabled on the zone; read its live state.
      const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
      const observed = yield* emailRouting.getRuleCatchAll({ zoneId });

      // 2. Capture — the pre-management state, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed state is
      //    the zone's original.
      const initial = output ?? observedInitial(observed);

      // 3. Sync — PUT only when the observed state differs from desired.
      const desiredEnabled = news.enabled ?? true;
      const desiredName = news.name ?? observed.name ?? "";
      if (
        (observed.enabled ?? false) === desiredEnabled &&
        (observed.name ?? "") === desiredName &&
        actionsEqual(normalizeActions(observed.actions), news.actions)
      ) {
        return toAttributes(zoneId, observed, initial);
      }
      const result = yield* emailRouting.putRuleCatchAll({
        zoneId,
        matchers: [{ type: "all" }],
        actions: news.actions.map((a) =>
          a.type === "drop"
            ? { type: a.type }
            : { type: a.type, value: a.value },
        ),
        enabled: desiredEnabled,
        name: desiredName,
      });
      return toAttributes(zoneId, result, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialName, initialEnabled, initialActions } = output;
      // Observe — if the zone itself is gone, so is the catch-all rule.
      const observed = yield* emailRouting
        .getRuleCatchAll({ zoneId })
        .pipe(Effect.catchTag("Forbidden", () => Effect.succeed(undefined)));
      if (observed === undefined) return;
      // Restore the pre-management state; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (
        (observed.enabled ?? false) === initialEnabled &&
        (observed.name ?? "") === initialName &&
        actionsEqual(normalizeActions(observed.actions), initialActions)
      ) {
        return;
      }
      yield* emailRouting
        .putRuleCatchAll({
          zoneId,
          matchers: [{ type: "all" }],
          actions: initialActions.map((a) =>
            a.type === "drop"
              ? { type: a.type }
              : { type: a.type, value: a.value },
          ),
          enabled: initialEnabled,
          name: initialName,
        })
        .pipe(
          Effect.catchTag("Forbidden", () => Effect.void),
          // The original forward destination may have been unverified or
          // removed since we captured it — fall back to the Cloudflare
          // default (disabled, drop) rather than failing the destroy.
          Effect.catchTag("DestinationNotVerified", () =>
            emailRouting
              .putRuleCatchAll({
                zoneId,
                matchers: [{ type: "all" }],
                actions: [{ type: "drop" }],
                enabled: false,
                name: initialName,
              })
              .pipe(Effect.catchTag("Forbidden", () => Effect.void)),
          ),
        );
    }),
  });

type ObservedCatchAll =
  | emailRouting.GetRuleCatchAllResponse
  | emailRouting.PutRuleCatchAllResponse;

const normalizeActions = (actions: ObservedCatchAll["actions"]): Action[] =>
  (actions ?? []).map(
    (a): Action =>
      a.type === "drop"
        ? { type: "drop" }
        : a.type === "forward"
          ? { type: "forward", value: [...(a.value ?? [])] }
          : { type: "worker", value: [...(a.value ?? [])] },
  );

const actionsEqual = (a: Action[], b: Action[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    if (x.type !== y.type) return false;
    const xv = x.type === "drop" ? [] : x.value;
    const yv = y.type === "drop" ? [] : y.value;
    return xv.length === yv.length && xv.every((v, j) => v === yv[j]);
  });

const observedInitial = (observed: ObservedCatchAll) => ({
  initialName: observed.name ?? "",
  initialEnabled: observed.enabled ?? false,
  initialActions: normalizeActions(observed.actions),
});

const toAttributes = (
  zoneId: string,
  observed: ObservedCatchAll,
  initial: {
    initialName: string;
    initialEnabled: boolean;
    initialActions: Action[];
  },
): CatchAllAttributes => ({
  ruleId: observed.id ?? "",
  zoneId,
  name: observed.name ?? "",
  enabled: observed.enabled ?? false,
  actions: normalizeActions(observed.actions),
  initialName: initial.initialName,
  initialEnabled: initial.initialEnabled,
  initialActions: initial.initialActions,
});

const resolve = Effect.fn(function* (zone: Reference) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* resolveZoneId({
    accountId,
    zone,
    hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
  });
});
