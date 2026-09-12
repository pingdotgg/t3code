import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { pathToFileURL } from "node:url";
import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext } from "../AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { AuthError, AuthProviders } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import { withProfileOverride } from "../Auth/Resolve.ts";
import { AwsAuth } from "../AWS/AuthProvider.ts";
import { AxiomAuth } from "../Axiom/AuthProvider.ts";
import { CloudflareAuth } from "../Cloudflare/Auth/AuthProvider.ts";
import { FlyAuth } from "../Fly/AuthProvider.ts";
import { GitHubAuth } from "../GitHub/AuthProvider.ts";
import { HetznerAuth } from "../Hetzner/AuthProvider.ts";
import { NeonAuth } from "../Neon/AuthProvider.ts";
import { PlanetscaleAuth } from "../Planetscale/AuthProvider.ts";
import { PrismaAuth } from "../Prisma/AuthProvider.ts";
import { RailwayAuth } from "../Railway/AuthProvider.ts";
import * as Stack from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { Progress } from "./Progress.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";

export class StackEntrypointError extends Data.TaggedError(
  "StackEntrypointError",
)<{ readonly message: string }> {
  readonly [UserFacingError] = true;
}

export const DEFAULT_ENTRYPOINT = "alchemy.run.ts";

/** Stage used by routes that inspect a project without addressing a deployment. */
export const PLACEHOLDER_STAGE = "placeholder";

/**
 * The default export of an `alchemy.run.ts` entrypoint: the stack effect
 * `Alchemy.Stack(...)` returns, carrying the metadata the factory attaches.
 */
export type StackModule = ReturnType<ReturnType<typeof Stack.make>> & {
  readonly stackName: string;
  readonly providers: Layer.Layer<never> | undefined;
  readonly state: Layer.Layer<never> | undefined;
};

export interface StackModuleLoader {
  readonly import: (url: string) => Promise<{ readonly default?: unknown }>;
}

export const StackModuleLoader = Context.Reference<StackModuleLoader>(
  "Alchemy/Alchemist/StackModuleLoader",
  {
    defaultValue: () => ({ import: (url) => import(url) }),
  },
);

export const importStack = Effect.fn(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.resolve(main);
  if (!(yield* fs.exists(absolutePath))) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' does not exist in '${path.dirname(absolutePath)}'. Run this command from an Alchemy project, pass --config <path>, or use --backend aws / --backend cloudflare for config-less state access.`,
      }),
    );
  }
  const loader = yield* StackModuleLoader;
  const module = yield* Effect.promise(() =>
    loader.import(pathToFileURL(absolutePath).href),
  );
  if (
    !Effect.isEffect(module.default) ||
    !Predicate.hasProperty(module.default, "stackName") ||
    typeof module.default.stackName !== "string"
  ) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' must export a default stack definition (export default Alchemy.Stack({...})).`,
      }),
    );
  }
  return module.default as StackModule;
});

/**
 * Which project, stage, and credentials a route acts under. Every route that
 * touches the user's program takes one of these; the optional fields fall back
 * to the same defaults the CLI uses.
 */
export interface Target {
  /** Stack entrypoint. @default "alchemy.run.ts" */
  readonly entrypoint?: string;
  /** Stage the run addresses. @default "placeholder" (routes that never deploy) */
  readonly stage?: string;
  /** Profile whose credentials the run uses. Falls back to the active profile. */
  readonly profile?: string;
  /** `.env` file layered under the process environment. */
  readonly envFile?: string;
}

/** A {@link Target} for a route that genuinely acts on one stack instance. */
export interface StackTarget extends Target {
  readonly entrypoint: string;
  readonly stage: string;
}

export interface OpenOptions {
  /** Run local (emulated) providers instead of the real cloud. */
  readonly dev?: boolean;
  /** Adopt pre-existing cloud resources instead of failing on conflict. */
  readonly adopt?: boolean;
  /** Upgrade an out-of-date state store without prompting. */
  readonly updateStateStore?: boolean;
}

interface SessionServicesOptions {
  readonly envFile: Option.Option<string>;
  readonly profile?: string;
  readonly logger?: Layer.Layer<never, never, never>;
  readonly extra?: Layer.Layer<never, never, never>;
}

/** Shared config and logging services used by every stack/auth build path. */
const sessionServices = Effect.fn("sessionServices")(function* (
  options: SessionServicesOptions,
) {
  return Layer.mergeAll(
    ConfigProvider.layer(
      withProfileOverride(
        yield* loadConfigProvider(options.envFile),
        options.profile,
      ),
    ),
    options.logger ??
      Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
    options.extra ?? Layer.empty,
  );
});

interface RouteCacheService {
  readonly open: (
    target: Target,
    options: OpenOptions,
  ) => Effect.Effect<
    Session,
    Effect.Error<ReturnType<typeof openUncached>>,
    Effect.Services<ReturnType<typeof openUncached>>
  >;
  readonly authProviders: (
    options: CollectAuthProvidersOptions,
  ) => Effect.Effect<
    AuthProviders["Service"],
    Effect.Error<ReturnType<typeof collectAuthProvidersUncached>>,
    Effect.Services<ReturnType<typeof collectAuthProvidersUncached>>
  >;
}

export interface CollectAuthProvidersOptions {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string;
}

const RouteCache = Context.Reference<RouteCacheService>(
  "Alchemy/Alchemist/RouteCache",
  {
    defaultValue: () => ({
      open: (target, options) => openUncached(target, options),
      authProviders: collectAuthProvidersUncached,
    }),
  },
);

const stackSessionKey = (target: Target, options: OpenOptions) =>
  JSON.stringify([
    target.entrypoint ?? DEFAULT_ENTRYPOINT,
    target.stage ?? PLACEHOLDER_STAGE,
    target.profile ?? null,
    target.envFile ?? null,
    options.dev ?? false,
    options.adopt ?? false,
    options.updateStateStore ?? false,
  ]);

const authRegistryKey = (options: CollectAuthProvidersOptions) =>
  JSON.stringify([
    options.main,
    Option.getOrNull(options.envFile),
    options.profile,
  ]);

const cached = <A, E, R>(
  lock: Semaphore.Semaphore,
  entries: Map<string, Effect.Effect<A, E, R>>,
  key: string,
  load: Effect.Effect<A, E, R>,
) =>
  Semaphore.withPermits(
    lock,
    1,
  )(
    Effect.suspend(() => {
      const existing = entries.get(key);
      if (existing !== undefined) return Effect.succeed(existing);
      return Effect.cached(load).pipe(
        Effect.tap((effect) =>
          Effect.sync(() => {
            entries.set(key, effect);
          }),
        ),
      );
    }),
  ).pipe(Effect.flatten);

/** Memoize stack sessions and auth registries for one command or API scope. */
export const routeCacheLayer = Layer.effect(
  RouteCache,
  Effect.sync((): RouteCacheService => {
    const lock = Semaphore.makeUnsafe(1);
    const sessions = new Map<string, ReturnType<typeof openUncached>>();
    const registries = new Map<
      string,
      ReturnType<typeof collectAuthProvidersUncached>
    >();
    return {
      open: (target, options) =>
        cached(
          lock,
          sessions,
          stackSessionKey(target, options),
          openUncached(target, options),
        ),
      authProviders: (options) =>
        cached(
          lock,
          registries,
          authRegistryKey(options),
          collectAuthProvidersUncached(options),
        ),
    };
  }),
);

/**
 * Import the user's stack module and build the services its resources run
 * under. This is the one place that decides what a stack run sees — plan,
 * apply, drift, logs, and state inspection all come through here.
 *
 * The session lives in the surrounding `Scope`; run stack-scoped effects by
 * providing `session.context` (`Effect.provide(effect, session.context)`).
 */
const openUncached = Effect.fn("openStackSessionUncached")(function* (
  target: Target,
  options: OpenOptions = {},
) {
  // Phases are emitted here, at the actual work boundaries, rather than by
  // callers around `open` — the import and the service build both happen
  // inside this function, so only it can time them honestly.
  const report = yield* Progress;
  yield* report({ _tag: "plan.phase", phase: "importing-module" });
  const stackEffect = yield* importStack(
    target.entrypoint ?? DEFAULT_ENTRYPOINT,
  );
  yield* report({ _tag: "plan.phase", phase: "resolving-services" });
  const shared = yield* sessionServices({
    envFile: Option.fromNullishOr(target.envFile),
    profile: target.profile,
  });
  const services = Layer.mergeAll(
    Layer.effect(
      AlchemyContext,
      Effect.map(AlchemyContext, (context) => ({
        ...context,
        dev: options.dev ?? context.dev,
        adopt: options.adopt ?? false,
        updateStateStore: options.updateStateStore ?? false,
      })),
    ),
    Layer.succeedContext(
      Context.make(AdoptPolicy, options.adopt ?? false).pipe(
        Context.add(ArtifactStore, createArtifactStore()),
        Context.add(
          AuthProviders,
          yield* Effect.serviceOption(AuthProviders).pipe(
            Effect.map(Option.getOrElse((): AuthProviders["Service"] => ({}))),
          ),
        ),
        Context.add(Stage, target.stage ?? PLACEHOLDER_STAGE),
      ),
    ),
    shared,
  );
  const sessionContext = yield* Layer.build(services);
  const stack = yield* Effect.provide(stackEffect, sessionContext);
  return {
    stack,
    /**
     * Everything a stack-scoped effect runs under: the stack's own providers
     * and state store over this session's services.
     */
    context: Context.merge(sessionContext, stack.services),
  };
});

/** An imported, fully-configured stack instance. */
export type Session = Effect.Success<ReturnType<typeof openUncached>>;

export const open = Effect.fn("openStackSession")(function* (
  target: Target,
  options: OpenOptions = {},
) {
  return yield* (yield* RouteCache).open(target, options);
});

const placeholderStack = (name: string) => ({
  actions: {},
  bindings: {},
  name,
  resources: {},
  stage: PLACEHOLDER_STAGE,
});

export interface BuildStackProvidersOptions {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile?: string;
  readonly registry?: AuthProviders["Service"];
  readonly logger?: Layer.Layer<never, never, never>;
  readonly extra?: Layer.Layer<never, never, never>;
}

export const buildStackProviders = Effect.fn("buildStackProviders")(function* (
  options: BuildStackProvidersOptions,
) {
  const authProviders = options.registry ?? {};
  const stackEffect = yield* importStack(options.main);
  const shared = yield* sessionServices(options);
  const valueServices = Layer.succeedContext(
    Context.make(AuthProviders, authProviders).pipe(
      Context.add(Stage, PLACEHOLDER_STAGE),
      Context.add(Stack.Stack, placeholderStack(stackEffect.stackName)),
    ),
  );
  const context = yield* Layer.build(
    (stackEffect.providers ?? Layer.empty).pipe(
      Layer.provideMerge(stackEffect.state ?? Layer.empty),
      Layer.provideMerge(Layer.mergeAll(valueServices, shared)),
    ),
  );
  return { authProviders, context, stackEffect };
});

const builtinAuth = Layer.mergeAll(
  AwsAuth,
  AxiomAuth,
  CloudflareAuth,
  FlyAuth,
  GitHubAuth,
  HetznerAuth,
  NeonAuth,
  PlanetscaleAuth,
  PrismaAuth,
  RailwayAuth,
);

const buildBuiltinAuthProviders = Effect.fn("buildBuiltinAuthProviders")(
  function* (options: {
    readonly envFile: Option.Option<string>;
    readonly profile: string;
    readonly registry?: AuthProviders["Service"];
  }) {
    const authProviders = options.registry ?? {};
    const shared = yield* sessionServices(options);
    yield* Layer.build(
      Layer.provide(
        builtinAuth,
        Layer.mergeAll(Layer.succeed(AuthProviders, authProviders), shared),
      ),
    );
    return authProviders;
  },
);

const isMissingProviderConfig = Schema.is(
  Schema.Struct({ _tag: Schema.Literals(["MissingProviderConfig"]) }),
);

/**
 * Every auth provider reachable from the current project: the built-ins, plus
 * whatever the user's stack module registers when it is importable.
 */
const collectAuthProvidersUncached = Effect.fn("collectAuthProvidersUncached")(
  function* (options: CollectAuthProvidersOptions) {
    const authProviders: AuthProviders["Service"] = {};
    yield* buildBuiltinAuthProviders({
      envFile: options.envFile,
      profile: options.profile,
      registry: authProviders,
    });

    const fs = yield* FileSystem.FileSystem;
    const entrypointExists = yield* fs.exists(options.main);
    const missingDefault =
      options.main === DEFAULT_ENTRYPOINT && !entrypointExists;
    if (!entrypointExists && !missingDefault) {
      return yield* Effect.fail(
        new AuthError({
          message: `Stack entrypoint '${options.main}' does not exist.`,
        }),
      );
    }
    if (!missingDefault) {
      yield* buildStackProviders({ ...options, registry: authProviders }).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.catchTag("TimeoutError", () => Effect.void),
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
                new AuthError({
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

export const collectAuthProviders = Effect.fn("collectAuthProviders")(
  function* (options: CollectAuthProvidersOptions) {
    return yield* (yield* RouteCache).authProviders(options);
  },
);
