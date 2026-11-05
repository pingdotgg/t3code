import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { AuthError, AuthProviders } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import * as Contributions from "../Contributions.ts";
import type { ContributionError } from "../Contributions.ts";
import { makeCachedFunction } from "../Util/cached-function.ts";
import { DEFAULT_ENTRYPOINT, importStack } from "./Entrypoint.ts";
import * as Operations from "./Operations.ts";
import type { Services } from "./Runtime.ts";

// Every auth provider a project can reach: what `alchemy profile` and
// `alchemy provider check-env` list and configure. Collected by building the
// installed providers' auth and the project's providers into one registry.

/** What collecting an auth registry can fail with. */
export type CollectAuthProvidersError = AuthError | ContributionError | PlatformError;

/** What collecting an auth registry runs under. */
export type CollectAuthProvidersServices = Services | Scope.Scope;

type CollectAuthProviders = (
  options: CollectAuthProvidersOptions,
) => Effect.Effect<
  AuthProviders["Service"],
  CollectAuthProvidersError,
  CollectAuthProvidersServices
>;

export interface CollectAuthProvidersOptions {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string;
}

/**
 * Every provider's auth provider, merged into one registering layer. One
 * provider whose auth fails to load is skipped with a warning, so it can't
 * take every other provider's auth down with it.
 */
const contributedAuth = Effect.gen(function* () {
  const layers = yield* Effect.forEach(
    yield* Contributions.load(),
    (provider) =>
      provider.auth
        ? Contributions.resolve(provider, "auth", provider.auth).pipe(
            Effect.catch((error) => Effect.as(Effect.logWarning(error.message), Layer.empty)),
          )
        : Effect.succeed(Layer.empty),
    { concurrency: "unbounded" },
  );
  return Layer.mergeAll(Layer.empty, ...layers);
});

/** Register every installed provider's auth into the ambient registry. */
const registerContributedAuth = Effect.fn("registerContributedAuth")(function* (options: {
  readonly envFile: Option.Option<string>;
  readonly profile: string;
}) {
  const shared = yield* Operations.configServices({
    ...options,
    envFile: Option.getOrUndefined(options.envFile),
  });
  yield* Layer.build(Layer.provide(yield* contributedAuth, shared));
});

const isMissingProviderConfig = Schema.is(
  Schema.Struct({ _tag: Schema.Literals(["MissingProviderConfig"]) }),
);

/**
 * Every auth provider reachable from the current project: the built-ins, plus
 * whatever the user's stack module registers when it is importable.
 */
const collectAuthProvidersUncached = Effect.fn("collectAuthProvidersUncached")(
  function* (options: CollectAuthProvidersOptions) {
    // Everything built below registers into this one registry: the
    // registry layers reuse an ambient registry instead of starting fresh.
    const authProviders: AuthProviders["Service"] = {};
    const collect = Effect.provideService(AuthProviders, authProviders);
    yield* registerContributedAuth(options).pipe(collect);

    const fs = yield* FileSystem.FileSystem;
    const entrypointExists = yield* fs.exists(options.main);
    const missingDefault = options.main === DEFAULT_ENTRYPOINT && !entrypointExists;
    if (!entrypointExists && !missingDefault) {
      return yield* AuthError.make({
        message: `Stack entrypoint '${options.main}' does not exist.`,
      });
    }
    if (!missingDefault) {
      yield* importStack(options.main).pipe(
        Effect.flatMap((stack) =>
          Operations.buildProviders(stack, {
            profile: options.profile,
            envFile: Option.getOrUndefined(options.envFile),
          }),
        ),
        collect,
        Effect.timeoutOption(Duration.seconds(15)),
        Effect.catchCause((cause) => {
          const suppressed = cause.reasons.some((reason) => {
            const error = Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : undefined;
            return isMissingProviderConfig(error);
          });
          return suppressed
            ? Effect.void
            : Effect.fail(
                AuthError.make({
                  message: `Could not load auth providers from '${options.main}'.`,
                  cause,
                }),
              );
        }),
      );
    }
    return authProviders;
  },
  Effect.provideService(SuppressMissingProviderConfig, true),
);

/**
 * Collects auth registries. Uncached by default; {@link authRegistryLayer}
 * memoizes them for its own lifetime.
 */
const AuthRegistry = Context.Reference<CollectAuthProviders>("Alchemy/Alchemist/AuthRegistry", {
  defaultValue: () => collectAuthProvidersUncached,
});

/**
 * Memoize auth registries for one command or API runtime: profile flows
 * collect them repeatedly, and concurrent collections of the same project
 * share one. Registries are built in this layer's scope, so a cached one
 * never outlives the services its providers captured. Failures are not
 * cached.
 */
export const authRegistryLayer = Layer.effect(
  AuthRegistry,
  Effect.map(Effect.scope, (scope) =>
    makeCachedFunction(
      (options: CollectAuthProvidersOptions) =>
        collectAuthProvidersUncached(options).pipe(Scope.provide(scope)),
      {
        key: ([options]) =>
          JSON.stringify([options.main, Option.getOrNull(options.envFile), options.profile]),
      },
    ),
  ),
);

export const collectAuthProviders = (options: CollectAuthProvidersOptions) =>
  Effect.flatMap(AuthRegistry, (collect) => collect(options));
