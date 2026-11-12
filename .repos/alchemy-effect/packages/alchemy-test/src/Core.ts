import { stripVTControlCharacters } from "node:util";
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext, AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { withProfileOverride } from "alchemy/Auth/Resolve";
import { userStage } from "alchemy/Cli/commands/flags";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Contributions from "alchemy/Contributions";
import * as AlchemyDeploy from "alchemy/Deploy";
import * as AlchemyDestroy from "alchemy/Destroy";
import type { Input } from "alchemy/Input";
import * as Interaction from "alchemy/Interaction";
import * as RpcProviderProxy from "alchemy/Local/RpcProviderProxy";
import * as RpcSpawner from "alchemy/Local/RpcSpawner";
import { ALCHEMY_DEV } from "alchemy/Phase";
import * as Plan from "alchemy/Plan";
import type { ResourceSelection, SelectionOutput } from "alchemy/ResourceSelection";
import {
  type CompiledStack,
  make as makeStack,
  Stack,
  type StackDefinition,
  type StackEffect,
  type StackServices,
} from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { loadConfigProvider, StackConfigOverrides } from "alchemy/Util/ConfigProvider";
import { kindOf, recordOf } from "alchemy/Util/LogRecord";
import { PlatformServices } from "alchemy/Util/PlatformServices";
/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Config from "effect/Config";
import { ConfigProvider } from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

/**
 * Configuration shared by every test in a file. Pass to `Test.make(...)`.
 */
export interface MakeOptions<ROut = any> {
  /** Provider layer for the stack — e.g. `AWS.providers()`, `Cloudflare.providers()`. */
  providers: Layer.Layer<ROut, never, StackServices>;
  /** State store for top-level `deploy(Stack)` / `destroy(Stack)`; defaults to {@link State.localState}. */
  state?: Layer.Layer<State.State, never, StackServices>;
  /** Override the current profile; otherwise resolved from env or the built-in `default`. */
  profile?: string;
  /**
   * Default stage for deploy/destroy. Defaults to `test_$USER` (or
   * `test_$USERNAME` on Windows, `test_unknown` if neither is set) so two
   * people running the same suite against one account don't collide.
   * Does **not** read `$ALCHEMY_STAGE` — that is the CLI deploy/dev stage.
   */
  stage?: string;
  /**
   * Engine-level adoption policy for this test run. When `true`, resources
   * without prior state will be adopted from the cloud via `provider.read`
   * (matching the CLI's `--adopt` flag). Defaults to `false`.
   */
  adopt?: boolean;
  /**
   * Run providers in local-dev mode (matching the CLI's `alchemy dev` flag).
   * When `true`, resources like Cloudflare Workers run locally via workerd
   * instead of being deployed to the cloud. When omitted, falls back to the
   * `ALCHEMY_DEV` environment variable (`"1"` / `"true"` enable it).
   *
   * {@link ALCHEMY_TEST_DEV} (`ALCHEMY_TEST_DEV=1`) overrides this — use it
   * to force an entire existing live suite through local providers without
   * editing each `Test.make({ dev: true })`.
   */
  dev?: boolean;
  /**
   * Run local providers behind the RPC sidecar proxy, matching the process
   * topology of the real `alchemy dev` command: an {@link RpcProviderProxy}
   * is installed, so `RpcProvider.providerServicesEffect` layers (e.g.
   * Cloudflare's `localRuntimeServices()`) are EMPTY in the test process and
   * RPC-backed providers run their lifecycle in a spawned sidecar process.
   *
   * Defaults to the resolved `dev` flag — dev tests run the real `alchemy
   * dev` topology unless they opt out. In-process dev (`sidecar: false`)
   * masks missing main-process lifecycle dependencies (the class of bug
   * behind #1007, where D1's local migrations only failed under `alchemy
   * dev`); it remains available because it IS still a real production path —
   * a plain `alchemy deploy` deleting a `providerMode: "local"` state row
   * runs the local provider in-process — and because in-process runs are
   * easier to debug.
   *
   * Fully lazy: only the proxy facade is installed up front. The spawner
   * HTTP server starts — and a sidecar child process is forked — on the
   * first provider session request (a deploy/destroy building an RPC-backed
   * local provider); a dev file that never does starts no processes at all.
   * Once started, the sidecar lives for the whole test file (its own scope,
   * closed by the adapter's final cleanup hook), so `beforeAll(deploy(Stack))`
   * + per-test requests work the same way they do under a real `alchemy dev`
   * session.
   *
   * Pass an object to run the sidecar with options: `omitEnv` lists prefixes
   * of environment variables the sidecar must not inherit (e.g.
   * `["CLOUDFLARE_"]` to exercise credential-free dev while the shell
   * exports credentials).
   */
  sidecar?: boolean | SidecarOptions;
}

/** Options for the dev sidecar process — see {@link MakeOptions.sidecar}. */
export interface SidecarOptions {
  /** Prefixes of environment variables withheld from the sidecar. */
  readonly omitEnv?: ReadonlyArray<string>;
}

/**
 * The RPC sidecar topology used by the real `alchemy dev` command, in one
 * process-local layer: an {@link RpcSpawner} HTTP server that forks sidecar
 * processes on demand, and an {@link RpcProviderProxy} pointed at it.
 */
export const sidecarProxy = (options: { profile?: string; omitEnv?: ReadonlyArray<string> }) =>
  Layer.unwrap(
    Effect.map(RpcSpawner.RpcSpawner, (spawner) => RpcProviderProxy.layer(spawner.url)),
  ).pipe(
    Layer.provideMerge(
      RpcSpawner.layerServer({
        profile: options.profile ?? process.env.ALCHEMY_PROFILE,
        envFile: undefined,
        omitEnv: options.omitEnv,
      }),
    ),
  );

/**
 * Force every `Test.make` into (or out of) local-dev mode, regardless of
 * the file's `dev` option. Unset leaves the option / `ALCHEMY_DEV` fallback
 * in place. Accepts the usual truthy/falsey strings (`true`/`1`/`yes`/`on`,
 * `false`/`0`/`no`/`off`).
 */
export const ALCHEMY_TEST_DEV = Config.Boolean("ALCHEMY_TEST_DEV").pipe(Config.option);

/** The `ALCHEMY_TEST_DEV` override, if the env var is set. */
export const alchemyTestDevOverride = (): Option.Option<boolean> =>
  Effect.runSync(ALCHEMY_TEST_DEV);

/** Resolve the effective `dev` flag: `ALCHEMY_TEST_DEV`, then options, then `ALCHEMY_DEV`. */
export const resolveDev = (options: { dev?: boolean }): boolean => {
  const override = alchemyTestDevOverride();
  if (Option.isSome(override)) return override.value;
  if (options.dev !== undefined) return options.dev;
  return Effect.runSync(ALCHEMY_DEV);
};

/** Resolve the effective `sidecar` flag: defaults to the resolved `dev` flag. */
export const resolveSidecar = (options: MakeOptions): boolean =>
  options.sidecar === undefined ? resolveDev(options) : options.sidecar !== false;

/** The sidecar's withheld env prefixes, sorted so equal sets share a key. */
const sidecarOmitEnv = (options: MakeOptions): ReadonlyArray<string> =>
  typeof options.sidecar === "object" ? [...(options.sidecar.omitEnv ?? [])].sort() : [];

/**
 * Default test stage: `ALCHEMY_TEST_STAGE`, then `test_$USER` (or
 * `test_$USERNAME` / `test_unknown`). The runner sets ALCHEMY_TEST_STAGE to
 * `test_$USER_<worktree>` in a linked git worktree, so concurrent worktrees
 * sharing a cloud account stay isolated.
 * Matches the CLI's `live_$USER` / `dev_$USER` per-developer isolation.
 */
export const defaultStage = (): string =>
  process.env.ALCHEMY_TEST_STAGE || Effect.runSync(userStage("test"));

/** File-level stage: a string override, otherwise {@link defaultStage}. */
export const resolveStage = (options: { stage?: string }): string =>
  // Configured stacks carry a cross-stack reference proxy, not a stage override.
  typeof options.stage === "string" ? options.stage : defaultStage();

/**
 * The sidecar runtime handed to each adapter's `make(...)`.
 *
 * `provide` installs a lazy {@link RpcProviderProxy} facade into an effect.
 * Installing the facade is free: the spawner HTTP server only starts (and,
 * downstream of it, a sidecar child process is only forked) when a provider
 * actually requests a session — i.e. when a deploy/destroy builds an
 * RPC-backed local provider. A dev file that never does starts nothing.
 *
 * The spawner (and the sidecar children it forks) is a PROCESS-WIDE
 * SINGLETON shared by every test file, refcounted per handle: all files run
 * in one bun process, and a per-file sidecar means a per-file bun child that
 * imports the entire alchemy + distilled module graph — dozens of concurrent
 * files at hundreds of MB each OOMs the machine. Stack isolation is
 * preserved because each RPC session carries its own stack environment (see
 * `SESSION_ENV_PARAM` in Local/RpcServerEnvironment.ts) and the child builds
 * a provider context per stack. The singleton's scope closes when the LAST
 * handle closes; `Test.make` runs at collection time (before any test), so
 * the refcount cannot dip to zero while later files still need it. Adapters
 * run `close` from the same final cleanup hook that closes the shared scope.
 */
export interface SidecarHandle {
  readonly provide: <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.Effect<A, any, any>;
  readonly close: Effect.Effect<void>;
}

interface SidecarSingleton {
  readonly real: ReturnType<typeof sidecarProxy>;
  readonly memoMap: Layer.MemoMap;
  readonly scope: Scope.Closeable;
  proxy?: RpcProviderProxy.RpcProviderProxy["Service"];
  refs: number;
}

const sidecarSingletons = new Map<string, SidecarSingleton>();

/** Payload-free counts; observing them never starts the singleton. */
export const sidecarDiagnostics = Effect.gen(function* () {
  const instances = [...sidecarSingletons.values()];
  const counts = { sessions: 0, testSessions: 0, owners: 0, connections: 0 };
  for (const instance of instances) {
    if (instance.proxy === undefined) continue;
    const current = yield* instance.proxy.diagnostics;
    counts.sessions += current.sessions;
    counts.testSessions += current.testSessions;
    counts.owners += current.owners;
    counts.connections += current.connections;
  }
  return {
    singletons: instances.length,
    reservations: instances.reduce((sum, instance) => sum + instance.refs, 0),
    started: instances.filter((instance) => instance.proxy !== undefined).length,
    ...counts,
  };
});

export const makeSidecarHandle = <ROut = any>(
  options: MakeOptions<ROut>,
): SidecarHandle | undefined => {
  if (!resolveSidecar(options)) return undefined;
  const profile = options.profile ?? process.env.ALCHEMY_PROFILE ?? "";
  const omitEnv = sidecarOmitEnv(options);
  // Files only share a sidecar when it was started with the same environment.
  const key = JSON.stringify([profile, omitEnv]);
  let singleton = sidecarSingletons.get(key);
  if (singleton === undefined) {
    singleton = {
      real: sidecarProxy({ profile: options.profile, omitEnv }),
      memoMap: Layer.makeMemoMapUnsafe(),
      scope: Scope.makeUnsafe("sequential"),
      refs: 0,
    };
    sidecarSingletons.set(key, singleton);
  }
  singleton.refs += 1;
  let runtime:
    | {
        instance: SidecarSingleton;
        owner: RpcProviderProxy.SessionOwner;
        contexts: Set<{ ambient?: Context.Context<any> }>;
      }
    | undefined = {
    instance: singleton,
    owner: RpcProviderProxy.makeSessionOwner(),
    contexts: new Set(),
  };
  const lazy = Layer.effect(
    RpcProviderProxy.RpcProviderProxy,
    Effect.gen(function* () {
      if (runtime === undefined) {
        return yield* Effect.die("Test sidecar handle is closed");
      }
      // Never pin the singleton to a file's scope, artifacts, or layer builds.
      const context = {
        ambient: Context.omit(
          Scope.Scope,
          ArtifactStore,
          Layer.CurrentMemoMap,
        )(yield* Effect.context<never>()) as Context.Context<any> | undefined,
      };
      if (runtime === undefined) {
        return yield* Effect.die("Test sidecar handle is closed");
      }
      runtime.contexts.add(context);
      return RpcProviderProxy.RpcProviderProxy.of({
        diagnostics: Effect.suspend(
          () =>
            runtime?.instance.proxy?.diagnostics ??
            Effect.succeed({
              sessions: 0,
              testSessions: 0,
              owners: 0,
              connections: 0,
            }),
        ),
        serverDiagnostics: Effect.suspend(
          () => runtime?.instance.proxy?.serverDiagnostics ?? Effect.succeed(undefined),
        ),
        get: Effect.fn(function* (providersUrl, providerName) {
          if (runtime === undefined) {
            return yield* Effect.die("Test sidecar handle is closed");
          }
          const { instance, owner } = runtime;
          let proxy = instance.proxy;
          if (proxy === undefined) {
            const built = yield* Layer.buildWithMemoMap(
              instance.real,
              instance.memoMap,
              instance.scope,
            ).pipe(
              Effect.provideContext(context.ambient!),
              Scope.provide(instance.scope),
              Effect.orDie,
            );
            proxy = Context.get(built, RpcProviderProxy.RpcProviderProxy);
            instance.proxy = proxy;
          }
          context.ambient = undefined;
          runtime?.contexts.delete(context);
          // A handle may have closed while the singleton was building.
          return yield* proxy.get(providersUrl, providerName, owner);
        }),
      });
    }),
  );
  return {
    provide: (eff) => Effect.provide(eff, lazy),
    close: Effect.suspend(() => {
      if (runtime === undefined) return Effect.void;
      const { instance, owner, contexts } = runtime;
      runtime = undefined;
      for (const context of contexts) context.ambient = undefined;
      contexts.clear();
      return RpcProviderProxy.closeSessionOwner(owner).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            instance.refs -= 1;
            if (instance.refs > 0) return Effect.void;
            if (sidecarSingletons.get(key) === instance) sidecarSingletons.delete(key);
            instance.proxy = undefined;
            return Scope.close(instance.scope, Exit.void);
          }),
        ),
      );
    }).pipe(Effect.uninterruptible, Effect.ignore),
  };
};

const overrideAlchemyContext = (overrides: { dev: boolean }) =>
  Layer.effect(
    AlchemyContext,
    AlchemyContext.pipe(Effect.map((ctx) => ({ ...ctx, ...overrides }))),
  );

export type TestEffect<A, Req = never> = StackEffect<A, any, Req>;

const testDev = Option.getOrElse(alchemyTestDevOverride(), () => false);

/**
 * Every provider's test services (e.g. AWS's Floci emulator), applied under
 * {@link ALCHEMY_TEST_DEV} only.
 */
const testServices: ReadonlyArray<Contributions.TestServices> = testDev
  ? await Effect.runPromise(
      Contributions.load().pipe(
        Effect.flatMap((providers) =>
          Effect.forEach(providers, (provider) =>
            provider.testServices
              ? Contributions.resolve(provider, "testServices", provider.testServices)
              : Effect.succeed(undefined),
          ),
        ),
        Effect.map((services) => services.filter((service) => service !== undefined)),
        Effect.provide(PlatformServices),
      ),
    )
  : [];

if (testDev) {
  // Emulators rewrite WebSocket invoke URLs onto their self-signed gateway;
  // Bun/Node would otherwise reject the upgrade. Scoped to ALCHEMY_TEST_DEV
  // only.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  // Set here — before the RPC spawner or any vite child forks — so the whole
  // dev process tree inherits it.
  for (const services of testServices) {
    for (const [key, value] of Object.entries(services.env ?? {})) process.env[key] ??= value;
  }
}

/** The test services' layers, closest wins over the stack's own. */
const testServicesLayer =
  testServices.length === 0
    ? undefined
    : testServices
        .map((services) => services.layer)
        .reduce((merged, layer) => Layer.merge(merged, layer));

const provideTestServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // Test services override services already present in R.
  testServicesLayer === undefined
    ? effect
    : // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the layer overrides services already present in R
      (Effect.provide(effect, testServicesLayer) as Effect.Effect<A, E, R>);

const testHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    testServices.reduce(
      (mapped, services) =>
        services.mapRequest ? HttpClient.mapRequest(mapped, services.mapRequest) : mapped,
      client,
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const platformLayer = () =>
  Layer.mergeAll(
    PlatformServices,
    testDev ? testHttp : FetchHttpClient.layer,
    Layer.provide(ProfileStoreLive, PlatformServices),
    Layer.provide(CredentialsStoreLive, PlatformServices),
  );

const alchemyLayer = Layer.mergeAll(
  LoggingCli,
  Interaction.layerNonInteractive(),
  AlchemyContextLive,
);

/** Most lines one capture keeps; older ones are dropped first. */
const RESOURCE_LOG_LIMIT = 5_000;

/** The open {@link captureResourceLog} buffers, by resource fqn. */
const resourceCaptures = new Map<string, Set<Array<string>>>();

/**
 * Copies each record tagged with a captured resource (`fqn`) into its open
 * captures. Installed beside the runner's loggers, so it also sees the shared
 * sidecar's records, which the spawner logs in whichever file started the
 * sidecar rather than in the test that deployed the resource.
 */
const resourceRecorder = Logger.make<unknown, void>((options) => {
  if (resourceCaptures.size === 0) return;
  const record = recordOf(options);
  const fqn = record.attributes.fqn;
  const captures = typeof fqn === "string" ? resourceCaptures.get(fqn) : undefined;
  if (captures === undefined || (record.kind !== "log" && record.kind !== "output")) return;
  const line = stripVTControlCharacters(
    record.kind === "log" ? record.data.message : record.data.text,
  );
  for (const lines of captures) {
    lines.push(line);
    if (lines.length > RESOURCE_LOG_LIMIT) lines.splice(0, lines.length - RESOURCE_LOG_LIMIT);
  }
});

/**
 * Start capturing what the resource `fqn` logs — its processes' output (a dev
 * Worker's console, a Vite dev server) and alchemy's lines about it — whether
 * its provider runs in the dev sidecar or in-process. Start it before the
 * deploy; the returned effect reads every line since, without ANSI styling.
 * The capture ends with the enclosing scope.
 */
export const captureResourceLog = (
  fqn: string,
): Effect.Effect<Effect.Effect<string>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const lines: Array<string> = [];
      let captures = resourceCaptures.get(fqn);
      if (captures === undefined) resourceCaptures.set(fqn, (captures = new Set()));
      captures.add(lines);
      return lines;
    }),
    (lines) =>
      Effect.sync(() => {
        const captures = resourceCaptures.get(fqn);
        captures?.delete(lines);
        if (captures?.size === 0) resourceCaptures.delete(fqn);
      }),
  ).pipe(Effect.map((lines) => Effect.sync(() => lines.join("\n"))));

/**
 * The runner's loggers, minus typed event records: deploys draw their
 * progress through `AlchemyDeploy.applyAndRender` (the `LoggingCli` lines), so printing each
 * event object too would only repeat it. `onEvent` subscribers installed
 * inside still see every event. Adds the {@link resourceRecorder}.
 */
const withoutEventRecords = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Logger.CurrentLoggers, (loggers) =>
    effect.pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          ...[...loggers]
            .filter((logger) => logger !== resourceRecorder)
            .map((logger) =>
              Logger.make<unknown, void>((options) => {
                if (kindOf(options) !== "event") logger.log(options);
              }),
            ),
          resourceRecorder,
        ]),
      ),
    ),
  );

/**
 * Build the per-test runtime and return a self-contained Effect.
 *
 * Mirrors {@link "../bin/alchemy.js"} composition: ConfigProvider via
 * `loadConfigProvider` + `withProfileOverride`, an empty `AuthProviders`
 * registry that the user's `providers` layer populates, the platform layers,
 * and the configured state store. Adapters wrap this into runner-specific
 * thunks (`bun.test` -> `runPromise`, `it.live` -> as-is).
 *
 * When `scope` is provided, scoped resources (like the Cloudflare dev
 * sidecar) survive past this effect and are tied to the lifetime of the
 * provided scope instead. The runner is responsible for closing it.
 *
 * When `scope` is omitted, the effect runs with `Effect.scoped` and any
 * scoped resources are torn down as soon as it resolves.
 */
export const toEffect = <A, ROut = any>(
  effect: TestEffect<A>,
  options: MakeOptions<ROut>,
  scope?: Scope.Scope,
  sidecar?: SidecarHandle,
): Effect.Effect<A, any, never> => {
  const base = Effect.gen(function* () {
    const cfg = yield* loadConfigProvider(Option.none());
    const configProvider = withProfileOverride(cfg, options.profile);
    // `ALCHEMY_TEST_DEV=1` forces local providers AND points the test
    // process's distilled AWS clients at the emulator. Otherwise
    // out-of-band `describeTable` / `getFunction` calls still hit the
    // live account and fail with ResourceNotFound. Existing
    // `Test.make({ dev: true })` files are unchanged (mixed
    // `Alchemy.remote()` suites keep their live SDK).
    const body = sidecar ? sidecar.provide(effect) : effect;
    const locally = testDev ? provideTestServices(body) : body;
    return yield* locally.pipe(
      withoutEventRecords,
      provideFreshArtifactStore,
      Effect.provideService(ConfigProvider, configProvider),
      Effect.provideService(StackConfigOverrides, { profile: options.profile }),
    );
  }).pipe(
    Effect.provideService(AdoptPolicy, options.adopt ?? false),
    Effect.provide(overrideAlchemyContext({ dev: resolveDev(options) })),
    // `options.state` (e.g. `Cloudflare.state()`) itself requires
    // `AuthProviders` to read credentials, so AuthProviders must be provided
    // AFTER the state layer or the state layer's requirement is never
    // satisfied — which surfaces as `Service not found: AuthProviders`.
    Effect.provide(options.state ?? State.localState()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide(Layer.provideMerge(alchemyLayer, platformLayer())),
  );

  return (scope === undefined ? Effect.scoped(base) : Scope.provide(base, scope)) as Effect.Effect<
    A,
    any,
    never
  >;
};

/** Promise wrapper around {@link toEffect} for `bun.test`-style runners. */
export const run = <A, ROut = any>(
  effect: TestEffect<A>,
  options: MakeOptions<ROut>,
  scope?: Scope.Scope,
  sidecar?: SidecarHandle,
): Promise<A> => Effect.runPromise(toEffect(effect, options, scope, sidecar));

/**
 * Wrap an effect so it runs with `options.providers` + a placeholder Stack +
 * Stage in scope. Used by `test.provider` so user code can call provider SDK
 * APIs (e.g. `DynamoDB.describeTable`) directly inside the test body.
 */
export const withProviders = <A, E, R, ROut>(
  effect: Effect.Effect<A, E, R>,
  options: MakeOptions<ROut>,
  stackName: string,
): Effect.Effect<A, E, Exclude<R, ROut | Stack | Stage>> => {
  // Closest wins: when `ALCHEMY_TEST_DEV=1`, pin the test body's
  // distilled AWS clients to the emulator BEFORE `options.providers`
  // (which still carries the live `AWSEnvironment`).
  const body = testDev ? provideTestServices(effect) : effect;
  const stage = resolveStage(options);
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- providers layer is typed `any`; requirements are satisfied by it
  return body.pipe(
    Effect.provide(
      (options.providers as Layer.Layer<any, never, any>).pipe(
        Layer.provideMerge(
          Layer.succeed(Stack, {
            name: stackName,
            stage,
            resources: {},
            bindings: {},
            actions: {},
          }),
        ),
        Layer.provideMerge(Layer.succeed(Stage, stage)),
      ),
    ),
  ) as Effect.Effect<A, E, Exclude<R, ROut | Stack | Stage>>;
};

/**
 * Curried `deploy` for the test factory: bakes in the configured stage and
 * adds the telemetry layer the CLI uses, so `beforeAll(deploy(Stack))` works
 * the same way as `alchemy deploy`.
 *
 * `scope`, when supplied, is forwarded down so the dev sidecar (and other
 * scoped resources) lives until the caller closes it instead of dying as
 * soon as `deploy` resolves. The test harness uses this to keep workerd
 * alive across `beforeAll` → tests → `afterAll`.
 */
export interface DeployCallOptions extends Plan.MakePlanOptions {
  stage?: string;
  scope?: Scope.Scope;
}

export type DeployResult<A> = Effect.Effect<
  Input.Resolve<A>,
  Effect.Error<ReturnType<typeof deployStack<A>>>,
  Effect.Services<ReturnType<typeof deployStack<A>>>
>;

export interface FilteredDeployCallOptions
  extends Omit<DeployCallOptions, keyof ResourceSelection>, ResourceSelection {}

type FullDeployCall = [options?: DeployCallOptions];

/**
 * Filtered deploys return void; the whole declaration still evaluates.
 * With an explicit output type, filtering also requires the Call tuple type.
 */
export interface Deploy {
  <A, Call extends [options?: FilteredDeployCallOptions] = FullDeployCall>(
    stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
    ...call: Call
  ): DeployResult<SelectionOutput<A, Call[0]>>;
}

export function deploy<A, Call extends [options?: FilteredDeployCallOptions] = FullDeployCall>(
  options: MakeOptions,
  stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
  ...call: Call
): DeployResult<SelectionOutput<A, Call[0]>>;
export function deploy<A>(
  options: MakeOptions,
  stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
  callOptions?: FilteredDeployCallOptions,
) {
  return deployStack(options, stack, callOptions);
}

const deployStack = <A>(
  options: MakeOptions,
  stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
  callOptions?: FilteredDeployCallOptions,
) =>
  AlchemyDeploy.deploy({
    stack: stack as Effect.Effect<CompiledStack<A>, never, any>,
    stage: callOptions?.stage ?? resolveStage(options),
    dev: resolveDev(options),
    scope: callOptions?.scope,
    force: callOptions?.force,
    include: callOptions?.include,
    exclude: callOptions?.exclude,
  }).pipe(Effect.provide(TelemetryLive));

/** Bind test-file options and the shared runtime scope without erasing output types. */
export const makeDeploy = (options: MakeOptions, scope: Scope.Scope): Deploy => {
  function run<A, Call extends [options?: FilteredDeployCallOptions] = FullDeployCall>(
    stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
    ...call: Call
  ): DeployResult<SelectionOutput<A, Call[0]>>;
  function run<A>(
    stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
    callOptions?: FilteredDeployCallOptions,
  ) {
    return deployStack(options, stack, { ...callOptions, scope });
  }
  return run;
};

export const destroy = <ROut>(
  options: MakeOptions,
  stack: StackDefinition<ROut>,
  callOptions?: { stage?: string; scope?: Scope.Scope; include?: never; exclude?: never },
) =>
  AlchemyDestroy.destroy({
    include: callOptions?.include,
    exclude: callOptions?.exclude,
    stack,
    stage: callOptions?.stage ?? resolveStage(options),
    dev: resolveDev(options),
    scope: callOptions?.scope,
  }).pipe(Effect.provide(TelemetryLive));

/**
 * In-test scratch stack handed to `test.provider(name, (stack) => ...)`.
 *
 * Each scratch stack owns a private state store that is shared between
 * successive `deploy`/`destroy` calls AND visible to the user's test body
 * (so `yield* State` / `state.get(...)` see the same store the deploys
 * mutated). This makes create / update / replace / delete paths exercisable
 * without polluting other tests in the same file.
 *
 * When the adapter can name the test file (the alchemy-test runner), the
 * store is DURABLE — rows live under `.alchemy/state/{file}-{test}/{stage}`
 * on disk. Durability is what makes an interrupted destroy recoverable: the
 * engine persists a `deleting` row before every `provider.delete` and only
 * drops it on success, so a run killed mid-delete (e.g. the runner's
 * teardown-abandonment after a test timeout) leaves resumable rows that the
 * NEXT run's leading `stack.destroy()` (or the `Effect.ensuring` teardown)
 * picks up and drains. An in-memory scratch dies with the process, silently
 * orphaning every cloud resource whose delete was still in flight.
 */
export interface ScratchStack<ROut = any> {
  readonly name: string;
  /** Stage this scratch deploys to ({@link resolveStage} of the file options). */
  readonly stage: string;
  /** The shared in-memory state Layer for this scratch. @internal */
  readonly state: Layer.Layer<State.State, never, never>;
  /** Filters leave other rows and stack outputs untouched; declaration still runs. */
  deploy<A, E, R, Call extends [options?: Plan.FilteredPlanOptions] = []>(
    effect: Effect.Effect<A, E, R>,
    ...call: Call
  ): Effect.Effect<
    SelectionOutput<Input.Resolve<A>, Call[0]>,
    any,
    Exclude<R, ROut | StackServices>
  >;
  /**
   * Build a plan against the scratch's shared state WITHOUT applying it.
   *
   * Use this to assert on the planned action for a resource (e.g. that a
   * downstream dependency stays `noop` when only an upstream resource
   * changes) without mutating the cloud. Plans run against whatever state
   * prior `deploy(...)` calls persisted.
   */
  plan<A, E, R, Call extends [options?: Plan.FilteredPlanOptions] = []>(
    effect: Effect.Effect<A, E, R>,
    ...call: Call
  ): Effect.Effect<Plan.Plan<SelectionOutput<A, Call[0]>>, any, Exclude<R, ROut | StackServices>>;
  destroy(options?: { include?: never; exclude?: never }): Effect.Effect<void, any, never>;
}

const sanitizeStackName = (name: string) =>
  name.replaceAll(/[^a-zA-Z0-9_]/g, "-").replace(/-+/g, "-");

/**
 * Turn a test-file path (relative to the run root) into a stack-name
 * namespace: `test/AWS/Website/Router.test.ts` -> `AWS/Website/Router`.
 * Test names repeat across files (e.g. "create and delete bucket with
 * default props"), so the durable per-test store MUST be namespaced by file
 * or two concurrently-running same-named tests would read, write and — far
 * worse — destroy each other's rows.
 */
const scratchNamespace = (file: string) =>
  file.replace(/^test[/\\]/, "").replace(/\.test\.ts$/, "");

/**
 * Build a fresh `ScratchStack` for `test.provider`.
 *
 * With `file` (the registration-time test file, supplied by the
 * alchemy-test adapter): the store is the durable `.alchemy/state` local
 * store and the stack name is namespaced by file so interrupted destroys
 * leave resumable rows for the next run (see {@link ScratchStack}).
 *
 * Without `file` (bun/vitest adapters, which cannot name their file at
 * registration time): falls back to a private in-memory store — isolated,
 * but discarded with the process.
 */
export const scratchStack = <ROut>(
  options: MakeOptions<ROut>,
  name: string,
  file?: string,
): ScratchStack<ROut> => {
  const stage = resolveStage(options);
  const stackName = sanitizeStackName(
    file === undefined ? name : `${scratchNamespace(file)}-${name}`,
  );
  const stateLayer: Layer.Layer<State.State> =
    file === undefined
      ? Layer.succeed(State.State, State.InMemoryService({}))
      : Layer.provide(State.localState(), PlatformServices);

  // `withProviders` already pins the test body to the test services, but the
  // stack program and its later plan/apply phase run under the providers'
  // live services. Pin both phases separately: Actions execute during apply,
  // after the stack program has finished. This override must be inside
  // `compiled.services` so Effect's closest-layer precedence selects the test
  // services for Action data-plane calls.
  const pinToTestServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    testDev ? provideTestServices(effect) : effect;

  // TODO(unify stack builds): build scratch stacks through `Alchemist.plan` /
  // `Alchemist.apply` instead of `makeStack` and the hand-built destroy layers
  // below (which skip the stack's secrets and auth providers); see the TODO in
  // `alchemy/src/EvalStack.ts`.
  const buildAndApply = (
    effect: Effect.Effect<any, any, any>,
    planOptions?: Plan.FilteredPlanOptions,
  ) =>
    (pinToTestServices(effect) as Effect.Effect<any, any, never>).pipe(
      makeStack({ name: stackName, providers: options.providers, state: stateLayer } as any) as any,
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled, planOptions ?? {}).pipe(
          Effect.flatMap(AlchemyDeploy.applyAndRender),
          pinToTestServices,
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provideService(Stage, stage),
      provideFreshArtifactStore,
    );

  const buildPlan = (
    effect: Effect.Effect<any, any, any>,
    planOptions?: Plan.FilteredPlanOptions,
  ) =>
    (pinToTestServices(effect) as Effect.Effect<any, any, never>).pipe(
      makeStack({ name: stackName, providers: options.providers, state: stateLayer } as any) as any,
      Effect.flatMap((compiled: any) =>
        pinToTestServices(Plan.make(compiled, planOptions ?? {})).pipe(
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provideService(Stage, stage),
      provideFreshArtifactStore,
    );

  return {
    name: stackName,
    stage,
    state: stateLayer,
    deploy: ((effect: Effect.Effect<any, any, any>, planOptions?: Plan.FilteredPlanOptions) =>
      buildAndApply(effect, planOptions)) as ScratchStack<ROut>["deploy"],
    plan: ((effect: Effect.Effect<any, any, any>, planOptions?: Plan.FilteredPlanOptions) =>
      buildPlan(effect, planOptions)) as ScratchStack<ROut>["plan"],
    destroy: (callOptions) =>
      callOptions?.include !== undefined || callOptions?.exclude !== undefined
        ? Effect.die(
            new Plan.InvalidResourceSelection({ message: "Filtered destroy is not supported." }),
          )
        : (Plan.destroy({ name: stackName, stage }).pipe(
            Effect.flatMap(AlchemyDeploy.applyAndRender),
            Effect.asVoid,
            Effect.provide(
              stateLayer.pipe(
                Layer.provideMerge(options.providers as Layer.Layer<any, never, any>),
                Layer.provideMerge(
                  Layer.succeed(Stack, {
                    name: stackName,
                    stage,
                    resources: {},
                    bindings: {},
                    actions: {},
                  }),
                ),
                Layer.provideMerge(Layer.succeed(Stage, stage)),
              ),
            ),
            provideFreshArtifactStore,
          ) as Effect.Effect<void, any, never>),
  };
};
