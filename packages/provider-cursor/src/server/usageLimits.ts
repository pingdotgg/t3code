import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as CursorKeychain from "./CursorKeychain.ts";
import type { CursorStoredLogin } from "./auth.ts";

const CursorCredentials = Schema.Struct({ accessToken: Schema.optional(Schema.String) });
const DEFAULT_CURSOR_API_ENDPOINT = "https://api2.cursor.sh";
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(CursorCredentials));
const CursorUsageResponse = Schema.Struct({
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
});

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

const ExchangedAccessToken = Schema.Struct({ accessToken: Schema.NonEmptyString });

const requestUsage = Effect.fn("CursorUsageLimits.requestUsage")(function* (
  endpoint: string,
  token: string,
  clientType: "cli" | "sdk",
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({
        "connect-protocol-version": "1",
        "x-cursor-client-type": clientType,
      }),
      HttpClientRequest.bodyJsonUnsafe({}),
    ),
  );
  return yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
    yield* HttpClientResponse.filterStatusOk(response),
  );
});

const signInAgain = (checkedAt: string) =>
  makeUnavailableUsageLimits({
    checkedAt,
    reason: "unsupported",
    message: "Cursor sign-in expired or was rejected. Sign in again in provider settings.",
  });

/**
 * The stored browser login is a user API key, which the dashboard rejects as a bearer. Like
 * `@cursor/sdk`, exchange it for a short-lived access token at the login's own backend first.
 */
const readStoredLoginUsage = Effect.fn("CursorUsageLimits.readStoredLoginUsage")(
  function* (login: CursorStoredLogin, checkedAt: string) {
    if (login.status === "expired") return signInAgain(checkedAt);
    const endpoint = yield* Effect.try(() => {
      const url = new URL(login.backendUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Cursor login backend must be a plain https origin.");
      }
      return url.origin;
    });
    const client = yield* HttpClient.HttpClient;
    const exchange = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/auth/exchange_user_api_key`).pipe(
        HttpClientRequest.bearerToken(login.apiKey),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    if (exchange.status === 401) return signInAgain(checkedAt);
    const { accessToken } = yield* HttpClientResponse.schemaBodyJson(ExchangedAccessToken)(
      yield* HttpClientResponse.filterStatusOk(exchange),
    );
    return cursorUsageResponseToLimits(
      yield* requestUsage(endpoint, accessToken, "sdk"),
      checkedAt,
    );
  },
  // A redirect would carry the user's key to another host.
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
);

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
  allowKeychain = false,
  storedLogin?: CursorStoredLogin,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    // A login saved by T3 names this instance's account; host CLI logins may belong to another.
    if (storedLogin) return yield* readStoredLoginUsage(storedLogin, checkedAt);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    // An explicit API key can name a different account from the stored login.
    if (!token && environment.CURSOR_API_KEY?.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
    if (!token && credentialStore === "memory") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Cursor usage requires a CLI login or CURSOR_AUTH_TOKEN.",
      });
    }
    if (!token && platform === "darwin" && credentialStore !== "file") {
      if (!allowKeychain) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Enable Cursor account usage in T3 Code to read its Keychain login.",
        });
      }
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Cursor account usage requires the default Cursor endpoint when using Keychain.",
        });
      }
      const keychain = yield* CursorKeychain.CursorKeychain;
      token = (yield* keychain.accessToken)?.trim();
    } else if (!token) {
      const home =
        (platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
        (yield* HostProcess.HomeDirectory);
      const directory =
        platform === "win32"
          ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
          : platform === "darwin"
            ? path.join(home, ".cursor")
            : path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
      const credentials = yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
        Effect.flatMap(decodeCredentials),
      );
      token = credentials.accessToken?.trim();
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    return cursorUsageResponseToLimits(yield* requestUsage(endpoint, token, "cli"), checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
