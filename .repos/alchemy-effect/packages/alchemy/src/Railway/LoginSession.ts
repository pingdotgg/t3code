import * as railway from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/** Dashboard host used by `railway login --browserless` pairing URLs. */
export const RAILWAY_CLI_LOGIN_HOST = "https://railway.com";

/**
 * Build the Railway CLI pairing URL for a {@link railway.loginSessionCreate}
 * code.
 *
 * Mirrors `railway login --browserless`: the payload is
 * `wordCode={code}&hostname={hostname}` (URL-safe base64) on
 * `https://railway.com/cli-login?d=…`. The user confirms the pairing code
 * in the browser; {@link railway.loginSessionAuth} is the dashboard-side
 * mutation that marks the session authorized. {@link railway.loginSessionVerify}
 * is a liveness check (true while the pairing session exists). The CLI then
 * polls {@link railway.loginSessionConsume} until a token is returned.
 *
 * Alchemy's AuthProvider `method: "oauth"` runs this flow: create → print
 * the pairing URL → poll consume → store the token.
 *
 * ### Pairing URL
 * **Example:** From a session code
 * ```typescript
 * const code = yield* railway.loginSessionCreate({});
 * const url = loginSessionUrl(code, { hostname: "dev-box" });
 * ```
 */
export const loginSessionUrl = (
  code: string,
  options?: { hostname?: string; host?: string },
): string => {
  const hostname = options?.hostname ?? "alchemy";
  const host = (options?.host ?? RAILWAY_CLI_LOGIN_HOST).replace(/\/+$/, "");
  const payload = `wordCode=${code}&hostname=${hostname}`;
  const encoded = Buffer.from(payload)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${host}/cli-login?d=${encoded}`;
};

/**
 * Credentials layer that sends no `Authorization` header. Login-session
 * mutations are public: they run before the user has a token.
 */
const anonymousRailwayCredentials = (apiBaseUrl?: string) =>
  railway.CredentialsFromToken({
    token: "",
    tokenKind: "account",
    apiBaseUrl,
  });

const anonymousRailway = (apiBaseUrl?: string) =>
  Layer.mergeAll(
    anonymousRailwayCredentials(apiBaseUrl),
    FetchHttpClient.layer,
  );

export const provideAnonymousRailway = <A, E>(
  effect: Effect.Effect<A, E, railway.RailwayOpContext>,
  apiBaseUrl?: string,
): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(anonymousRailway(apiBaseUrl)));

const LOGIN_POLL_TIMES = 300;

/**
 * Poll {@link railway.loginSessionVerify} then
 * {@link railway.loginSessionConsume} until a token is returned, or 5 minutes
 * elapse. Mirrors `railway login --browserless`: consume is the token source;
 * verify is a liveness check. Does not cancel the session — the caller should
 * cancel on timeout or interrupt.
 *
 * Exhaustion returns `undefined` (not a failure) so the AuthProvider can
 * surface a timeout rather than a poll error.
 */
const missingSession = ["RailwayNotFound", "NotFound"] as const;

export const pollLoginSessionToken = (
  code: string,
): Effect.Effect<
  string | undefined,
  railway.RailwayOpError,
  railway.RailwayOpContext
> =>
  railway.loginSessionVerify({ code }).pipe(
    Effect.catchTag(missingSession, () => Effect.succeed(false)),
    Effect.flatMap(() =>
      railway
        .loginSessionConsume({ code })
        .pipe(Effect.catchTag(missingSession, () => Effect.succeed(null))),
    ),
    Effect.map((token) =>
      token != null && token.length > 0 ? token : undefined,
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      while: (token) => token == null,
      times: LOGIN_POLL_TIMES,
    }),
  );
