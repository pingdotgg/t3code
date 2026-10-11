/**
 * CursorKeychain - the Cursor CLI's macOS Keychain login, shared by usage
 * history and usage limits in one server process.
 *
 * macOS shows the access prompt on the server's own screen, which a remote
 * client cannot answer, so a read gives up after a timeout. The Keychain read
 * stays in flight: the next read joins it instead of stacking a second prompt,
 * and picks up the token once someone allows access.
 *
 * @module provider-cursor/server/CursorKeychain
 */
import * as NodeModule from "node:module";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CACHE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT = Duration.seconds(30);

const requireForKeyring = NodeModule.createRequire(import.meta.url);

/** Nobody answered the macOS Keychain prompt in time. */
export class CursorKeychainTimeoutError extends Schema.TaggedError<CursorKeychainTimeoutError>()(
  "CursorKeychainTimeoutError",
  {},
) {
  override get message(): string {
    return "Timed out waiting for Keychain access.";
  }
}

export const isCursorKeychainTimeoutError = Schema.is(CursorKeychainTimeoutError);

/** The Keychain could not be read. */
export class CursorKeychainReadError extends Schema.TaggedError<CursorKeychainReadError>()(
  "CursorKeychainReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cursor Keychain credentials could not be read.";
  }
}

export class CursorKeychain extends Context.Service<
  CursorKeychain,
  {
    /** The access token, or `null` when the Keychain holds no Cursor login. */
    readonly accessToken: Effect.Effect<
      string | null,
      CursorKeychainTimeoutError | CursorKeychainReadError
    >;
  }
>()("@t3tools/provider-cursor/server/CursorKeychain") {}

/** Reads the Cursor CLI's default macOS credential without invoking the shared security binary. */
const readKeychainEntry = Effect.tryPromise({
  try: async () => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    return (await new AsyncEntry("cursor-access-token", "cursor-user").getPassword()) ?? null;
  },
  catch: (cause) => new CursorKeychainReadError({ cause }),
});

/** A Keychain backed by `read`, which tests replace. */
export const make = (
  read: Effect.Effect<string | null, CursorKeychainReadError> = readKeychainEntry,
  timeout: Duration.Input = DEFAULT_TIMEOUT,
): CursorKeychain["Service"] => {
  let cached: { readonly token: string; readonly untilMs: number } | null = null;
  let pending: Deferred.Deferred<string | null, CursorKeychainReadError> | null = null;

  /** Joins the read in flight, or starts one that outlives the caller. */
  const startRead = Effect.uninterruptible(
    Effect.gen(function* () {
      if (pending !== null) return pending;
      const done = Deferred.makeUnsafe<string | null, CursorKeychainReadError>();
      pending = done;
      yield* read.pipe(
        Effect.tap((token) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((nowMs) => {
              cached = token ? { token, untilMs: nowMs + CACHE_MS } : null;
            }),
          ),
        ),
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            pending = null;
            return Deferred.done(done, exit);
          }),
        ),
        Effect.forkDetach,
      );
      return done;
    }),
  );

  const accessToken = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (cached !== null && cached.untilMs > nowMs) return cached.token;
    const done = yield* startRead;
    const token = yield* Deferred.await(done).pipe(Effect.timeoutOption(timeout));
    if (Option.isNone(token)) return yield* new CursorKeychainTimeoutError();
    return token.value;
  });

  return CursorKeychain.of({ accessToken });
};

export const layer = Layer.sync(CursorKeychain, () => make());
