/**
 * Shared browser-OAuth ceremony for auth providers: open the authorization
 * URL, then race the provider's local callback listener against the branded
 * "waiting for browser" prompt (spinner + compact URL; Enter switches to
 * manual code entry, `o` opens the browser again, and `c` copies the URL).
 *
 * Built-in providers (Cloudflare, Planetscale) and custom stack-provided
 * auth providers should all route their browser flows through this so the
 * login UX stays uniform.
 */
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import * as Interaction from "../Interaction.ts";
import { CallbackServerStartError } from "./OAuthFlow.ts";

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
  const services = yield* Effect.context<ChildProcessSpawner>();
  // This runner is invoked later by React's keyboard event boundary, not
  // while the surrounding Effect is executing.
  const openUrl = Effect.runPromiseWith(services);
  const openFailed = yield* Interaction.openUrl(options.url).pipe(
    Effect.as(false),
    Effect.catch(() => Effect.succeed(true)),
  );
  return yield* Effect.raceFirst(
    // A callback server that cannot start (e.g. the port is taken) must not
    // fail the race — warn and hang so manual code entry stays available.
    // Genuine OAuth failures delivered via the callback still fail fast.
    options.callback.pipe(
      Effect.catch((e) =>
        e instanceof CallbackServerStartError
          ? Interaction.accessors.output
              .warning(`${e.message} — paste the authorization code instead.`)
              .pipe(Effect.andThen(Effect.never))
          : Effect.fail(e),
      ),
    ),
    (yield* Interaction.Interaction).prompt
      .awaitExternal({
        message: `${options.provider} authorization`,
        waitingLabel:
          options.waitingLabel ??
          "waiting for browser authorization (up to 5 minutes)…",
        url: options.url,
        openFailed,
        onOpen: () => openUrl(Interaction.openUrl(options.url)),
        inputLabel: "Paste the authorization code or callback URL",
        validate: (value) =>
          value.trim().length > 0 ? undefined : "Paste a code or URL",
      })
      .pipe(Effect.flatMap(options.exchange)),
  );
});
