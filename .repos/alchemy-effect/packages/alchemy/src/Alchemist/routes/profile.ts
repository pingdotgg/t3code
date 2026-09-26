import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Interaction } from "../../Interaction.ts";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../Auth/Credentials.ts";
import {
  inspectProvider,
  type ProviderConnection,
} from "../../Auth/Inspect.ts";
import { withProfileCredentialsLock } from "../../Auth/Lock.ts";
import { ProfileStore } from "../../Auth/Profile.ts";
import { AlchemistInvalidInput, AlchemistNotFound } from "../Errors.ts";
import { Progress } from "../Progress.ts";
import {
  collectAuthProviders,
  DEFAULT_ENTRYPOINT,
  type Target,
} from "../Session.ts";

/** Which project/profile pair a provider-scoped route resolves against. */
export interface ProviderContext extends Target {
  readonly profile: string;
}

export interface ProfileSummary {
  readonly name: string;
  readonly active: boolean;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly method: string;
  }>;
}

export type { ProviderConnection } from "../../Auth/Inspect.ts";

export interface ProfileSnapshot {
  readonly name: string;
  readonly active: boolean;
  readonly providers: ReadonlyArray<ProviderConnection>;
}

export interface ConfigureField {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
}

export interface ConfigureMethod {
  readonly method: string;
  readonly label: string;
  readonly fields: ReadonlyArray<ConfigureField>;
}

export interface AuthProviderDescriptor {
  readonly name: string;
  readonly connected: boolean;
  readonly configureMethods: ReadonlyArray<ConfigureMethod>;
  readonly supportsRefresh: boolean;
  readonly supportsLogout: boolean;
}

export interface ConfigureInput extends ProviderContext {
  readonly provider: string;
  readonly action: "add" | "reconfigure";
  readonly method?: string;
  readonly values?: Readonly<Record<string, Redacted.Redacted<string>>>;
}

/**
 * Every auth provider reachable from the given project: the built-ins plus
 * whatever the user's stack module registers.
 */
const registry = (input: ProviderContext) =>
  collectAuthProviders({
    main: input.entrypoint ?? DEFAULT_ENTRYPOINT,
    envFile: Option.fromNullishOr(input.envFile),
    profile: input.profile,
  });

/** The effective profile and how it was selected. */
export const current = Effect.fn("Alchemist.profile.current")(function* () {
  return yield* (yield* ProfileStore).current;
});

/** Every profile with its connected providers, active profile first. */
export const list = Effect.fn("Alchemist.profile.list")(function* () {
  const profiles = yield* ProfileStore;
  const [manifest, selected] = yield* Effect.all([
    profiles.readManifest,
    profiles.current,
  ]);
  return Object.entries(manifest.profiles)
    .sort(([a], [b]) =>
      a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b),
    )
    .map(([name, profile]): ProfileSummary => ({
      name,
      active: name === selected.name,
      providers: Object.entries(profile.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, config]) => ({
          name,
          method: config.method ?? "unknown",
        })),
    }));
});

/** One profile with the live status of each connected provider. */
export const get = Effect.fn("Alchemist.profile.get")(function* (input: {
  readonly name: string;
  readonly includeProviderStatus?: boolean;
  readonly entrypoint?: string;
  readonly envFile?: string;
}) {
  const includeProviderStatus = input.includeProviderStatus ?? true;
  const profiles = yield* ProfileStore;
  const [profile, selected] = yield* Effect.all([
    profiles.getProfile(input.name),
    profiles.current,
  ]);
  if (profile === undefined) {
    return yield* Effect.fail(
      new AlchemistNotFound({ kind: "profile", id: input.name }),
    );
  }
  // Skipping the status probe is what makes `profile list` fast: it
  // reaches no provider APIs, so every connection reads as connected.
  const registered = includeProviderStatus
    ? yield* registry({
        profile: input.name,
        entrypoint: input.entrypoint,
        envFile: input.envFile,
      })
    : {};
  const entries = Object.entries(profile.providers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return {
    name: input.name,
    active: selected.name === input.name,
    providers: yield* Effect.forEach(
      entries,
      ([provider, config]): Effect.Effect<
        ProviderConnection,
        never,
        Interaction
      > =>
        includeProviderStatus
          ? inspectProvider(
              input.name,
              provider,
              config,
              registered,
              (updated) =>
                profiles.setProviderConfig(input.name, provider, updated).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AuthError({
                        message: `Could not persist repaired ${provider} credentials for profile '${input.name}'.`,
                        cause,
                      }),
                  ),
                ),
            )
          : Effect.succeed({
              name: provider,
              method: config.method ?? "unknown",
              status: "connected",
              details: [],
            }),
    ),
  } satisfies ProfileSnapshot;
});

export const create = Effect.fn("Alchemist.profile.create")(function* (input: {
  readonly name: string;
}) {
  yield* (yield* ProfileStore).createProfile(input.name);
  return yield* get({ name: input.name });
});

export const rename = Effect.fn("Alchemist.profile.rename")(function* (input: {
  readonly name: string;
  readonly newName: string;
}) {
  yield* (yield* ProfileStore).renameProfile(input.name, input.newName);
  return yield* get({ name: input.newName });
});

/** Delete a profile and every credential stored for it. */
export const deleteProfile = Effect.fn("Alchemist.profile.delete")(
  function* (input: { readonly name: string }) {
    const profiles = yield* ProfileStore;
    const credentials = yield* CredentialsStore;
    return yield* withProfileCredentialsLock(
      input.name,
      Effect.gen(function* () {
        const deleted = yield* profiles.deleteProfile(input.name);
        if (!deleted) {
          return yield* Effect.fail(
            new AlchemistNotFound({ kind: "profile", id: input.name }),
          );
        }
        yield* credentials.deleteProfile(input.name);
        return { name: input.name, credentialsDeleted: true } as const;
      }),
    );
  },
);

/** Every registered auth provider and how it can be configured. */
export const providers = Effect.fn("Alchemist.profile.providers")(
  function* (input: {
    readonly profile?: string;
    readonly entrypoint?: string;
    readonly envFile?: string;
  }) {
    const profiles = yield* ProfileStore;
    const profile = input.profile ?? (yield* profiles.current).name;
    const stored = yield* profiles.ensureProfile(profile);
    const registered = yield* registry({ ...input, profile });
    return Object.values(registered)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((provider): AuthProviderDescriptor => ({
        name: provider.name,
        connected: provider.name in stored.providers,
        configureMethods: (provider.configureMethods ?? []).map((method) => ({
          method: method.method,
          label: method.method,
          fields: method.fields.map((field) => ({
            name: field.name,
            label: field.label,
            secret: field.secret ?? false,
            required: !(field.optional ?? false),
            description: field.description,
            placeholder: field.placeholder,
          })),
        })),
        supportsRefresh: true,
        supportsLogout: true,
      }));
  },
);

/** The configure methods (and fields) one provider accepts. */
export const configureForm = Effect.fn("Alchemist.profile.configureForm")(
  function* (input: {
    readonly profile: string;
    readonly provider: string;
    readonly method?: string;
  }) {
    const registered = yield* providers({ profile: input.profile });
    const provider = registered.find(({ name }) => name === input.provider);
    if (provider === undefined) {
      return yield* Effect.fail(
        new AlchemistNotFound({ kind: "provider", id: input.provider }),
      );
    }
    return input.method === undefined
      ? provider.configureMethods
      : provider.configureMethods.filter(
          ({ method }) => method === input.method,
        );
  },
);

/**
 * Connect or reconfigure a provider in a profile. Reported through
 * {@link Progress} as `ProviderConfigureStarted`; interactive providers drive
 * their own prompts.
 */
export const configure = Effect.fn("Alchemist.profile.configure")(function* (
  input: ConfigureInput,
) {
  const report = yield* Progress;
  yield* report({
    _tag: "provider.configure.started",
    provider: input.provider,
  });
  const profiles = yield* ProfileStore;
  const stored = yield* profiles.ensureProfile(input.profile);
  const provider = (yield* registry(input))[input.provider];
  if (provider === undefined) {
    return yield* Effect.fail(
      new AlchemistInvalidInput({
        field: "provider",
        message: `Auth provider '${input.provider}' is not registered.`,
      }),
    );
  }
  const connected = input.provider in stored.providers;
  if (
    (input.action === "add" && connected) ||
    (input.action === "reconfigure" && !connected)
  ) {
    return yield* Effect.fail(
      new AlchemistInvalidInput({
        field: "provider",
        message: `Provider '${input.provider}' is ${connected ? "already" : "not"} connected.`,
      }),
    );
  }
  const config =
    input.method !== undefined &&
    input.values !== undefined &&
    provider.configureWith !== undefined
      ? yield* provider.configureWith(input.profile, {
          method: input.method,
          values: Object.fromEntries(
            Object.entries(input.values).map(([key, value]) => [
              key,
              Redacted.value(value),
            ]),
          ),
        })
      : yield* provider.configure(
          input.profile,
          connected
            ? yield* provider
                .decodeConfig(input.profile, stored.providers[input.provider]!)
                .pipe(Effect.orElseSucceed(() => undefined))
            : undefined,
        );
  yield* profiles.setProviderConfig(input.profile, input.provider, config);
  yield* report({
    _tag: "provider.configure.completed",
    provider: input.provider,
  });
  return yield* get({
    name: input.profile,
    entrypoint: input.entrypoint,
    envFile: input.envFile,
  });
});

/** Log a provider out and disconnect it from the profile. */
export const removeProvider = Effect.fn("Alchemist.profile.removeProvider")(
  function* (
    input: ProviderContext & {
      readonly provider: string;
      readonly logout?: boolean;
    },
  ) {
    const profiles = yield* ProfileStore;
    const stored = yield* profiles.ensureProfile(input.profile);
    const config = stored.providers[input.provider];
    if (config === undefined) {
      return yield* Effect.fail(
        new AlchemistNotFound({ kind: "provider", id: input.provider }),
      );
    }
    const provider = (yield* registry(input))[input.provider];
    let logout: "completed" | "skipped-invalid-config" | "unavailable" =
      "unavailable";
    if (provider !== undefined) {
      const decoded = yield* provider
        .decodeConfig(input.profile, config)
        .pipe(Effect.option);
      if (Option.isSome(decoded)) {
        if (input.logout ?? true)
          yield* provider.logout(input.profile, decoded.value);
        logout = "completed";
      } else logout = "skipped-invalid-config";
    }
    yield* profiles.deleteProviderConfig(input.profile, input.provider);
    return { profile: input.profile, provider: input.provider, logout };
  },
);

/**
 * Re-run login for connected providers without reconfiguring them. Each
 * provider is reported through {@link Progress} as `ProviderRefreshStarted`.
 */
export const refresh = Effect.fn("Alchemist.profile.refresh")(function* (
  input: ProviderContext & {
    readonly providers?: ReadonlyArray<string>;
  },
) {
  const report = yield* Progress;
  const profiles = yield* ProfileStore;
  const stored = yield* profiles.ensureProfile(input.profile);
  const registered = yield* registry(input);
  const requested =
    input.providers === undefined || input.providers.length === 0
      ? Object.keys(stored.providers).sort()
      : input.providers;
  for (const name of requested) {
    const config = stored.providers[name];
    const provider = registered[name];
    if (config === undefined || provider === undefined) {
      return yield* Effect.fail(
        new AlchemistInvalidInput({
          field: "providers",
          message: `Provider '${name}' is not connected or registered.`,
        }),
      );
    }
    yield* report({ _tag: "provider.refresh.started", provider: name });
    const refreshed = yield* provider.login(
      input.profile,
      yield* provider.decodeConfig(input.profile, config),
      (updated) =>
        profiles.setProviderConfig(input.profile, name, updated).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: `Could not persist refreshed ${name} credentials for profile '${input.profile}'.`,
                cause,
              }),
          ),
        ),
    );
    if (refreshed !== undefined) {
      yield* profiles.setProviderConfig(input.profile, name, refreshed);
    }
    yield* report({ _tag: "provider.refresh.completed", provider: name });
  }
  return yield* get({
    name: input.profile,
    entrypoint: input.entrypoint,
    envFile: input.envFile,
  });
});
