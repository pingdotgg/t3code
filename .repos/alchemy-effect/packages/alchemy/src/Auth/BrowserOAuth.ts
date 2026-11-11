/**
 * Shared browser-OAuth ceremony for auth providers: an
 * {@link Interaction.browserLogin} that waits for the provider's local
 * callback listener, with manual code entry as the fallback.
 *
 * {@link deviceOAuth} is the device-code (RFC 8628) counterpart.
 *
 * Built-in providers (Planetscale, Cloudflare) and custom stack-provided
 * auth providers should all route their browser flows through these so the
 * login UX stays uniform.
 */
import * as Effect from "effect/Effect";
import * as Interaction from "../Interaction.ts";
import { CallbackServerStartError, type DeviceAuthorization } from "./OAuthFlow.ts";

export interface BrowserOAuthOptions<A, E1, R1, E2, R2> {
  /** Display name, e.g. "Cloudflare" — used in the prompt title. */
  provider: string;
  /** The authorization URL the browser was pointed at. */
  url: string;
  /** Resolves when the local callback listener receives the redirect. */
  callback: Effect.Effect<A, E1, R1>;
  /** Exchanges a manually pasted code / callback URL for credentials. */
  exchange: (input: string) => Effect.Effect<A, E2, R2>;
  /** Spinner label. @default "waiting for browser authorization (up to 5 minutes)…" */
  waitingLabel?: string;
}

export const browserOAuth = Effect.fn(function* <A, E1, R1, E2, R2>(
  options: BrowserOAuthOptions<A, E1, R1, E2, R2>,
) {
  // A callback server that cannot start (e.g. the port is taken) must not
  // fail the race when the user can paste the code instead — warn and hang
  // so manual entry stays available. Without terminal input there is no
  // manual entry, so the startup error fails the login. Genuine OAuth
  // failures delivered via the callback always fail fast.
  const { input } = (yield* Interaction.Interaction).terminal;
  return yield* Interaction.browserLogin({
    provider: options.provider,
    url: options.url,
    waitingLabel: options.waitingLabel,
    waitFor: input
      ? options.callback.pipe(
          Effect.catchIf(
            (e): e is E1 & CallbackServerStartError => e instanceof CallbackServerStartError,
            (e) =>
              Interaction.warning(`${e.message} — paste the authorization code instead.`).pipe(
                Effect.andThen(Effect.never),
              ),
          ),
        )
      : options.callback,
    manualCode: {
      label: "Paste the authorization code or callback URL",
      validate: (value) => (value.trim().length > 0 ? undefined : "Paste a code or URL"),
      exchange: options.exchange,
    },
  });
});

export interface DeviceOAuthOptions<A, E, R> {
  /** Display name, e.g. "Cloudflare" — used in the prompt title. */
  provider: string;
  /** The pending device authorization to show the user. */
  authorization: DeviceAuthorization;
  /** Polls until the user approves; usually `client.deviceToken(authorization)`. */
  token: Effect.Effect<A, E, R>;
}

/**
 * Shared device-authorization (RFC 8628) ceremony: open the verification
 * URL, show the user code, and wait for the token poll. The prompt only
 * renders the URL/code and re-opens the browser; the poll always wins.
 */
export const deviceOAuth = <A, E, R>(options: DeviceOAuthOptions<A, E, R>) =>
  Interaction.browserLogin({
    provider: options.provider,
    url: options.authorization.verificationUriComplete,
    code: options.authorization.userCode,
    waitFor: options.token,
  });
