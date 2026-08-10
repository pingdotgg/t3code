/**
 * CursorUsageClient - fetches Cursor usage events from Cursor.
 *
 * Two connectors are supported, tried in this order:
 *
 * 1. The documented Admin API (`POST /teams/filtered-usage-events`), for
 *    team/business/enterprise accounts with an Admin API key.
 * 2. Cursor's undocumented dashboard usage-events endpoint
 *    (`POST /api/dashboard/get-filtered-usage-events`), authenticated with
 *    the `WorkosCursorSessionToken` cookie value from a signed-in
 *    cursor.com session - the only way an individual (non-team) account can
 *    be read. This is reverse-engineered, not a published API: Cursor can
 *    change or remove it without notice, so failures surface as
 *    `CursorUsageClientEndpointError`/`CursorUsageClientAuthError` rather
 *    than silently reporting stale or empty data.
 *
 * Both credentials are stored via `ServerSecretStore` (chmod 600, outside
 * the settings JSON synced to the client) and are never logged, never
 * included in error messages, and never returned by any RPC - only a
 * `configured: boolean` / `connectionMode` summary is exposed.
 *
 * @module CursorUsageClient
 */
import type { CursorUsageEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  CursorUsageClientAuthError,
  CursorUsageClientEndpointError,
  type CursorUsageClientError,
  CursorUsageClientNotConfiguredError,
  CursorUsageClientPaginationLimitError,
  CursorUsageClientRateLimitError,
  CursorUsageClientRequestError,
} from "./CursorUsageErrors.ts";
import { normalizeCursorAdminEvent } from "./CursorUsageNormalizer.ts";
import {
  decodeCursorAdminUsagePage,
  decodeCursorSessionUsagePage,
  sessionEventToAdminShape,
  type CursorAdminUsageEvent,
  type CursorAdminUsagePage,
} from "./CursorUsageSchemas.ts";

export const CURSOR_USAGE_ADMIN_API_KEY_SECRET_NAME = "cursor-usage-admin-api-key";
export const CURSOR_USAGE_SESSION_TOKEN_SECRET_NAME = "cursor-usage-session-token";

/**
 * Cursor's published base URL for the Admin API. Not verified against a
 * pinned OpenAPI spec at the time of writing - if Cursor moves this,
 * requests fail with `CursorUsageClientEndpointError` rather than silently
 * returning wrong data.
 */
const CURSOR_ADMIN_API_BASE_URL = "https://api.cursor.com";
const CURSOR_ADMIN_USAGE_EVENTS_PATH = "/teams/filtered-usage-events";

/**
 * Cursor's own web app domain - the session token is never sent anywhere
 * else. Confirmed against a live request from the dashboard itself.
 */
const CURSOR_DASHBOARD_BASE_URL = "https://cursor.com";
const CURSOR_DASHBOARD_REFERER_URL = `${CURSOR_DASHBOARD_BASE_URL}/dashboard/usage`;
const CURSOR_DASHBOARD_USAGE_EVENTS_PATH = "/api/dashboard/get-filtered-usage-events";
const CURSOR_SESSION_COOKIE_NAME = "WorkosCursorSessionToken";
/** `teamId: 0` is what the dashboard sends for a personal (non-team) account - confirmed live. */
const CURSOR_DASHBOARD_PERSONAL_TEAM_ID = 0;

const PAGE_SIZE = 200;
/** Guards against a pagination loop from a misbehaving or looping API. */
const MAX_PAGES_PER_CALL = 500;

export interface CursorUsageEventsPage {
  readonly events: readonly CursorUsageEvent[];
  readonly nextCursor: string | null;
}

export interface CursorUsageClientShape {
  /**
   * Fetches every page of usage events in `[startDateMs, endDateMs)`,
   * stopping once the API reports no further page. A pagination limit is
   * returned as an error rather than silently truncating the result.
   */
  readonly getUsageEvents: (options: {
    readonly startDateMs: number;
    readonly endDateMs: number;
  }) => Effect.Effect<CursorUsageEventsPage, CursorUsageClientError>;

  readonly isConfigured: Effect.Effect<boolean>;

  /** Which credential, if any, `getUsageEvents` will use. Admin API is preferred when both are set. */
  readonly getConnectionMode: Effect.Effect<"adminApi" | "session" | "none">;
}

export class CursorUsageClient extends Context.Service<CursorUsageClient, CursorUsageClientShape>()(
  "t3/usage/cursor/CursorUsageClient",
) {}

const textDecoder = new TextDecoder();

const requestSchedule = Schedule.min([
  Schedule.exponential(Duration.millis(500), 2),
  Schedule.recurs(3),
]);

/**
 * Normalizes a batch of already-flattened admin-shaped events, tallying
 * (rather than failing on) any that don't decode cleanly.
 */
function normalizeBatch(raw: readonly CursorAdminUsageEvent[]): {
  readonly events: CursorUsageEvent[];
  readonly malformed: number;
} {
  const events: CursorUsageEvent[] = [];
  let malformed = 0;
  for (const event of raw) {
    const normalized = normalizeCursorAdminEvent(event);
    if (normalized === null) {
      malformed += 1;
      continue;
    }
    events.push(normalized);
  }
  return { events, malformed };
}

export const layer = Layer.effect(
  CursorUsageClient,
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const httpClient = yield* HttpClient.HttpClient;

    const getApiKey = secretStore.get(CURSOR_USAGE_ADMIN_API_KEY_SECRET_NAME).pipe(
      Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    );

    const getSessionToken = secretStore.get(CURSOR_USAGE_SESSION_TOKEN_SECRET_NAME).pipe(
      Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    );

    const isConfigured: CursorUsageClientShape["isConfigured"] = Effect.gen(function* () {
      if (Option.isSome(yield* getApiKey)) return true;
      return Option.isSome(yield* getSessionToken);
    });

    const getConnectionMode: CursorUsageClientShape["getConnectionMode"] = Effect.gen(function* () {
      if (Option.isSome(yield* getApiKey)) return "adminApi" as const;
      if (Option.isSome(yield* getSessionToken)) return "session" as const;
      return "none" as const;
    });

    /** The documented Admin API connector, for team/business accounts. */
    const fetchAdminPage = (options: {
      readonly apiKey: string;
      readonly startDateMs: number;
      readonly endDateMs: number;
      readonly cursor: string | null;
    }) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `${CURSOR_ADMIN_API_BASE_URL}${CURSOR_ADMIN_USAGE_EVENTS_PATH}`,
        ).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${options.apiKey}`),
          HttpClientRequest.bodyJsonUnsafe({
            startDate: options.startDateMs,
            endDate: options.endDateMs,
            pageSize: PAGE_SIZE,
            ...(options.cursor === null ? {} : { cursor: options.cursor }),
          }),
        );

        const response = yield* httpClient.execute(request).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError(
            (cause) =>
              new CursorUsageClientRequestError({ detail: "request failed or timed out", cause }),
          ),
        );

        if (response.status === 401 || response.status === 403) {
          return yield* new CursorUsageClientAuthError({
            detail: `HTTP ${response.status}`,
          });
        }
        if (response.status === 429) {
          return yield* new CursorUsageClientRateLimitError();
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new CursorUsageClientEndpointError({
            detail: `HTTP ${response.status}`,
          });
        }

        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new CursorUsageClientEndpointError({ detail: "response was not valid JSON", cause }),
          ),
        );
        return yield* decodeCursorAdminUsagePage(json).pipe(
          Effect.mapError(
            (cause) =>
              new CursorUsageClientEndpointError({
                detail: "response did not match the expected shape",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.retry({
          schedule: requestSchedule,
          while: (error) => error._tag === "CursorUsageClientRequestError",
        }),
      );

    /**
     * The undocumented dashboard connector, for individual accounts. Auth is
     * the session cookie only - never sent with an `Authorization` header,
     * never logged, and only ever sent to `CURSOR_DASHBOARD_BASE_URL`.
     */
    const fetchSessionPage = (options: {
      readonly token: string;
      readonly startDateMs: number;
      readonly endDateMs: number;
      readonly page: number;
    }) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `${CURSOR_DASHBOARD_BASE_URL}${CURSOR_DASHBOARD_USAGE_EVENTS_PATH}`,
        ).pipe(
          HttpClientRequest.setHeader("Cookie", `${CURSOR_SESSION_COOKIE_NAME}=${options.token}`),
          // Headers below mirror a live request captured from the dashboard
          // itself - the endpoint rejects requests that don't look like they
          // came from cursor.com's own frontend with a 403, distinct from an
          // actually-expired/invalid token (also a 403, unfortunately - see
          // `CursorUsageClientAuthError`'s generic detail message below).
          HttpClientRequest.setHeader("Origin", CURSOR_DASHBOARD_BASE_URL),
          HttpClientRequest.setHeader("Referer", CURSOR_DASHBOARD_REFERER_URL),
          HttpClientRequest.setHeader("Accept", "*/*"),
          HttpClientRequest.setHeader("Sec-Fetch-Site", "same-origin"),
          HttpClientRequest.setHeader("Sec-Fetch-Mode", "cors"),
          HttpClientRequest.setHeader("Sec-Fetch-Dest", "empty"),
          HttpClientRequest.setHeader(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          ),
          HttpClientRequest.bodyJsonUnsafe({
            teamId: CURSOR_DASHBOARD_PERSONAL_TEAM_ID,
            // Confirmed live: dates are sent as *stringified* epoch millis.
            startDate: String(options.startDateMs),
            endDate: String(options.endDateMs),
            page: options.page,
            pageSize: PAGE_SIZE,
          }),
        );

        const response = yield* httpClient.execute(request).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError(
            (cause) =>
              new CursorUsageClientRequestError({ detail: "request failed or timed out", cause }),
          ),
        );

        if (response.status === 401 || response.status === 403) {
          return yield* new CursorUsageClientAuthError({
            detail: `HTTP ${response.status} - the Cursor session token has likely expired`,
          });
        }
        if (response.status === 429) {
          return yield* new CursorUsageClientRateLimitError();
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new CursorUsageClientEndpointError({
            detail: `HTTP ${response.status}`,
          });
        }

        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new CursorUsageClientEndpointError({ detail: "response was not valid JSON", cause }),
          ),
        );
        return yield* decodeCursorSessionUsagePage(json).pipe(
          Effect.mapError(
            (cause) =>
              new CursorUsageClientEndpointError({
                detail: "response did not match the expected shape",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.retry({
          schedule: requestSchedule,
          while: (error) => error._tag === "CursorUsageClientRequestError",
        }),
      );

    const getUsageEventsViaAdminApi = (
      apiKey: string,
      startDateMs: number,
      endDateMs: number,
    ): Effect.Effect<CursorUsageEventsPage, CursorUsageClientError> =>
      Effect.gen(function* () {
        const events: CursorUsageEvent[] = [];
        let cursor: string | null = null;
        let malformed = 0;
        // Pages already seen this call, guarding against an API that loops
        // back to a cursor it already returned instead of terminating.
        const seenCursors = new Set<string>();

        for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
          const result: CursorAdminUsagePage = yield* fetchAdminPage({
            apiKey,
            startDateMs,
            endDateMs,
            cursor,
          });

          const batch = normalizeBatch(result.usageEvents);
          events.push(...batch.events);
          malformed += batch.malformed;

          const next = result.nextPageCursor ?? null;
          if (next === null || result.usageEvents.length === 0) {
            cursor = null;
            break;
          }
          if (seenCursors.has(next)) {
            yield* Effect.logWarning("cursor_usage_pagination_loop_detected", { cursor: next });
            cursor = null;
            break;
          }
          seenCursors.add(next);
          cursor = next;
        }

        if (cursor !== null) {
          return yield* new CursorUsageClientPaginationLimitError();
        }

        if (malformed > 0) {
          yield* Effect.logWarning("cursor_usage_events_malformed", { count: malformed });
        }

        return { events, nextCursor: cursor } satisfies CursorUsageEventsPage;
      });

    const getUsageEventsViaSession = (
      token: string,
      startDateMs: number,
      endDateMs: number,
    ): Effect.Effect<CursorUsageEventsPage, CursorUsageClientError> =>
      Effect.gen(function* () {
        const events: CursorUsageEvent[] = [];
        let malformed = 0;

        for (let page = 1; page <= MAX_PAGES_PER_CALL; page++) {
          const result = yield* fetchSessionPage({
            token,
            startDateMs,
            endDateMs,
            page,
          });

          const batch = normalizeBatch(result.usageEventsDisplay.map(sessionEventToAdminShape));
          events.push(...batch.events);
          malformed += batch.malformed;

          // The dashboard endpoint reports no explicit cursor; a short page
          // (or an empty one) is treated as the last page.
          if (result.usageEventsDisplay.length < PAGE_SIZE) break;
          if (page === MAX_PAGES_PER_CALL) {
            return yield* new CursorUsageClientPaginationLimitError();
          }
        }

        if (malformed > 0) {
          yield* Effect.logWarning("cursor_usage_events_malformed", { count: malformed });
        }

        return { events, nextCursor: null } satisfies CursorUsageEventsPage;
      });

    const getUsageEvents: CursorUsageClientShape["getUsageEvents"] = ({ startDateMs, endDateMs }) =>
      Effect.gen(function* () {
        const apiKey = yield* getApiKey;
        if (Option.isSome(apiKey)) {
          return yield* getUsageEventsViaAdminApi(apiKey.value, startDateMs, endDateMs);
        }

        const sessionToken = yield* getSessionToken;
        if (Option.isSome(sessionToken)) {
          return yield* getUsageEventsViaSession(sessionToken.value, startDateMs, endDateMs);
        }

        return yield* new CursorUsageClientNotConfiguredError();
      });

    return { getUsageEvents, isConfigured, getConnectionMode } satisfies CursorUsageClientShape;
  }),
);
