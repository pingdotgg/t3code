/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Floci from "@alchemy.run/floci";
import * as Config from "effect/Config";
import { ConfigProvider } from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { DEFAULT_LOCAL_ENDPOINT } from "../AWS/AuthProvider.ts";
import { flociServices } from "../AWS/Local/FlociServices.ts";
import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext, AlchemyContextLive } from "../AlchemyContext.ts";
import { apply } from "../Apply.ts";
import { provideFreshArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive, withProfileOverride } from "../Auth/Profile.ts";
import { LoggingCli } from "../Cli/LoggingCli.ts";
import { deploy as _deploy } from "../Deploy.ts";
import { destroy as _destroy } from "../Destroy.ts";
import type { Input } from "../Input.ts";
import * as RpcProviderProxy from "../Local/RpcProviderProxy.ts";
import * as RpcSpawner from "../Local/RpcSpawner.ts";
import { ALCHEMY_DEV } from "../Phase.ts";
import * as Plan from "../Plan.ts";
import {
  type CompiledStack,
  make as makeStack,
  Stack,
  type StackEffect,
  type StackServices,
} from "../Stack.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { TelemetryLive } from "../Telemetry/Layer.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";

/**
 * Configuration shared by every test in a file. Pass to `Test.make(...)`.
 */
export interface MakeOptions<ROut = any> {
  /** Provider layer for the stack — e.g. `AWS.providers()`, `Cloudflare.providers()`. */
  providers: Layer.Layer<ROut, never, StackServices>;
  /** State store for top-level `deploy(Stack)` / `destroy(Stack)`; defaults to {@link State.localState}. */
  state?: Layer.Layer<State.State, never, StackServices>;
  /** Override `ALCHEMY_PROFILE`; otherwise resolved from env / .env. */
  profile?: string;
  /** Default stage for deploy/destroy (default `"test"`). */
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
   */
  sidecar?: boolean;
}

/**
 * The RPC sidecar topology used by the real `alchemy dev` command, in one
 * process-local layer: an {@link RpcSpawner} HTTP server that forks sidecar
 * processes on demand, and an {@link RpcProviderProxy} pointed at it.
 */
export const sidecarProxy = (options: { profile?: string }) =>
  Layer.unwrap(
    Effect.map(RpcSpawner.RpcSpawner, (spawner) =>
      RpcProviderProxy.layer(spawner.url),
    ),
  ).pipe(
    Layer.provideMerge(
      RpcSpawner.layerServer({
        profile: options.profile ?? process.env.ALCHEMY_PROFILE,
        envFile: undefined,
      }),
    ),
  );

/**
 * Force every `Test.make` into (or out of) local-dev mode, regardless of
 * the file's `dev` option. Unset leaves the option / `ALCHEMY_DEV` fallback
 * in place. Accepts the usual truthy/falsey strings (`true`/`1`/`yes`/`on`,
 * `false`/`0`/`no`/`off`).
 */
export const ALCHEMY_TEST_DEV = Config.boolean("ALCHEMY_TEST_DEV").pipe(
  Config.option,
);

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
  options.sidecar ?? resolveDev(options);

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
  readonly provide: <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, any, any>;
  readonly close: Effect.Effect<void>;
}

interface SidecarSingleton {
  readonly lazy: Layer.Layer<RpcProviderProxy.RpcProviderProxy>;
  readonly scope: Scope.Closeable;
  refs: number;
}

const sidecarSingletons = new Map<string, SidecarSingleton>();

export const makeSidecarHandle = <ROut = any>(
  options: MakeOptions<ROut>,
): SidecarHandle | undefined => {
  if (!resolveSidecar(options)) return undefined;
  const key = options.profile ?? process.env.ALCHEMY_PROFILE ?? "";
  let singleton = sidecarSingletons.get(key);
  if (singleton === undefined) {
    const scope = Scope.makeUnsafe("sequential");
    const memoMap = Layer.makeMemoMapUnsafe();
    const real = sidecarProxy(options);
    const lazy = Layer.effect(
      RpcProviderProxy.RpcProviderProxy,
      Effect.gen(function* () {
        // Capture the ambient platform context (provided by `toEffect`) so
        // the deferred spawner build can run inside a provider's `get`
        // without leaking platform requirements onto the RpcProviderProxy
        // interface. Omit Scope: that key is the calling file's sharedScope
        // (closed in afterAll). Merging it in would pin the process-wide
        // spawner HTTP server to a file that exits while others still need
        // it. Provide the sidecar singleton scope instead.
        const ambient = Context.omit(Scope.Scope)(
          yield* Effect.context<never>(),
        );
        const realProxy = Layer.buildWithMemoMap(real, memoMap, scope).pipe(
          Effect.map((built) =>
            Context.get(built, RpcProviderProxy.RpcProviderProxy),
          ),
          Effect.provideContext(ambient as Context.Context<any>),
          Scope.provide(scope),
          Effect.orDie,
        );
        return RpcProviderProxy.RpcProviderProxy.of({
          get: (serverEntryUrl, providerName) =>
            Effect.flatMap(realProxy, (proxy) =>
              proxy.get(serverEntryUrl, providerName),
            ),
        });
      }),
    );
    singleton = { lazy, scope, refs: 0 };
    sidecarSingletons.set(key, singleton);
  }
  singleton.refs += 1;
  const instance = singleton;
  let closed = false;
  return {
    provide: (eff) => Effect.provide(eff, instance.lazy),
    close: Effect.suspend(() => {
      // Idempotent per handle: destroy(Stack) and the fallback afterAll can
      // both run it without double-decrementing.
      if (closed) return Effect.void;
      closed = true;
      instance.refs -= 1;
      if (instance.refs > 0) return Effect.void;
      if (sidecarSingletons.get(key) === instance) {
        sidecarSingletons.delete(key);
      }
      return Scope.close(instance.scope, Exit.void);
    }).pipe(Effect.ignore),
  };
};

const overrideAlchemyContext = (overrides: { dev: boolean }) =>
  Layer.effect(
    AlchemyContext,
    AlchemyContext.pipe(Effect.map((ctx) => ({ ...ctx, ...overrides }))),
  );

export type TestEffect<A, Req = never> = StackEffect<A, any, Req>;

/**
 * Floci serves virtual-host data planes on the gateway when the Host
 * header is the AWS hostname (`{bucket}.s3-website-{region}.amazonaws.com`,
 * `{apiId}.appsync-api.{region}.amazonaws.com`,
 * `{apiId}.execute-api.{region}.amazonaws.com`,
 * `{distributionId}.cloudfront.net`). Live tests GET those hosts; under
 * {@link ALCHEMY_TEST_DEV} rewrite the URL to the emulator and keep the
 * Host so the virtual-host filter still fires.
 */
const rewriteAwsVirtualHostToFloci = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return request;
  }
  if (
    !/\.s3-website-[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
    !/\.appsync-api\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
    !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
    !/\.cloudfront\.net$/i.test(url.hostname)
  ) {
    return request;
  }
  const rewritten = new URL(url.href);
  const endpoint = new URL(DEFAULT_LOCAL_ENDPOINT);
  rewritten.protocol = endpoint.protocol;
  rewritten.hostname = endpoint.hostname;
  rewritten.port = endpoint.port;
  return request.pipe(
    HttpClientRequest.setUrl(rewritten.toString()),
    HttpClientRequest.setHeader("host", url.hostname),
  );
};

if (Option.getOrElse(alchemyTestDevOverride(), () => false)) {
  // Floci rewrites WebSocket invoke URLs onto wss://127.0.0.1:4566/ws/...
  // The gateway cert is self-signed; Bun/Node would otherwise reject the
  // upgrade. Scoped to ALCHEMY_TEST_DEV only.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  // Local workerd trusts no self-signed certs and ignores the flag above
  // (it's C++, not Node). Its runtime DOES fold `NODE_EXTRA_CA_CERTS` into
  // workerd's outbound `trustedCertificates` (see cloudflare-runtime
  // Internet.ts), so point it at the emulator CA bundle that `ensureFloci`
  // refreshes on every health check. Set here — before the RPC spawner or
  // any vite child forks — so the whole dev process tree inherits it.
  process.env.NODE_EXTRA_CA_CERTS ??= Floci.FLOCI_CA_PATH;
}

const flociWebsiteHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.mapRequest(client, rewriteAwsVirtualHostToFloci),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const platformLayer = () =>
  Layer.mergeAll(
    PlatformServices,
    Option.getOrElse(alchemyTestDevOverride(), () => false)
      ? flociWebsiteHttp
      : FetchHttpClient.layer,
    Layer.provide(ProfileLive, PlatformServices),
    Layer.provide(CredentialsStoreLive, PlatformServices),
  );

const alchemyLayer = Layer.mergeAll(LoggingCli, AlchemyContextLive);

/**
 * Build the per-test runtime and return a self-contained Effect.
 *
 * Mirrors {@link "../bin/alchemy.ts"} composition: ConfigProvider via
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
    const locally =
      Option.getOrElse(alchemyTestDevOverride(), () => false) === true
        ? Effect.provide(body, flociServices())
        : body;
    return yield* locally.pipe(
      provideFreshArtifactStore,
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
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

  return (
    scope === undefined ? Effect.scoped(base) : Scope.provide(base, scope)
  ) as Effect.Effect<A, any, never>;
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
  const body =
    Option.getOrElse(alchemyTestDevOverride(), () => false) === true
      ? Effect.provide(effect, flociServices())
      : effect;
  return body.pipe(
    Effect.provide(
      (options.providers as Layer.Layer<any, never, any>).pipe(
        Layer.provideMerge(
          Layer.succeed(Stack, {
            name: stackName,
            stage: options.stage ?? "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
        ),
        Layer.provideMerge(Layer.succeed(Stage, options.stage ?? "test")),
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
export const deploy = <A>(
  options: MakeOptions,
  stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
  callOptions?: { stage?: string; scope?: Scope.Scope },
) =>
  _deploy({
    stack: stack as Effect.Effect<CompiledStack<A>, never, any>,
    stage: callOptions?.stage ?? options.stage ?? "test",
    dev: resolveDev(options),
    scope: callOptions?.scope,
  }).pipe(Effect.provide(TelemetryLive));

export const destroy = (
  options: MakeOptions,
  stack: TestEffect<CompiledStack, Stage | AlchemyContext>,
  callOptions?: { stage?: string; scope?: Scope.Scope },
) =>
  _destroy({
    stack: stack as Effect.Effect<CompiledStack, never, any>,
    stage: callOptions?.stage ?? options.stage ?? "test",
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
  /** The shared in-memory state Layer for this scratch. @internal */
  readonly state: Layer.Layer<State.State, never, never>;
  deploy<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Input.Resolve<A>, any, Exclude<R, ROut | StackServices>>;
  /**
   * Build a plan against the scratch's shared state WITHOUT applying it.
   *
   * Use this to assert on the planned action for a resource (e.g. that a
   * downstream dependency stays `noop` when only an upstream resource
   * changes) without mutating the cloud. Plans run against whatever state
   * prior `deploy(...)` calls persisted.
   */
  plan<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Plan.Plan<A>, any, Exclude<R, ROut | StackServices>>;
  destroy(): Effect.Effect<void, any, never>;
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
  const stage = options.stage ?? "test";
  const stackName = sanitizeStackName(
    file === undefined ? name : `${scratchNamespace(file)}-${name}`,
  );
  const stateLayer: Layer.Layer<State.State> =
    file === undefined
      ? Layer.succeed(State.State, State.InMemoryService({}))
      : Layer.provide(State.localState(), PlatformServices);

  // `withProviders` already pins the test body to Floci, but the stack program
  // and its later plan/apply phase run under `AWS.providers()`'s live services.
  // Pin both phases separately: Actions execute during apply, after the stack
  // program has finished. This override must be inside `compiled.services` so
  // Effect's closest-layer precedence selects Floci for Action data-plane calls.
  const pinToFloci = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Option.getOrElse(alchemyTestDevOverride(), () => false)
      ? (Effect.provide(effect, flociServices()) as Effect.Effect<A, E, R>)
      : effect;

  const buildAndApply = (effect: Effect.Effect<any, any, any>) =>
    (pinToFloci(effect) as Effect.Effect<any, any, never>).pipe(
      makeStack({
        name: stackName,
        providers: options.providers,
        state: stateLayer,
      } as any) as any,
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled).pipe(
          Effect.flatMap(apply),
          pinToFloci,
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provide(Layer.succeed(Stage, stage)),
      provideFreshArtifactStore,
    );

  const buildPlan = (effect: Effect.Effect<any, any, any>) =>
    (pinToFloci(effect) as Effect.Effect<any, any, never>).pipe(
      makeStack({
        name: stackName,
        providers: options.providers,
        state: stateLayer,
      } as any) as any,
      Effect.flatMap((compiled: any) =>
        pinToFloci(Plan.make(compiled)).pipe(Effect.provide(compiled.services)),
      ),
      Effect.provide(Layer.succeed(Stage, stage)),
      provideFreshArtifactStore,
    );

  return {
    name: stackName,
    state: stateLayer,
    deploy: ((effect: Effect.Effect<any, any, any>) =>
      buildAndApply(effect)) as ScratchStack<ROut>["deploy"],
    plan: ((effect: Effect.Effect<any, any, any>) =>
      buildPlan(effect)) as ScratchStack<ROut>["plan"],
    destroy: () =>
      Plan.destroy({ name: stackName, stage }).pipe(
        Effect.flatMap(apply),
        Effect.asVoid,
        Effect.provide(
          stateLayer.pipe(
            Layer.provideMerge(
              options.providers as Layer.Layer<any, never, any>,
            ),
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
      ) as Effect.Effect<void, any, never>,
  };
};
