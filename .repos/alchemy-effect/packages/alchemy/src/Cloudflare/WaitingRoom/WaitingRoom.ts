import * as waitingRooms from "@distilled.cloud/cloudflare/waiting-rooms";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.WaitingRoom.WaitingRoom" as const;
type TypeId = typeof TypeId;

/**
 * Queueing method used by a waiting room. Changing this from the default
 * `fifo` requires the Waiting Room Advanced subscription.
 */
export type QueueingMethod = "fifo" | "random" | "passthrough" | "reject";

/**
 * HTTP status code returned to a user while in the queue.
 */
export type QueueingStatusCode = "200" | "202" | "429";

/**
 * Which Turnstile widget type the waiting room uses for detecting bot
 * traffic.
 */
export type TurnstileMode =
  | "off"
  | "invisible"
  | "visible_non_interactive"
  | "visible_managed";

/**
 * What to do when Turnstile detects a bot: `log` only records it in
 * analytics; `infinite_queue` sends the bot to a queue that never lets it
 * through.
 */
export type TurnstileAction = "log" | "infinite_queue";

/**
 * Cookie attributes for the waiting room cookie (`__cf_waitingroom`).
 */
export interface CookieAttributes {
  /**
   * SameSite attribute of the waiting room cookie.
   * @default "auto"
   */
  samesite?: "auto" | "lax" | "none" | "strict";
  /**
   * Secure attribute of the waiting room cookie.
   * @default "auto"
   */
  secure?: "auto" | "always" | "never";
}

/**
 * An additional hostname + path combination the waiting room is applied to.
 * Only available with the Waiting Room Advanced subscription.
 */
export interface Route {
  /**
   * Hostname (no scheme, no wildcards).
   */
  host?: string;
  /**
   * Path within the host. There is an implied wildcard at the end.
   * @default "/"
   */
  path?: string;
}

export interface Props {
  /**
   * Zone the waiting room belongs to. Stable — changing the zone triggers
   * a replacement.
   */
  zoneId: string;
  /**
   * A unique name to identify the waiting room. Only alphanumeric
   * characters, hyphens, and underscores are allowed. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Mutable.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The host name to which the waiting room will be applied (no
   * wildcards). Do not include the scheme. The host and path combination
   * must be unique per zone. Mutable.
   */
  host: string;
  /**
   * The path within the host to enable the waiting room on, including all
   * subpaths. Mutable.
   * @default "/"
   */
  path?: string;
  /**
   * Total number of active user sessions on the route at a point in time
   * (minimum 200). Mutable.
   */
  totalActiveUsers: number;
  /**
   * Number of new users that will be let into the route every minute
   * (minimum 200). Mutable.
   */
  newUsersPerMinute: number;
  /**
   * A note with more details about the waiting room. Mutable.
   * @default ""
   */
  description?: string;
  /**
   * Lifetime of a cookie (in minutes, 1–30) set for users who get access
   * to the route. Mutable.
   * @default 5
   */
  sessionDuration?: number;
  /**
   * Disables automatic renewal of session cookies (Waiting Room Advanced
   * only). Mutable.
   * @default false
   */
  disableSessionRenewal?: boolean;
  /**
   * If `true`, all traffic to the route is sent to the waiting room.
   * Mutable.
   * @default false
   */
  queueAll?: boolean;
  /**
   * Queueing method. Non-`fifo` methods require the Waiting Room Advanced
   * subscription. Mutable.
   * @default "fifo"
   */
  queueingMethod?: QueueingMethod;
  /**
   * HTTP status code returned to a user while in the queue. Mutable.
   * @default "200"
   */
  queueingStatusCode?: QueueingStatusCode;
  /**
   * Suspends the waiting room — traffic flows straight to the route.
   * Mutable.
   * @default false
   */
  suspended?: boolean;
  /**
   * If `true`, requests with `Accept: application/json` receive a JSON
   * response describing the queue (Waiting Room Advanced only). Mutable.
   * @default false
   */
  jsonResponseEnabled?: boolean;
  /**
   * Custom HTML template rendered at the edge instead of the default
   * waiting room page (Waiting Room Advanced only). Mutable.
   */
  customPageHtml?: string;
  /**
   * Language of the default page template. Mutable.
   * @default "en-US"
   */
  defaultTemplateLanguage?: string;
  /**
   * Appends `_` + this suffix to the waiting room cookie name. Mutable.
   */
  cookieSuffix?: string;
  /**
   * Cookie attributes for the waiting room cookie. Mutable.
   */
  cookieAttributes?: CookieAttributes;
  /**
   * Additional hostname/path combinations the waiting room applies to
   * (Waiting Room Advanced only). Mutable.
   */
  additionalRoutes?: Route[];
  /**
   * Enabled origin commands (currently only `revoke`). Mutable.
   * @default []
   */
  enabledOriginCommands?: "revoke"[];
  /**
   * Turnstile widget type used for detecting bot traffic. Mutable.
   * @default "off"
   */
  turnstileMode?: TurnstileMode;
  /**
   * Action taken when Turnstile detects a bot. Mutable.
   * @default "log"
   */
  turnstileAction?: TurnstileAction;
}

export interface Attributes {
  /** Cloudflare-assigned identifier of the waiting room. */
  waitingRoomId: string;
  /** Zone the waiting room belongs to. */
  zoneId: string;
  /** The waiting room's unique name. */
  name: string;
  /** Host the waiting room is applied to. */
  host: string;
  /** Path within the host the waiting room is enabled on. */
  path: string;
  /** Total number of active user sessions allowed on the route. */
  totalActiveUsers: number;
  /** Number of new users let into the route per minute. */
  newUsersPerMinute: number;
  /** Note describing the waiting room. */
  description: string;
  /** Session cookie lifetime in minutes. */
  sessionDuration: number;
  /** Whether all traffic is sent to the waiting room. */
  queueAll: boolean;
  /** Queueing method in effect. */
  queueingMethod: QueueingMethod;
  /** HTTP status code returned to queued users. */
  queueingStatusCode: QueueingStatusCode;
  /** Whether the waiting room is suspended. */
  suspended: boolean;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type WaitingRoom = Resource<TypeId, Props, Attributes, never, Providers>;

/**
 * A Cloudflare Waiting Room — places visitors in a virtual queue when
 * traffic to a host + path exceeds the configured thresholds, protecting
 * the origin from overload.
 *
 * Waiting Rooms require a Business or Enterprise zone plan; on unentitled
 * zones every write fails with the typed `ZoneNotEntitled` error
 * (Cloudflare code 1034). Several props (`additionalRoutes`,
 * `customPageHtml`, non-`fifo` `queueingMethod`, `disableSessionRenewal`,
 * `jsonResponseEnabled`) additionally require the Waiting Room Advanced
 * subscription.
 *
 * Everything except the zone is mutable in place via a full-body PUT.
 * Waiting rooms carry no ownership markers, so when state is lost `read`
 * matches by name and reports the room as `Unowned` — the engine refuses
 * to take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Waiting Rooms
 * @category Performance & Reliability
 * @section Creating a Waiting Room
 * @example Basic waiting room on a host
 * ```typescript
 * const room = yield* Cloudflare.WaitingRoom.WaitingRoom("checkout", {
 *   zoneId: zone.zoneId,
 *   host: "shop.example.com",
 *   path: "/checkout",
 *   totalActiveUsers: 200,
 *   newUsersPerMinute: 200,
 * });
 * ```
 *
 * @example Queue all traffic during an incident
 * ```typescript
 * yield* Cloudflare.WaitingRoom.WaitingRoom("incident-gate", {
 *   zoneId: zone.zoneId,
 *   host: "example.com",
 *   totalActiveUsers: 500,
 *   newUsersPerMinute: 200,
 *   queueAll: true,
 *   queueingStatusCode: "429",
 * });
 * ```
 *
 * @section Customizing behavior
 * @example Short sessions with a custom cookie suffix
 * ```typescript
 * yield* Cloudflare.WaitingRoom.WaitingRoom("flash-sale", {
 *   zoneId: zone.zoneId,
 *   host: "example.com",
 *   path: "/sale",
 *   totalActiveUsers: 1000,
 *   newUsersPerMinute: 500,
 *   sessionDuration: 1,
 *   cookieSuffix: "sale",
 *   defaultTemplateLanguage: "de-DE",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waiting-room/
 */
export const WaitingRoom = Resource<WaitingRoom>(TypeId, {
  aliases: ["Cloudflare.WaitingRoom"],
});

/**
 * Returns true if the given value is a WaitingRoom resource.
 */
export const isWaitingRoom = (value: unknown): value is WaitingRoom =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WaitingRoomProvider = () =>
  Provider.succeed(WaitingRoom, {
    stables: ["waitingRoomId", "zoneId", "createdOn"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as Props;
      const n = news as Props;
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

    read: Effect.fn(function* ({ id, output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;

      // Owned path: refresh by our persisted waiting room id.
      if (output?.waitingRoomId) {
        const observed = yield* getRoom(zoneId, output.waitingRoomId);
        if (observed) return toAttributes(observed, zoneId);
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical name. Waiting rooms carry no ownership markers, so report
      // the match as `Unowned` and let the adopt policy gate takeover.
      const name = yield* createRoomName(id, olds?.name);
      const match = yield* findByName(zoneId, name);
      if (match) return Unowned(toAttributes(match, zoneId));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const name = yield* createRoomName(id, news.name);

      // 1. Observe — the id cached on `output` is a hint, not a guarantee:
      //    a missing room falls through to the name scan and then to create.
      let observed = output?.waitingRoomId
        ? yield* getRoom(zoneId, output.waitingRoomId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(zoneId, name);
      }

      // 2. Ensure — create with the full desired body when missing.
      if (!observed) {
        const created = yield* waitingRooms.createWaitingRoom({
          zoneId,
          name,
          ...desiredBody(news),
        });
        return toAttributes(created, zoneId);
      }

      // 3. Sync — the update API is a full-body PUT; diff observed cloud
      //    state against the desired body and skip the call on a no-op.
      const desired = desiredBody(news);
      if (!isDirty(observed, name, desired)) {
        return toAttributes(observed, zoneId);
      }
      const updated = yield* waitingRooms.updateWaitingRoom({
        zoneId,
        waitingRoomId: observed.id as string,
        name,
        ...desired,
      });
      return toAttributes(updated, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* waitingRooms
        .deleteWaitingRoom({
          zoneId: output.zoneId,
          waitingRoomId: output.waitingRoomId,
        })
        .pipe(
          // Already gone (code 1001) — deletion is idempotent.
          Effect.catchTag("WaitingRoomNotFound", () => Effect.void),
          // Zone deleted out-of-band — the room is gone with it.
          Effect.catchTag("InvalidRoute", () => Effect.void),
        );
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Waiting rooms live inside a zone with no account-wide enumeration
      // API — fan out across every zone and list rooms per zone, then
      // exhaustively paginate each.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          waitingRooms.listWaitingRoomsForZone.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((room) => toAttributes(room, zone.id)),
              ),
            ),
            // Plan-gated / partial-permission zones reject the route, and a
            // zone deleted out-of-band has no rooms; skip both.
            Effect.catchTag("Forbidden", () =>
              Effect.succeed([] as Attributes[]),
            ),
            Effect.catchTag("InvalidRoute", () =>
              Effect.succeed([] as Attributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

type ObservedRoom = waitingRooms.GetWaitingRoomResponse;

/**
 * Read a waiting room by id, mapping "gone" (`WaitingRoomNotFound`,
 * Cloudflare code 1001) and a deleted zone (`InvalidRoute`, code 7003) to
 * `undefined`.
 */
const getRoom = (zoneId: string, waitingRoomId: string) =>
  waitingRooms.getWaitingRoom({ zoneId, waitingRoomId }).pipe(
    Effect.map((room): ObservedRoom | undefined => room),
    Effect.catchTag("WaitingRoomNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );

/**
 * Find a waiting room by exact name. Names are unique per zone, so at most
 * one room can match.
 */
const findByName = (zoneId: string, name: string) =>
  waitingRooms.listWaitingRoomsForZone.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (room): room is ObservedRoom => room.name === name,
      ),
    ),
    // Zone deleted out-of-band — nothing to find.
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );

/**
 * Waiting room names only allow alphanumerics, hyphens, and underscores.
 */
const createRoomName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * The full desired body sent on create and PUT update. Optional props are
 * omitted when unspecified so Cloudflare applies (or resets to) its
 * defaults — sending Advanced-only fields explicitly would fail on
 * non-Advanced plans.
 */
const desiredBody = (news: Props) => ({
  host: news.host,
  totalActiveUsers: news.totalActiveUsers,
  newUsersPerMinute: news.newUsersPerMinute,
  path: news.path,
  description: news.description,
  sessionDuration: news.sessionDuration,
  disableSessionRenewal: news.disableSessionRenewal,
  queueAll: news.queueAll,
  queueingMethod: news.queueingMethod,
  queueingStatusCode: news.queueingStatusCode,
  suspended: news.suspended,
  jsonResponseEnabled: news.jsonResponseEnabled,
  customPageHtml: news.customPageHtml,
  defaultTemplateLanguage:
    news.defaultTemplateLanguage as waitingRooms.UpdateWaitingRoomRequest["defaultTemplateLanguage"],
  cookieSuffix: news.cookieSuffix,
  cookieAttributes: news.cookieAttributes,
  additionalRoutes: news.additionalRoutes,
  enabledOriginCommands: news.enabledOriginCommands,
  turnstileMode: news.turnstileMode,
  turnstileAction: news.turnstileAction,
});

/**
 * Cloudflare defaults for props with a documented default — used so that a
 * prop the user removed from the program converges back to the default.
 */
const DEFAULTS = {
  path: "/",
  description: "",
  sessionDuration: 5,
  disableSessionRenewal: false,
  queueAll: false,
  queueingMethod: "fifo",
  queueingStatusCode: "200",
  suspended: false,
  jsonResponseEnabled: false,
  defaultTemplateLanguage: "en-US",
  turnstileMode: "off",
  turnstileAction: "log",
} as const;

/**
 * Compare the observed room against the desired body. Props with a known
 * default compare against the default when unspecified (so removals
 * converge); props without one (cookieSuffix, customPageHtml, Advanced
 * structures) only count when explicitly specified.
 */
const isDirty = (
  observed: ObservedRoom,
  name: string,
  desired: ReturnType<typeof desiredBody>,
): boolean => {
  if ((observed.name ?? "") !== name) return true;
  if ((observed.host ?? "") !== desired.host) return true;
  if (observed.totalActiveUsers !== desired.totalActiveUsers) return true;
  if (observed.newUsersPerMinute !== desired.newUsersPerMinute) return true;

  const defaulted = <K extends keyof typeof DEFAULTS>(
    key: K,
    observedValue: unknown,
  ): boolean => {
    const want = desired[key as keyof typeof desired] ?? DEFAULTS[key];
    return (observedValue ?? DEFAULTS[key]) !== want;
  };
  if (defaulted("path", observed.path)) return true;
  if (defaulted("description", observed.description)) return true;
  if (defaulted("sessionDuration", observed.sessionDuration)) return true;
  if (defaulted("disableSessionRenewal", observed.disableSessionRenewal)) {
    return true;
  }
  if (defaulted("queueAll", observed.queueAll)) return true;
  if (defaulted("queueingMethod", observed.queueingMethod)) return true;
  if (defaulted("queueingStatusCode", observed.queueingStatusCode)) {
    return true;
  }
  if (defaulted("suspended", observed.suspended)) return true;
  if (defaulted("jsonResponseEnabled", observed.jsonResponseEnabled)) {
    return true;
  }
  if (defaulted("defaultTemplateLanguage", observed.defaultTemplateLanguage)) {
    return true;
  }
  if (defaulted("turnstileMode", observed.turnstileMode)) return true;
  if (defaulted("turnstileAction", observed.turnstileAction)) return true;

  // Only-when-specified props (no reliable server default to reset to).
  if (
    desired.cookieSuffix !== undefined &&
    (observed.cookieSuffix ?? "") !== desired.cookieSuffix
  ) {
    return true;
  }
  if (
    desired.customPageHtml !== undefined &&
    (observed.customPageHtml ?? "") !== desired.customPageHtml
  ) {
    return true;
  }
  if (desired.cookieAttributes !== undefined) {
    const o = observed.cookieAttributes ?? {};
    if (
      (o.samesite ?? "auto") !== (desired.cookieAttributes.samesite ?? "auto")
    ) {
      return true;
    }
    if ((o.secure ?? "auto") !== (desired.cookieAttributes.secure ?? "auto")) {
      return true;
    }
  }
  if (desired.additionalRoutes !== undefined) {
    const o = observed.additionalRoutes ?? [];
    const d = desired.additionalRoutes;
    if (
      o.length !== d.length ||
      o.some(
        (route, i) =>
          (route.host ?? "") !== (d[i]?.host ?? "") ||
          (route.path ?? "/") !== (d[i]?.path ?? "/"),
      )
    ) {
      return true;
    }
  }
  if (desired.enabledOriginCommands !== undefined) {
    const o = observed.enabledOriginCommands ?? [];
    const d = desired.enabledOriginCommands;
    if (o.length !== d.length || o.some((c, i) => c !== d[i])) return true;
  }
  return false;
};

const toAttributes = (
  room:
    | waitingRooms.GetWaitingRoomResponse
    | waitingRooms.CreateWaitingRoomResponse
    | waitingRooms.UpdateWaitingRoomResponse
    | waitingRooms.ListWaitingRoomsResponse["result"][number],
  zoneId: string,
): Attributes => ({
  // Cloudflare always echoes an id for a persisted room; distilled types it
  // optional/nullable.
  waitingRoomId: room.id ?? "",
  zoneId,
  name: room.name ?? "",
  host: room.host ?? "",
  path: room.path ?? "/",
  totalActiveUsers: room.totalActiveUsers ?? 0,
  newUsersPerMinute: room.newUsersPerMinute ?? 0,
  description: room.description ?? "",
  sessionDuration: room.sessionDuration ?? 5,
  queueAll: room.queueAll ?? false,
  queueingMethod: (room.queueingMethod ?? "fifo") as QueueingMethod,
  queueingStatusCode: (room.queueingStatusCode ?? "200") as QueueingStatusCode,
  suspended: room.suspended ?? false,
  createdOn: room.createdOn ?? undefined,
  modifiedOn: room.modifiedOn ?? undefined,
});
