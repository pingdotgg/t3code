import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { withLock } from "./Lock.ts";

/**
 * Canonical web host for OAuth provider-agnostic landing pages
 * (`/auth/success`, `/auth/error`). The CLI's loopback server 302s the
 * browser to one of these after handling the OAuth callback. Centralized
 * here so the redirect target lives in exactly one place across all
 * provider OAuth clients.
 */
export const AUTH_LANDING_HOST = "https://alchemy.run";
export const AUTH_SUCCESS_URL = `${AUTH_LANDING_HOST}/auth/success`;
export const AUTH_ERROR_URL = `${AUTH_LANDING_HOST}/auth/error`;

/**
 * Methods on an {@link AuthProviderImpl} that mutate (or could trigger
 * mutation of) on-disk credentials. The factory wraps these in a
 * cross-process file lock keyed by `(profileName, providerName)` so that
 * concurrent processes never refresh / write credentials simultaneously.
 *
 * `prettyPrint` is intentionally excluded: it's read-only display.
 */
const LOCKED_METHODS = new Set(["read", "login", "logout", "configure"]);

/**
 * Methods that may drive an interactive flow (prompts, browser-based
 * OAuth, etc.). A process-wide mutex serializes these across providers
 * so that, e.g., Cloudflare's `configure` finishes its prompt sequence
 * before Planetscale's begins — even when the two auth provider Layers
 * are built in parallel as part of a single `providers()` Layer.
 *
 * The clack prompt wrapper in `Util/Clank.ts` enforces per-prompt
 * serialization; this mutex enforces per-flow serialization so the user
 * sees one provider's prompts grouped together rather than interleaved.
 */
const INTERACTIVE_METHODS = new Set(["login", "configure"]);
const interactiveMutex = Semaphore.makeUnsafe(1);

export class AuthError extends Schema.TaggedErrorClass<AuthError>()(
  "AuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AuthProviders extends Context.Service<
  AuthProviders,
  {
    [providerName: string]: AuthProvider;
  }
>()("AuthProviders") {}

/**
 * Context passed to {@link AuthProviderImpl.configure}.
 */
export interface ConfigureContext {
  /**
   * `true` when running in a CI/CD environment (resolved from the `CI`
   * env/config). Providers MUST NOT prompt interactively when `ci` is true;
   * they should pick a non-interactive default (typically
   * `{ method: "env" }`) so unattended runs work.
   */
  readonly ci: boolean;
}

export interface AuthProviderImpl<
  Config extends { method: string } = any,
  Credentials = any,
  ConfigureReq = any,
  LoginReq = any,
  LogoutReq = any,
  PrettyPrintReq = any,
  ReadReq = any,
> {
  configure(
    profileName: string,
    ctx: ConfigureContext,
  ): Effect.Effect<Config, AuthError, ConfigureReq>;

  login(
    profileName: string,
    config: Config,
  ): Effect.Effect<void, AuthError, LoginReq>;

  logout(
    profileName: string,
    config: Config,
  ): Effect.Effect<void, AuthError, LogoutReq>;

  prettyPrint(
    profileName: string,
    config: Config,
  ): Effect.Effect<void, AuthError, PrettyPrintReq>;

  read(
    profileName: string,
    config: Config,
  ): Effect.Effect<Credentials, AuthError, ReadReq>;
}

export interface AuthProvider<
  Config extends { method: string } = any,
  Credentials = any,
> extends AuthProviderImpl<
  Config,
  Credentials,
  never,
  never,
  never,
  never,
  never
> {
  readonly kind: "AuthProvider";
  readonly name: string;
}

export const AuthProvider =
  <Config extends { method: string }, Credentials>() =>
  <
    ImplReq = never,
    ConfigureReq = never,
    LoginReq = never,
    LogoutReq = never,
    PrettyPrintReq = never,
    ReadReq = never,
  >(
    name: string,
    impl:
      | AuthProviderImpl<
          Config,
          Credentials,
          ConfigureReq,
          LoginReq,
          LogoutReq,
          PrettyPrintReq,
          ReadReq
        >
      | Effect.Effect<
          AuthProviderImpl<
            Config,
            Credentials,
            ConfigureReq,
            LoginReq,
            LogoutReq,
            PrettyPrintReq,
            ReadReq
          >,
          never,
          ImplReq
        >,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* Effect.context();
      const providers = yield* AuthProviders;
      const service = yield* Effect.isEffect(impl)
        ? impl
        : Effect.succeed(impl);
      return yield* Effect.sync(
        () =>
          (providers[name] = {
            kind: "AuthProvider",
            name,
            ...Object.fromEntries(
              Object.entries(service).map(([methodName, fn]) => [
                methodName,
                (...args: Parameters<typeof fn>) => {
                  let eff = (fn as any)(...args).pipe(
                    Effect.provideContext(ctx),
                  );
                  if (LOCKED_METHODS.has(methodName)) {
                    // First positional arg is always `profileName`.
                    const profileName = args[0] as string;
                    eff = withLock(`${profileName}-${name}`, eff);
                  }
                  if (INTERACTIVE_METHODS.has(methodName)) {
                    eff = Semaphore.withPermits(interactiveMutex, 1)(eff);
                  }
                  return eff;
                },
              ]),
            ),
          } as AuthProvider<Config, Credentials>),
      );
    });

/**
 * Build a Layer that registers an AuthProvider into the {@link AuthProviders}
 * registry when its parent layer is built. Use this from a provider's
 * top-level `providers()` Layer so that `alchemy login` can discover the
 * provider via the registry without forcing credential resolution.
 */
export const AuthProviderLayer =
  <Config extends { method: string }, Credentials>() =>
  <
    ImplReq = never,
    ConfigureReq = never,
    LoginReq = never,
    LogoutReq = never,
    PrettyPrintReq = never,
    ReadReq = never,
  >(
    name: string,
    impl:
      | AuthProviderImpl<
          Config,
          Credentials,
          ConfigureReq,
          LoginReq,
          LogoutReq,
          PrettyPrintReq,
          ReadReq
        >
      | Effect.Effect<
          AuthProviderImpl<
            Config,
            Credentials,
            ConfigureReq,
            LoginReq,
            LogoutReq,
            PrettyPrintReq,
            ReadReq
          >,
          never,
          ImplReq
        >,
  ) =>
    Layer.effectDiscard(
      AuthProvider<Config, Credentials>()<
        ImplReq,
        ConfigureReq,
        LoginReq,
        LogoutReq,
        PrettyPrintReq,
        ReadReq
      >(name, impl),
    );

/**
 * Look up a registered {@link AuthProvider} by name. Fails with
 * {@link AuthError} if the provider hasn't been registered (typically because
 * its layer hasn't been built).
 */
export const getAuthProvider = <
  Config extends { method: string } = any,
  Credentials = any,
>(
  name: string,
): Effect.Effect<AuthProvider<Config, Credentials>, AuthError, AuthProviders> =>
  AuthProviders.use((registry) =>
    registry[name] == null
      ? Effect.fail(
          new AuthError({
            message: `AuthProvider '${name}' is not registered. Make sure its layer has been provided.`,
          }),
        )
      : Effect.succeed(registry[name] as AuthProvider<Config, Credentials>),
  );
