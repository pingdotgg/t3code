import { cachedFunction } from "../Util/cached-function.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Semaphore from "effect/Semaphore";
import { Interaction } from "../Interaction.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { withProfileCredentialsLock } from "./Lock.ts";

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
 * Methods that may drive an interactive flow (prompts, browser-based
 * OAuth, etc.). A process-wide mutex serializes these across providers
 * so that, e.g., Cloudflare's `configure` finishes its prompt sequence
 * before Planetscale's begins — even when the two auth provider Layers
 * are built in parallel as part of a single `providers()` Layer.
 *
 * The interactive renderer enforces per-prompt serialization; this mutex
 * enforces per-flow serialization so the user sees one provider's prompts
 * grouped together rather than interleaved.
 */
const interactiveMutex = Semaphore.makeUnsafe(1);

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  readonly [UserFacingError] = true;
}

/**
 * Stored credentials exist (or are expected) but cannot be used until the
 * user re-authenticates: missing values, an expired/rotated
 * token, or a session the provider can no longer refresh silently. The
 * profile UI renders this as "needs re-login" instead of a generic error,
 * and callers match it with `Effect.catchTag("NeedsReauth", ...)` — never
 * by inspecting the message.
 */
export class NeedsReauth extends Schema.TaggedError<NeedsReauth>()(
  "NeedsReauth",
  {
    provider: Schema.String,
    profile: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

/**
 * Standard remediation hint appended to stored-credential errors
 * ("credentials not found", "refresh failed", ...). Deliberately generic —
 * the explicit command is correct from any surface, including inside the
 * profile dashboard (where `r` is merely the shortcut for it). Centralized
 * so the phrasing lives in one place; surface-aware wording can layer on
 * top later without touching call sites.
 */
export const refreshHint = (provider: string, profileName: string): string =>
  `Run \`alchemy profile refresh --profile ${profileName} --provider ${provider}\`.`;

/** {@link refreshHint}'s sibling for reconfiguration. */
export const reconfigureHint = (
  provider: string,
  profileName: string,
): string =>
  `Run \`alchemy profile edit --profile ${profileName} --reconfigure ${provider}\` to reconfigure.`;

export class AuthProviders extends Context.Service<
  AuthProviders,
  {
    [providerName: string]: AuthProvider;
  }
>()("AuthProviders") {}

/**
 * Declares one environment variable a provider's {@link AuthProviderImpl.readEnvironment}
 * consumes. Profiles are not available in CI — environment variables are the
 * only CI credential source — so this metadata is the machine-readable
 * contract for "what must CI set": rendered in docs, surfaced by the CLI,
 * and available to tooling through the {@link AuthProviders} registry.
 */
export const EnvironmentVariable = Schema.Struct({
  /** Environment variable name, e.g. `CLOUDFLARE_API_TOKEN`. */
  name: Schema.String,
  /** What the variable configures and when it applies. */
  description: Schema.optional(Schema.String),
  /**
   * Whether credential resolution fails when neither this variable nor one
   * of its {@link alternatives} is set. Use `description` to explain
   * conditional requirements (e.g. "required unless X is set").
   */
  required: Schema.Boolean,
  /** Holds a secret — display surfaces must redact its value. */
  secret: Schema.optional(Schema.Boolean),
  /**
   * Alternative variable names that satisfy the same requirement, in
   * precedence order after {@link name} (e.g. `AWS_DEFAULT_REGION` for
   * `AWS_REGION`).
   */
  alternatives: Schema.optional(Schema.Array(Schema.String)),
});

export type EnvironmentVariable = typeof EnvironmentVariable.Type;

const EnvironmentVariables = Schema.Array(EnvironmentVariable);

/** Render a one-line summary of a provider's environment contract. */
export const describeEnvironment = (
  environment: ReadonlyArray<EnvironmentVariable>,
): string =>
  environment
    .map((v) => {
      const names = [v.name, ...(v.alternatives ?? [])].join(" | ");
      return v.required ? names : `[${names}]`;
    })
    .join(", ");

/**
 * The variable names a provider's environment resolution would consume, or
 * `undefined` when the declared contract is not fully satisfied (some
 * required variable has no non-empty value). Reads through the ambient
 * `ConfigProvider` — the process environment plus `.env` / `--env-file` —
 * so it sees exactly what `readEnvironment` will. Environment credentials
 * take precedence over any profile, CI or not; the returned names tell the
 * user exactly which keys won.
 */
export const presentEnvironment = (
  environment: ReadonlyArray<EnvironmentVariable>,
) =>
  Effect.gen(function* () {
    const used: string[] = [];
    for (const variable of environment) {
      let found: string | undefined;
      for (const name of [variable.name, ...(variable.alternatives ?? [])]) {
        const value = yield* Config.option(Config.String(name));
        if (Option.isSome(value) && value.value !== "") {
          found = name;
          break;
        }
      }
      if (found !== undefined) used.push(found);
      else if (variable.required) return undefined;
    }
    return used.length > 0 ? used : undefined;
  });

/**
 * One rendered line of a provider's credential details: `key: value`.
 * Values must arrive pre-redacted (see `displayRedacted`) — the display
 * layer renders them verbatim.
 */
export interface ProviderDetailLine {
  readonly key: string;
  readonly value: string;
}

/**
 * Structured result of {@link AuthProviderImpl.details} — what
 * `alchemy profile show` and the dashboard render for a connected
 * provider. Replaces the old `prettyPrint` Console-capture contract.
 */
export interface ProviderDetails {
  readonly lines: ReadonlyArray<ProviderDetailLine>;
}

/**
 * One input a provider's flag-driven (non-interactive) configuration
 * accepts — the machine-readable half of `alchemy profile edit --add
 * <provider> --method <m> --set <name>=<value>`.
 */
export interface ConfigureField {
  /** `--set` key and, for stored-credential providers, the stored JSON property. */
  readonly name: string;
  /** Human prompt label, e.g. "Cloudflare API Token". */
  readonly label: string;
  /** Secondary guidance shown beneath the interactive input. */
  readonly description?: string;
  /** Masked during prompts and redacted in details. @default false */
  readonly secret?: boolean;
  /** May be omitted. @default false */
  readonly optional?: boolean;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  /** Return an error message for an invalid value, undefined when valid. */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * The flag-driven configuration contract a provider exposes per method:
 * which `--method` names are accepted and which `--set` fields each one
 * takes. Interactive-only methods (browser OAuth, SSO) simply don't
 * appear here.
 */
export interface ConfigureMethod {
  /**
   * `--method` value. Always the same literal the provider persists as the
   * config's `method` (`"stored"`, `"sso"`, `"local"`, `"env"`), so the
   * flag and the credentials file speak one vocabulary.
   */
  readonly method: string;
  readonly fields: ReadonlyArray<ConfigureField>;
}

export interface AuthProviderImpl<
  Config extends { method: string } = { method: string },
  Credentials = unknown,
  R = never,
> {
  /**
   * Schema for the provider-owned `values` object ({@link Config}). Stored
   * entries are user-editable JSON that may also come from a newer or
   * older alchemy, so every load decodes against this schema — an invalid
   * entry fails with a reconfigure hint instead of reaching provider code
   * that matches exhaustively on `method`.
   */
  readonly configSchema: Schema.Codec<Config>;

  configure(
    profileName: string,
    currentConfig?: Config,
  ): Effect.Effect<Config, AuthError, R | Interaction>;

  /**
   * Flag-driven configuration for scripts and agents: validated `--set`
   * values for one of the methods declared in {@link configureMethods}.
   * Optional — interactive-only providers omit it.
   */
  configureWith?(
    profileName: string,
    input: {
      readonly method: string;
      readonly values: Record<string, string>;
    },
  ): Effect.Effect<Config, AuthError, R | Interaction>;

  /**
   * The methods {@link configureWith} accepts and their fields. Required
   * whenever `configureWith` is implemented so the CLI can validate and
   * document the flags.
   */
  readonly configureMethods?: ReadonlyArray<ConfigureMethod>;

  login(
    profileName: string,
    config: Config,
    updateConfig?: (config: Config) => Effect.Effect<void, AuthError>,
  ): Effect.Effect<Config | void, AuthError, R | Interaction>;

  logout(
    profileName: string,
    config: Config,
  ): Effect.Effect<void, AuthError, R | Interaction>;

  /**
   * Structured credential details for display. Fails with
   * {@link NeedsReauth} when stored credentials exist but require
   * re-authentication, so the UI can render "needs re-login" instead of a
   * generic error.
   */
  details(
    profileName: string,
    config: Config,
    updateConfig?: (config: Config) => Effect.Effect<void, AuthError>,
  ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth, R | Interaction>;

  /**
   * Resolve credentials from the profile values, silently refreshing when the
   * provider supports it. MUST be non-interactive — this is the only method
   * (with {@link readEnvironment}) that child processes exercise, and their
   * graphs carry no interaction services. When re-authentication is needed,
   * fail with {@link NeedsReauth} instead of prompting.
   */
  read(
    profileName: string,
    config: Config,
    updateConfig?: (config: Config) => Effect.Effect<void, AuthError>,
  ): Effect.Effect<Credentials, AuthError | NeedsReauth, R>;

  /**
   * Resolve credentials directly from the process environment for CI.
   * This never creates, selects, or mutates an Alchemy profile.
   */
  readonly readEnvironment?: Effect.Effect<Credentials, AuthError, R>;

  /**
   * The environment variables {@link readEnvironment} consumes. Required
   * whenever `readEnvironment` is implemented — profiles do not exist in CI,
   * so this list is the provider's entire CI configuration contract. Names
   * only, never values.
   */
  readonly environment?: ReadonlyArray<EnvironmentVariable>;
}

export interface AuthProvider<
  Config extends { method: string } = { method: string },
  Credentials = unknown,
> extends AuthProviderImpl<Config, Credentials> {
  readonly kind: "AuthProvider";
  readonly name: string;
  /** Log each environment contract once per built provider layer. */
  readonly logEnvironmentCredentials: (
    used: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  /**
   * The provider's declared CI environment contract. Empty when the
   * provider does not support environment credentials.
   */
  readonly environment: ReadonlyArray<EnvironmentVariable>;
  /**
   * Decode raw provider values against {@link AuthProviderImpl.configSchema}.
   * Fails with an {@link AuthError} carrying the reconfigure hint, so every
   * consumer of stored configuration reports invalid entries the same way.
   */
  decodeConfig(
    profileName: string,
    config: unknown,
  ): Effect.Effect<Config, AuthError>;
}

export const AuthProvider =
  <Config extends { method: string }, Credentials>() =>
  <R = never, ImplReq = never>(
    name: string,
    impl:
      | AuthProviderImpl<Config, Credentials, R>
      | Effect.Effect<AuthProviderImpl<Config, Credentials, R>, never, ImplReq>,
  ) =>
    Effect.gen(function* () {
      // FileSystem/Path back the cross-process credentials lock that wraps
      // `logout`/`read` below, so capture them with the impl's own services.
      //
      // `Effect.context()` snapshots the ENTIRE fiber context (the type
      // parameter only narrows the type), and `Effect.provideContext` makes
      // the provided side win — so an Interaction that happens to be
      // ambient at REGISTRATION would silently shadow whatever the caller
      // provides at call time, making the interactive methods' declared
      // `Interaction` requirement a dead letter. Omit it from the snapshot:
      // interactive flows resolve Interaction from the caller, exactly as
      // their signatures promise (a scripted test Interaction, a
      // browser-driven Alchemist login).
      // SAFETY: the assertion restores the pre-omit type — tsc cannot reduce
      // `Exclude<R, … Exclude<R, Interaction>>` over the generic R. It only
      // over-promises Interaction, which every registered method signature
      // re-declares as a requirement anyway, so no call site can rely on the
      // capture satisfying it.
      const ctx = Context.omit(Interaction)(
        yield* Effect.context<
          FileSystem.FileSystem | Path.Path | R | ImplReq
        >(),
      ) as Context.Context<FileSystem.FileSystem | Path.Path | R | ImplReq>;
      const providers = yield* AuthProviders;
      const service = yield* Effect.isEffect(impl)
        ? impl
        : Effect.succeed(impl);
      // Validate the declared environment contract at registration so a
      // malformed declaration fails at layer build (programmer error), not
      // when a CI run tries to render it.
      const environment =
        service.environment === undefined
          ? []
          : Schema.decodeUnknownSync(EnvironmentVariables)(service.environment);
      if (service.readEnvironment !== undefined && environment.length === 0) {
        return yield* Effect.die(
          `AuthProvider '${name}' implements readEnvironment but does not ` +
            "declare its `environment` variables. Declare every variable " +
            "readEnvironment consumes so CI requirements are discoverable.",
        );
      }
      if (
        service.configureWith !== undefined &&
        (service.configureMethods === undefined ||
          service.configureMethods.length === 0)
      ) {
        return yield* Effect.die(
          `AuthProvider '${name}' implements configureWith but does not ` +
            "declare `configureMethods`. Declare each accepted --method and " +
            "its --set fields so the CLI can validate and document them.",
        );
      }

      const provider: AuthProvider<Config, Credentials> = {
        logEnvironmentCredentials: yield* cachedFunction(
          (used: ReadonlyArray<string>) =>
            Effect.logInfo(
              `${name}: using environment variables (${used.join(", ")}) instead of the profile.`,
            ),
          { key: ([used]) => JSON.stringify(used.toSorted()) },
        ),
        kind: "AuthProvider",
        name,
        // configure/login can wait minutes on a browser grant, so they hold
        // only the process-level interactive mutex — never the per-profile
        // credentials lock, which would starve every concurrent `read` (its
        // waiters time out at ~120s). Providers whose login path performs a
        // rotate-on-use silent refresh wrap that read-refresh-persist
        // section (and only it) in `withProfileCredentialsLock` themselves;
        // a post-browser persist is a benign whole-file swap where the last
        // grant wins.
        configure: (profileName, currentConfig) =>
          Semaphore.withPermits(
            interactiveMutex,
            1,
          )(
            service
              .configure(profileName, currentConfig)
              .pipe(Effect.provideContext(ctx)),
          ),
        login: (profileName, config, updateConfig) =>
          Semaphore.withPermits(
            interactiveMutex,
            1,
          )(
            service
              .login(profileName, config, updateConfig)
              .pipe(Effect.provideContext(ctx)),
          ),
        logout: (profileName, config) =>
          withProfileCredentialsLock(
            profileName,
            service.logout(profileName, config),
          ).pipe(Effect.provideContext(ctx)),
        details: (profileName, config, updateConfig) =>
          withProfileCredentialsLock(
            profileName,
            service.details(profileName, config, updateConfig),
          ).pipe(Effect.provideContext(ctx)),
        ...(service.configureWith === undefined
          ? {}
          : {
              configureWith: (
                profileName: string,
                input: {
                  readonly method: string;
                  readonly values: Record<string, string>;
                },
              ) =>
                service.configureWith!(profileName, input).pipe(
                  Effect.provideContext(ctx),
                ),
              configureMethods: service.configureMethods,
            }),
        read: (profileName, config, updateConfig) =>
          withProfileCredentialsLock(
            profileName,
            service.read(profileName, config, updateConfig),
          ).pipe(Effect.provideContext(ctx)),
        readEnvironment: service.readEnvironment?.pipe(
          Effect.provideContext(ctx),
        ),
        environment,
        configSchema: service.configSchema,
        decodeConfig: (profileName, config) =>
          Effect.gen(function* () {
            return yield* Schema.decodeUnknownEffect(service.configSchema)(
              config,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message:
                      `Stored ${name} configuration in profile '${profileName}' is not valid ` +
                      `for this version of alchemy. ` +
                      `${reconfigureHint(name, profileName)}`,
                    cause,
                  }),
              ),
            );
          }),
      };

      providers[name] = provider;
    });

/**
 * Build a Layer that registers an AuthProvider into the {@link AuthProviders}
 * registry when its parent layer is built. Use this from a provider's
 * top-level `providers()` Layer so that the alchemy CLI can discover the
 * provider via the registry without forcing credential resolution.
 */
export const AuthProviderLayer =
  <Config extends { method: string }, Credentials>() =>
  <R = never, ImplReq = never>(
    name: string,
    impl:
      | AuthProviderImpl<Config, Credentials, R>
      | Effect.Effect<AuthProviderImpl<Config, Credentials, R>, never, ImplReq>,
  ) =>
    Layer.effectDiscard(
      AuthProvider<Config, Credentials>()<R, ImplReq>(name, impl),
    );

/**
 * Look up a registered {@link AuthProvider} by name. Fails with
 * {@link AuthError} if the provider hasn't been registered (typically because
 * its layer hasn't been built).
 */
export const getAuthProvider = <
  Config extends { method: string } = { method: string },
  Credentials = unknown,
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
      : Effect.succeed(
          // SAFETY: registration erases provider-specific generic parameters;
          // callers restore the contract associated with the requested name.
          registry[name] as AuthProvider<Config, Credentials>,
        ),
  );
