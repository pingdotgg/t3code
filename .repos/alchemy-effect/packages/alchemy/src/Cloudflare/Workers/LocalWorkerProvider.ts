import {
  Runtime,
  type RuntimeServices,
  type BindingHook,
  type BindingServices,
  type HyperdriveOrigin,
  type Module,
  type DurableObjectNamespace as RuntimeDurableObject,
  type QueueConsumer as RuntimeQueueConsumer,
  type Workflow as RuntimeWorkflow,
} from "@alchemy.run/cloudflare-runtime/core";
import type { ContainerImage } from "@alchemy.run/cloudflare-runtime/core/Docker";
import * as WorkerProxy from "@alchemy.run/cloudflare-runtime/core/proxy/WorkerProxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as PlatformFileSystem from "effect/FileSystem";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as os from "node:os";
import type * as Bundle from "../../Bundle/Bundle.ts";
import * as LocalProvider from "../../Local/LocalProvider.ts";
import { Stack } from "../../Stack.ts";
import { unwrapRedacted } from "../../Util/index.ts";
import { sha256 } from "../../Util/sha256.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  isLiveId,
  LOCAL_ENTRY_URL,
  LocalRuntimeState,
  localStorageDirectory,
} from "../LocalRuntime.ts";
import type { ConsumerSettings } from "../Queues/Consumer.ts";
import type { WorkerAssetsConfig, WorkerProps } from "../Workers/Worker.ts";
import { readAssetsConfigFiles } from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { watchPrebuiltWorkerBundle } from "./Sources/Prebuilt.ts";
import { isPythonMain, watchPythonWorkerBundle } from "./Sources/Python.ts";
import {
  Artifacts as AlchemyArtifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "../../Artifacts.ts";
import { loadSource, SourceProviderError, type DevContext } from "./Source.ts";
import { isSelfUrl, Worker } from "./Worker.ts";
import { getCronBindings } from "./WorkerAsyncBindings.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import { WorkerBundle, type WorkerBundleOptions } from "./Sources/Rolldown.ts";
import { createWorkerName } from "./WorkerName.ts";
import { resolveTailConsumers } from "./WorkerProvider.ts";
import {
  materializeRuntimeBindings,
  WorkerValidationError,
} from "./RuntimeBindings.ts";
import { startViteChild } from "./ViteChild.ts";
import { DEFAULT_DEV_PORT, type ViteChildConfig } from "./ViteChild.shared.ts";

/** Local dev-server options (the worker-mode arm of `WorkerProps["dev"]`). */
type DevServerOptions = Extract<WorkerProps["dev"], { mode?: "worker" }> & {
  port: number;
};

// Hosts that bind every interface — the dev server is then reachable at
// `localhost` *and* at each LAN address, like Vite's `--host` output.
const isWildcardHost = (host: string) =>
  host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";

/**
 * Resolve every URL a local dev server is reachable at, most relevant
 * first. A loopback or explicit host yields just that URL; a wildcard host
 * (`0.0.0.0`, `::`) yields `http://localhost:<port>` followed by one URL
 * per external IPv4 interface (`http://192.168.0.12:<port>`, ...) —
 * mirroring Vite's "Local / Network" dev-server output.
 */
const resolveLocalUrls = (serverUrl: URL): Effect.Effect<string[]> =>
  Effect.sync(() => {
    const port = serverUrl.port;
    const host = serverUrl.hostname;
    if (!isWildcardHost(host)) {
      return [serverUrl.origin];
    }
    // `os.networkInterfaces()` is a sync, CPU-only syscall with no Effect
    // platform equivalent — wrapped in `Effect.sync` so it participates in
    // the runtime.
    const interfaces = os.networkInterfaces();
    const lanAddresses = Object.values(interfaces)
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => address.address);
    return [
      `http://localhost:${port}`,
      ...lanAddresses.map((address) => `http://${address}:${port}`),
    ];
  });

export const LocalWorkerProvider = () =>
  LocalProvider.make(
    Worker,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;
      const runtime = yield* Runtime;
      const stack = yield* Stack;
      const storageDirectory = yield* localStorageDirectory;
      const path = yield* Path.Path;
      const localRuntimeState = yield* LocalRuntimeState;
      const workerProxy = yield* WorkerProxy.WorkerProxy;
      const cloudflareEnv = yield* CloudflareEnvironment;
      const context = yield* Effect.context<RuntimeServices>();
      const rootScope = yield* Effect.scope;

      // Proxies are deliberately NOT owned by the per-instance scope: they
      // survive restarts so the worker's URL stays stable across rebuilds
      // and config changes. Torn down by `stop` on delete.
      const proxyInstances = new Map<
        string,
        {
          serverOptions: DevServerOptions;
          instance: WorkerProxy.WorkerProxyInstance;
          scope: Scope.Closeable;
        }
      >();

      // ConsumerSettings speaks the Cloudflare API's dialect (batchSize,
      // maxWaitTimeMs in milliseconds); the runtime's QueueConsumer speaks
      // wrangler's (maxBatchSize, maxBatchTimeout in seconds). Map
      // explicitly — a spread silently drops the mismatched fields.
      const toRuntimeConsumerSettings = (
        settings: ConsumerSettings | undefined,
      ): Pick<
        RuntimeQueueConsumer,
        "maxBatchSize" | "maxBatchTimeout" | "maxRetries" | "retryDelay"
      > => ({
        maxBatchSize: settings?.batchSize,
        maxBatchTimeout:
          settings?.maxWaitTimeMs !== undefined
            ? settings.maxWaitTimeMs / 1000
            : undefined,
        maxRetries: settings?.maxRetries,
        retryDelay: settings?.retryDelay,
      });

      const getQueueConsumers = Effect.fn(function* (scriptName: string) {
        const consumers: RuntimeQueueConsumer[] = [];
        for (const consumer of MutableHashMap.values(
          localRuntimeState.queueConsumers,
        )) {
          if (consumer.scriptName === scriptName) {
            // A LIVE queue (`Alchemy.remote()`) consumed locally: the broker
            // is still local, but it is fed by the runtime's pull loop
            // draining the real queue over the HTTP pull API (the
            // Consumer's local provider attached the `http_pull` consumer
            // and resolved the queue's real name).
            if (isLiveId(consumer.queueId)) {
              if (!consumer.queueName) {
                return yield* Effect.die(
                  `Consumer of live queue ${consumer.queueId} is missing its resolved queueName — re-deploy the consumer`,
                );
              }
              consumers.push({
                queueName: consumer.queueName,
                deadLetterQueue: consumer.deadLetterQueue,
                ...toRuntimeConsumerSettings(consumer.settings),
                pull: {
                  queueId: consumer.queueId,
                  accountId: consumer.accountId,
                },
              });
              continue;
            }
            const queue = MutableHashMap.get(
              localRuntimeState.queues,
              consumer.queueId,
            ).pipe(Option.getOrUndefined);
            if (queue) {
              consumers.push({
                queueName: queue.queueName,
                deadLetterQueue: consumer.deadLetterQueue,
                ...toRuntimeConsumerSettings(consumer.settings),
              });
            } else {
              return yield* Effect.die(`Queue ${consumer.queueId} not found`);
            }
          }
        }
        return consumers;
      });

      const startProxy = Effect.fn(function* (
        id: string,
        serverOptions: DevServerOptions,
      ) {
        const scope = yield* Scope.fork(rootScope);
        const instance = yield* workerProxy
          .serve(serverOptions)
          .pipe(Scope.provide(scope));
        proxyInstances.set(id, { serverOptions, instance, scope });
        return instance;
      });

      const stopProxy = Effect.fn(function* (id: string) {
        const existing = proxyInstances.get(id);
        if (existing) {
          yield* Scope.close(existing.scope, Exit.void);
          proxyInstances.delete(id);
        }
      });

      const maybeStartProxy = Effect.fn(function* (
        id: string,
        serverOptions: DevServerOptions,
      ) {
        const existing = proxyInstances.get(id);
        if (existing) {
          if (Equal.equals(existing.serverOptions, serverOptions)) {
            return existing.instance;
          }
          yield* stopProxy(id);
        }
        return yield* startProxy(id, serverOptions);
      });

      const toRuntimeModules = Effect.fn(function* (
        bundle: Bundle.BundleOutput,
      ) {
        const modules: Module[] = [];
        for (const file of bundle.files) {
          // Vendored Python packages are opaque Data modules named by their
          // `python_modules/<relpath>` — mirroring the deploy path — except
          // the `workers-runtime-sdk` JS shims, which the runtime imports
          // as ES modules via `import_from_javascript()`.
          if (file.path.startsWith("python_modules/")) {
            const isJsShim =
              file.path.startsWith("python_modules/workers/") &&
              /\.m?js$/.test(file.path);
            modules.push(
              isJsShim
                ? {
                    name: file.path,
                    type: "ESModule",
                    content:
                      typeof file.content === "string"
                        ? file.content
                        : new TextDecoder().decode(file.content),
                  }
                : {
                    name: file.path,
                    type: "Data",
                    content:
                      typeof file.content === "string"
                        ? new TextEncoder().encode(file.content)
                        : file.content,
                  },
            );
            continue;
          }
          const ext = path.extname(file.path);
          const type = moduleTypeFromExtension(ext);
          if (type === "SourceMap") continue;
          if (type === "Data" || type === "Wasm") {
            if (!(file.content instanceof Uint8Array)) {
              return yield* new WorkerValidationError({
                message: `Expected Uint8Array for ${file.path} (${type})`,
                value: file.content,
              });
            }
            modules.push({
              name: file.path,
              type,
              content: file.content,
            });
          } else {
            // Prebuilt (`bundle: false`) workers read every module as raw
            // bytes; string-typed workerd modules (ESModule, Text, ...)
            // are decoded here, mirroring the deploy path which uploads
            // the same bytes with a text content type.
            modules.push({
              name: file.path,
              type,
              content:
                typeof file.content === "string"
                  ? file.content
                  : new TextDecoder().decode(file.content),
            });
          }
        }
        return modules;
      });

      /**
       * The restart-relevant, canonically-hashable view of a local Worker's
       * desired state — `LocalProvider`'s `resolveConfig`. Everything here
       * is plain data: binding *descriptors* (not `BindingHook` closures —
       * those are materialized in `start` via {@link toRuntimeBinding}),
       * DO-namespace/hyperdrive/container-image records, bundle options.
       *
       * Queue consumers are deliberately EXCLUDED: `getQueueConsumers`
       * reads `LocalRuntimeState` at serve time and sibling `Consumer`
       * reconciles drive restarts through the `workerRestarts` hook — they
       * are runtime wiring observed at start, not desired-state config.
       */
      const resolveConfig = Effect.fn(function* ({
        id,
        news,
        bindings,
      }: LocalProvider.LocalProviderInput<Worker>) {
        const props = news as WorkerProps;
        const name = yield* createWorkerName(id, props.name);
        const compatibility = getCompatibility(props);
        const bindingDescriptors: WorkerBinding[] = [];
        const durableObjectNamespaces: Record<
          string,
          RuntimeDurableObject & { uniqueKey: string }
        > = {};
        const workflows: Record<string, RuntimeWorkflow> = {};
        const hyperdrives: Record<string, Required<HyperdriveOrigin>> = {};
        // Dev-only channel (like `hyperdrives`): binding name → opt-out of
        // local emulation (the binding was piped through `Alchemy.remote()`). Read
        // by `toRuntimeBinding` when lowering browser/images/stream/
        // send_email descriptors. Part of the hashed config: flipping the
        // opt-out restarts the instance.
        const devRemote: Record<string, boolean> = {};
        const containers: Record<string, ContainerImage> = {};
        // Content hashes of the container images, keyed like `containers`.
        // `ContainerImage` itself only carries stable paths (context /
        // dockerfile / imageUri), so without the hash an image CONTENT
        // change (a Dockerfile edit, a rebuilt bundle) would never change
        // the config and the running container would serve stale code.
        const containerHashes: Record<string, string> = {};
        for (const { data } of bindings) {
          for (const binding of data.bindings ?? []) {
            if (
              binding.type === "durable_object_namespace" &&
              // The `durableObjectNamespaces` property is only used to declare DOs in this worker.
              // Otherwise, it's a cross-worker durable object binding, which cloudflare-runtime handles automatically.
              (!binding.scriptName || binding.scriptName === name)
            ) {
              // Reuse the existing namespace id if it was provided, otherwise generate a new one.
              // `workerd` uses this for the object's storage path, so it must be safe to use as a file name.
              const namespaceId =
                binding.namespaceId ??
                encodeURIComponent(`${name}-${binding.className}`);
              durableObjectNamespaces[binding.className] = {
                className: binding.className,
                uniqueKey: namespaceId,
                sql: true,
              };
              bindingDescriptors.push({ ...binding, namespaceId });
            } else {
              if (
                binding.type === "workflow" &&
                // Same ownership rule as DOs: only declare workflows hosted by
                // this worker. Cross-script workflow bindings are routed via
                // the registry proxy.
                (!binding.scriptName || binding.scriptName === name)
              ) {
                workflows[binding.workflowName] = {
                  workflowName: binding.workflowName,
                  className: binding.className,
                };
              }
              bindingDescriptors.push(binding);
            }
          }
          if (data.devRemote) {
            for (const [name, remote] of Object.entries(data.devRemote)) {
              devRemote[name] = remote;
            }
          }
          if (data.hyperdrives) {
            for (const [id, origin] of Object.entries(data.hyperdrives)) {
              hyperdrives[id] = {
                scheme: origin.scheme,
                host: origin.host,
                port: origin.port,
                user: origin.user,
                database: origin.database,
                password: unwrapRedacted(origin.password),
                sslmode: origin.sslmode,
              };
            }
          }
          if (data.containers) {
            for (const container of data.containers) {
              if (!container.dev) {
                return yield* Effect.die(
                  `Container ${container.className} has no dev image`,
                );
              }
              containers[container.className] = {
                ...container.dev,
                env: unwrapRedacted(container.dev.env),
              };
              if (container.hash !== undefined) {
                containerHashes[container.className] = container.hash;
              }
            }
          }
        }
        for (const [className, dev] of Object.entries(containers)) {
          if (!durableObjectNamespaces[className]) {
            return yield* Effect.die(
              `Durable Object namespace ${className} not found`,
            );
          }
          durableObjectNamespaces[className].container = dev;
        }
        const dev:
          | DevServerOptions
          | { readonly mode: "external"; readonly url?: string } =
          props.dev?.mode === "external"
            ? props.dev
            : {
                ...props.dev,
                mode: "worker" as const,
                // This is the default. Vite and cloudflare-runtime will retry
                // if unavailable, unless `strictPort` is true.
                port: props.dev?.port ?? DEFAULT_DEV_PORT,
              };
        return {
          id,
          name,
          compatibility,
          /** User env (Redacted preserved — the canonical hasher unwraps). */
          env: props.env,
          /**
           * Raw inline module source (mutually exclusive with `main`).
           * Serves as-is without the bundler; part of the hashed config so
           * editing the script restarts the instance.
           */
          script: props.script,
          // External source providers (`props.source`) own their asset
          // wiring: their dev servers either serve assets natively or add
          // their own ASSETS hook against a runtime that configures
          // `worker.assets`. Auto-injecting the hook here would fail in
          // proxy-hosted dev modes with no assets directory (the hook
          // errors when the Assets service is unconfigured).
          hasAssets: !!(props.assets || props.vite) && !props.source,
          /**
           * Assets-only Worker (no entry module at all): served locally by
           * a stub that delegates every request to the ASSETS binding.
           */
          assetsOnly:
            props.main === undefined &&
            props.script === undefined &&
            !props.vite &&
            !!props.assets,
          bindingDescriptors,
          durableObjectNamespaces: Object.values(durableObjectNamespaces),
          workflows: Object.values(workflows),
          hyperdrives,
          /**
           * Container image CONTENT hashes (className → hash). The DO
           * namespace records above only carry the image's stable paths, so
           * this is what makes an image content change — a Dockerfile edit,
           * a rebuilt effectful bundle — restart the instance (which is
           * what re-runs the docker build).
           */
          containerHashes,
          /**
           * External source-provider descriptor (plain JSON). Part of the
           * hashed config so changing the provider or its options restarts
           * the instance.
           */
          source: props.source,
          /**
           * Prebuilt worker (`bundle: false`): local dev must serve the
           * entry + rule-matched sibling modules byte-for-byte (fs-watch +
           * re-read) — never re-bundle the prebuilt artifact with rolldown.
           */
          prebuilt: props.bundle === false,
          rules: props.rules,
          devRemote,
          vite: !!props.vite,
          // Relative `vite.main` resolves from the Vite root (see the
          // matching normalization in WorkerProvider's `viteBuild`).
          viteMain: props.vite?.main
            ? path.resolve(props.vite.rootDir ?? process.cwd(), props.vite.main)
            : undefined,
          viteEnvironments: props.vite?.viteEnvironments,
          viteRootDir: props.vite?.rootDir,
          bundleOptions: {
            id,
            main: props.main!,
            compatibility,
            entry: props.isExternal
              ? { kind: "external" as const }
              : {
                  kind: "effect" as const,
                  exports: props.exports ?? {},
                },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: props.build,
          } satisfies WorkerBundleOptions,
          assets: props.assets,
          dev,
          crons: Array.from(
            new Set([...getCronBindings(bindings), ...(props.crons ?? [])]),
          ),
          // Tail consumers, resolved to plain `{ service }` records exactly
          // like the live provider hashes/uploads them (script names only,
          // deliberately hash-safe). Restart-relevant: serve lowers the list
          // into workerd's native `tails` service designators.
          tailConsumers: resolveTailConsumers(props.tailConsumers),
          // Streaming tail consumers, same resolution — serve lowers the
          // list into workerd's `streamingTails` designators, which deliver
          // the producer's events live via the consumer's `tailStream()`.
          streamingTailConsumers: resolveTailConsumers(
            props.streamingTailConsumers,
          ),
        };
      });

      type WorkerConfig = Effect.Success<ReturnType<typeof resolveConfig>>;
      /** A worker-mode config with its runtime `BindingHook`s materialized. */
      type RunnableWorkerConfig = Omit<WorkerConfig, "dev"> & {
        dev: DevServerOptions;
        workerBindings: BindingHook<BindingServices>[];
      };

      /**
       * Materialize the plain binding descriptors from {@link resolveConfig}
       * into live cloudflare-runtime `BindingHook`s. This is the non-plain
       * half of the old `buildConfig` — kept out of the hashed config.
       */
      const materializeWorkerBindings = Effect.fn(function* (
        config: WorkerConfig,
        selfUrl: string | undefined,
      ) {
        const { accountId } = yield* cloudflareEnv;
        return yield* materializeRuntimeBindings(
          {
            ...config,
            devAccess:
              config.dev.mode === "external" ? undefined : config.dev.access,
          },
          {
            accountId,
            selfUrl,
            stack: { name: stack.name, stage: stack.stage },
          },
        );
      });

      // Latest successful serve per worker id, so runtime wiring changes
      // that arrive AFTER workerd started (e.g. a sibling `Consumer`
      // resource registering this script as a queue consumer) can restart
      // the instance with the same bundle.
      const latestServes = new Map<
        string,
        {
          worker: RunnableWorkerConfig;
          bundle: Bundle.BundleOutput;
          proxy: WorkerProxy.WorkerProxyInstance;
        }
      >();
      // Serializes serves per worker id: a restart triggered by a sibling
      // resource may otherwise interleave with a rebuild-triggered serve
      // and leak a workerd scope.
      const serveLocks = new Map<string, Semaphore.Semaphore>();
      const serveLock = (id: string) => {
        let lock = serveLocks.get(id);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          serveLocks.set(id, lock);
        }
        return lock;
      };

      const workerdScopes = new Map<string, Scope.Closeable>();

      // Serve with make-before-break semantics: start the replacement
      // workerd while the previous instance (if any) keeps serving — and
      // stays registered in the dev registry — then cut the proxy over and
      // tear the previous instance down. Cross-script consumers (e.g. a DO
      // bound via `scriptName` from another Worker) therefore never observe
      // a window where the script has no running instance and no registry
      // entry, even when `runtime.start` is slow (container image builds).
      // Both instances use the same registry key; the registry's entry
      // removal is owner-aware, so closing the old scope after the
      // replacement has re-registered cannot delete the replacement's
      // registration.
      //
      // The workerd scope is forked from the provider's `rootScope`, NOT
      // the instance scope: a reconcile that replaces the instance (or a
      // restart triggered from a sibling provider's fiber) tears down the
      // bundle watcher without killing the currently serving workerd — the
      // last good instance keeps serving until the replacement's first
      // serve completes. Ownership is tracked in `workerdScopes`, closed by
      // the next successful serve, by `delete`, or by provider shutdown.
      /**
       * One container-context watcher per worker id, keyed by the watched
       * path set. Registry-held (NOT per-serve-scope): a worker restarts
       * through several code paths that overlap scopes, and a watcher per
       * serve produced DUPLICATES whose simultaneous restarts storm the
       * instance until the DO's container link breaks.
       */
      const containerWatchers = new Map<
        string,
        { key: string; fiber: Fiber.Fiber<void> }
      >();

      const stopContainerWatcher = (id: string) =>
        Effect.suspend(() => {
          const existing = containerWatchers.get(id);
          if (existing === undefined) return Effect.void;
          containerWatchers.delete(id);
          return Fiber.interrupt(existing.fiber).pipe(Effect.asVoid);
        });

      /**
       * Watch a worker's Build-variant container contexts and restart the
       * instance when their CONTENT changes — the docker build happens at
       * instance start, so a restart IS the image rebuild.
       *
       * This is the reload path for USER-supplied Dockerfile/context
       * containers: those files are not imported by the stack, so
       * `bun --watch` never re-runs the exec child for them and no replan
       * (hence no config-hash restart) ever fires. Generated contexts
       * (under `.alchemy/`) are excluded — the effectful `main` variant
       * rewrites its bundle there on every plan, which would loop; that
       * variant reloads through the config's `containerHashes` instead.
       *
       * Events are debounced and gated on a content fingerprint
       * (`node_modules`/`.git` skipped), so editor double-saves and
       * metadata-only churn don't bounce the instance.
       */
      const ensureContainerWatcher = (
        worker: RunnableWorkerConfig,
        restart: Effect.Effect<
          void,
          never,
          | ChildProcessSpawner.ChildProcessSpawner
          | PlatformFileSystem.FileSystem
          | Path.Path
        >,
      ) =>
        Effect.gen(function* () {
          const fs = yield* PlatformFileSystem.FileSystem;
          const watched = new Map<string, { dockerfile: string | undefined }>();
          for (const namespace of worker.durableObjectNamespaces) {
            const image = namespace.container;
            if (image === undefined || !("dockerfile" in image)) continue;
            const context = path.resolve(image.context ?? ".");
            if (context.split(path.sep).includes(".alchemy")) continue;
            watched.set(context, {
              dockerfile:
                image.dockerfile !== undefined
                  ? path.resolve(context, image.dockerfile)
                  : undefined,
            });
          }
          const key = JSON.stringify([...watched.entries()].sort());
          const existing = containerWatchers.get(worker.id);
          if (existing !== undefined) {
            if (existing.key === key) return; // same watcher keeps running
            yield* stopContainerWatcher(worker.id);
          }
          if (watched.size === 0) return;

          const fingerprint = Effect.gen(function* () {
            const hashes: string[] = [];
            const walk = (dir: string): Effect.Effect<void, any> =>
              Effect.gen(function* () {
                const entries = yield* fs.readDirectory(dir);
                for (const entry of entries.sort()) {
                  if (entry === "node_modules" || entry === ".git") continue;
                  const file = path.join(dir, entry);
                  const stat = yield* fs.stat(file);
                  if (stat.type === "Directory") {
                    yield* walk(file);
                  } else {
                    hashes.push(
                      `${file}:${yield* fs.readFile(file).pipe(Effect.flatMap(sha256))}`,
                    );
                  }
                }
              });
            for (const [context, { dockerfile }] of watched) {
              yield* walk(context);
              if (dockerfile !== undefined && !dockerfile.startsWith(context)) {
                hashes.push(
                  `${dockerfile}:${yield* fs.readFile(dockerfile).pipe(Effect.flatMap(sha256))}`,
                );
              }
            }
            return yield* sha256(hashes.join("\n"));
          }).pipe(Effect.orElseSucceed(() => undefined));

          const streams = [...watched.entries()].flatMap(
            ([context, { dockerfile }]) => [
              fs.watch(context, { recursive: true }),
              ...(dockerfile !== undefined && !dockerfile.startsWith(context)
                ? [fs.watch(path.dirname(dockerfile))]
                : []),
            ],
          );
          const watchLoop = Effect.gen(function* () {
            let last = yield* fingerprint;
            yield* Stream.mergeAll(streams, {
              concurrency: streams.length,
            }).pipe(
              Stream.debounce("500 millis"),
              Stream.runForEach(() =>
                Effect.gen(function* () {
                  const next = yield* fingerprint;
                  if (next === undefined || next === last) return;
                  last = next;
                  yield* Effect.logInfo(
                    `[${worker.id}] Container build context changed, restarting instance`,
                  );
                  yield* restart;
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `[${worker.id}] Container context watch failed`,
                  Cause.squash(cause),
                ),
              ),
            );
          });
          const fiber = yield* watchLoop.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const current = containerWatchers.get(worker.id);
                if (current?.fiber === fiber) {
                  containerWatchers.delete(worker.id);
                }
              }),
            ),
            Effect.forkIn(rootScope),
          );
          containerWatchers.set(worker.id, { key, fiber });
        });

      const serveWith = (
        worker: RunnableWorkerConfig,
        bundle: Bundle.BundleOutput,
        proxy: WorkerProxy.WorkerProxyInstance,
      ) =>
        Semaphore.withPermits(
          serveLock(worker.id),
          1,
        )(
          // The bookkeeping around `runtime.start` must not be torn in half
          // by an interrupt: once a replacement workerd is up, it must be
          // recorded in `workerdScopes` and the superseded instances must be
          // closed, or one of the workerds would leak until provider
          // shutdown while holding the shared registry key.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const previous = workerdScopes.get(worker.id);
              // Instances whose queue-consumer wiring went stale while they
              // were starting; never exposed via the proxy, closed together
              // with `previous` after the cutover below.
              const superseded: Scope.Closeable[] = [];
              let scope!: Scope.Closeable;
              let url!: URL;
              // Queue-consumer wiring can change while `runtime.start` is in
              // flight (a sibling `Consumer` reconcile), before the restart
              // hook below exists to pick it up. We hold the serve lock, so a
              // restart would deadlock — instead, loop and serve again until
              // the wiring is stable across a start.
              while (true) {
                const queueConsumers = yield* getQueueConsumers(worker.name);
                scope = yield* Scope.fork(rootScope);
                url = yield* restore(
                  runtime
                    .start({
                      name: worker.name,
                      compatibilityDate: worker.compatibility.date,
                      compatibilityFlags: worker.compatibility.flags,
                      bindings: worker.workerBindings as never,
                      hyperdrives: worker.hyperdrives,
                      durableObjectNamespaces: worker.durableObjectNamespaces,
                      workflows: worker.workflows,
                      queueConsumers,
                      // Cron triggers: the runtime starts a Node-side timer
                      // per expression and exposes the Miniflare-compatible
                      // manual trigger route `/cdn-cgi/handler/scheduled`.
                      crons: worker.crons,
                      // Tail consumers by script name — each resolves through
                      // the dev registry proxy exactly like cross-worker
                      // service bindings; a consumer that isn't running yet
                      // drops events with a `[registry]` warning until it
                      // registers (wrangler dev-registry semantics).
                      tails: worker.tailConsumers?.map((c) => c.service),
                      // Streaming tail consumers by script name — resolved
                      // through the same registry proxy; the consumer's
                      // `tailStream()` receives the onset while the producer
                      // is still executing (dropped with a `[registry]`
                      // warning until the consumer registers).
                      streamingTails: worker.streamingTailConsumers?.map(
                        (c) => c.service,
                      ),
                      // Cache API opt-out (`dev: { cache: false }`) — matches
                      // production workers.dev, where the Cache API is a no-op.
                      cache: worker.dev.cache,
                      // Per-worker request.cf override (`dev: { cf: {...} }`).
                      cf: worker.dev.cf,
                      modules: yield* toRuntimeModules(bundle),
                      assets: yield* toRuntimeAssets(worker.assets),
                    })
                    .pipe(Scope.provide(scope)),
                ).pipe(
                  // The scope hangs off `rootScope`, so a failed or
                  // interrupted start must close it here — nothing else owns
                  // it yet.
                  Effect.onExit((exit) =>
                    exit._tag === "Failure"
                      ? Scope.close(scope, exit)
                      : Effect.void,
                  ),
                );
                workerdScopes.set(worker.id, scope);
                latestServes.set(worker.id, { worker, bundle, proxy });
                // Register the restart hook before the re-check below: changes
                // landing after the re-check find the hook; changes before it
                // are caught by the re-check. Nothing falls in between.
                MutableHashMap.set(
                  localRuntimeState.workerRestarts,
                  worker.name,
                  restartWorker(worker.id),
                );
                // Idempotent: the registry keeps ONE watcher per worker id
                // across restarts (a new one only when the watched path set
                // changed).
                yield* ensureContainerWatcher(
                  worker,
                  Effect.suspend(() => restartWorker(worker.id)),
                );
                const currentConsumers = yield* getQueueConsumers(worker.name);
                if (
                  JSON.stringify(currentConsumers) !==
                  JSON.stringify(queueConsumers)
                ) {
                  // Wiring changed while workerd was starting — serve again
                  // with the fresh consumers before exposing the instance.
                  superseded.push(scope);
                  continue;
                }
                break;
              }
              yield* proxy.set(url);
              // Only now tear the replaced instances down: `previous` kept
              // serving — and stayed registered in the dev registry — until
              // the cutover above. The registry's entry removal is
              // owner-aware, so these closes cannot delete the replacement's
              // registration.
              for (const replaced of previous
                ? [...superseded, previous]
                : superseded) {
                yield* Scope.close(replaced, Exit.void).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[${worker.id}] Failed to stop previous local worker instance`,
                      Cause.squash(cause),
                    ),
                  ),
                );
              }
              return url;
            }),
          ),
        );

      /**
       * Restart a running worker with its latest bundle (or its latest Vite
       * dev-server child) so start-time runtime wiring (queue consumers) is
       * re-read from {@link LocalRuntimeState}. No-op if the worker hasn't
       * served yet — the pending first serve will already observe the
       * updated state.
       */
      const logRestartFailure = (id: string) =>
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.logWarning(
            `[${id}] Failed to restart local worker`,
            Cause.squash(cause),
          ),
        );

      const restartWorker = (
        id: string,
      ): Effect.Effect<
        void,
        never,
        | ChildProcessSpawner.ChildProcessSpawner
        | PlatformFileSystem.FileSystem
        | Path.Path
      > =>
        Effect.suspend(() => {
          const latest = latestServes.get(id);
          if (latest) {
            return serveWith(latest.worker, latest.bundle, latest.proxy).pipe(
              Effect.asVoid,
              logRestartFailure(id),
            );
          }
          const vite = latestViteServes.get(id);
          if (vite) {
            // A Vite boot is expensive, so skip the restart if the running
            // child already serves the current wiring (the in-flight serve's
            // re-check loop may have picked it up while this restart waited
            // on the serve lock).
            return serveVite(vite, { onlyIfConsumersChanged: true }).pipe(
              Effect.asVoid,
              logRestartFailure(id),
            );
          }
          return Effect.void;
        });

      // Tear down the running workerd for a worker id, if any. Used when the
      // Worker is deleted or handed off to an external dev process —
      // instance replacement does NOT go through this: the previous workerd
      // keeps serving until the replacement's first serve closes it.
      const closeWorkerd = Effect.fn(function* (id: string) {
        yield* stopContainerWatcher(id);
        const scope = workerdScopes.get(id);
        if (scope) {
          workerdScopes.delete(id);
          yield* Scope.close(scope, Exit.void);
        }
      });

      // Note: `serveLocks` entries are intentionally retained — an
      // in-flight restart may still hold the semaphore when the instance
      // is torn down, and a same-id re-create must serialize against it.
      const dropServeState = (id: string) => {
        const latest = latestServes.get(id) ?? latestViteServes.get(id);
        if (latest) {
          MutableHashMap.remove(
            localRuntimeState.workerRestarts,
            latest.worker.name,
          );
          latestServes.delete(id);
          latestViteServes.delete(id);
          servedViteConsumers.delete(id);
        }
      };

      /**
       * Drain a stream of bundle-watch events into the make-before-break
       * `serveWith` path, forked into the instance scope: queue requests
       * while a rebuild is in flight, serve every successful bundle, and
       * log build/serve errors without tearing the instance down.
       *
       * Shared by the built-in bundler (`runWorker`) and bundle-mode
       * external source providers (`runSource`) — both speak the same
       * {@link Bundle.BundleWatchEvent} protocol.
       */
      const serveBundleStream = Effect.fn(function* <E, R>(
        worker: RunnableWorkerConfig,
        proxy: WorkerProxy.WorkerProxyInstance,
        bundles: Stream.Stream<Bundle.BundleWatchEvent, E, R>,
      ) {
        let start = Date.now();
        let status: "start" | "update" = "start";
        yield* bundles.pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              start = Date.now();
              if (status === "update") {
                return Effect.all([
                  Effect.log(`[${worker.id}] Rebuilding`),
                  // Tells the proxy to queue requests until the updated
                  // worker is ready.
                  Effect.forkChild(proxy.unset()),
                ]);
              }
            } else if (event._tag === "Error") {
              return Effect.logError(
                `[${worker.id}] Bundle error`,
                event.error,
              );
            }
            return Effect.void;
          }),
          Stream.filterMap((event) =>
            event._tag === "Success"
              ? Result.succeed(event.output)
              : Result.failVoid,
          ),
          Stream.mapEffect((bundle) =>
            serveWith(worker, bundle, proxy).pipe(
              Effect.exit,
              Effect.tap((exit) => {
                if (exit._tag === "Success") {
                  const message = Effect.log(
                    `[${worker.id}] ${status === "update" ? "Updated" : "Started"} in ${Math.round(Date.now() - start)}ms`,
                  );
                  status = "update";
                  return message;
                } else {
                  return Effect.logError(
                    `[${worker.id}] Error`,
                    Cause.squash(exit.cause),
                  );
                }
              }),
            ),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
      });

      const runWorker = Effect.fn(function* (worker: RunnableWorkerConfig) {
        const start = Date.now();
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        // Inline `script` workers bypass the bundler entirely — the string
        // IS the module (mirroring the deploy path, which uploads it as a
        // single `main.js`). There is nothing to watch: script changes flow
        // through the hashed config and restart the instance.
        if (worker.script !== undefined) {
          yield* serveWith(
            worker,
            {
              files: [{ path: "main.js", content: worker.script, hash: "" }],
              hash: "",
            },
            proxy,
          );
          yield* Effect.log(
            `[${worker.id}] Started in ${Math.round(Date.now() - start)}ms → ${proxy.url}`,
          );
          return proxy.url;
        }
        const bundles: Stream.Stream<
          Bundle.BundleWatchEvent,
          Bundle.BundleError,
          | ChildProcessSpawner.ChildProcessSpawner
          | FileSystem.FileSystem
          | Path.Path
          | Scope.Scope
        > = isPythonMain(worker.bundleOptions.main)
          ? watchPythonWorkerBundle({
              id: worker.bundleOptions.id,
              main: worker.bundleOptions.main,
              compatibility: worker.compatibility,
            })
          : worker.prebuilt
            ? // Prebuilt (`bundle: false`): fs-watch the entry directory
              // and re-read the module graph byte-for-byte — running the
              // rolldown watcher would re-bundle the prebuilt artifact
              // and violate the deploy path's byte-for-byte contract.
              watchPrebuiltWorkerBundle({
                main: worker.bundleOptions.main,
                rules: worker.rules,
              })
            : bundler.watch(worker.bundleOptions);
        yield* serveBundleStream(worker, proxy, bundles);
        return proxy.url;
      });

      // Assets-only Worker: there is no entry module to bundle or watch.
      // The local runtime requires a user worker module, so serve a stub
      // that delegates every request to the ASSETS binding — the assets
      // worker applies `htmlHandling` / `notFoundHandling` (including SPA
      // fallback) itself, matching Cloudflare's deployed assets-only
      // behavior.
      const assetsOnlyBundle: Bundle.BundleOutput = {
        files: [
          {
            path: "main.js",
            content:
              "export default { fetch: (request, env) => env.ASSETS.fetch(request) };",
            hash: "assets-only-stub",
          },
        ],
        hash: "assets-only-stub",
      };

      const runAssetsOnly = Effect.fn(function* (worker: RunnableWorkerConfig) {
        const start = Date.now();
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        yield* serveWith(worker, assetsOnlyBundle, proxy);
        yield* Effect.log(
          `[${worker.id}] Started in ${Math.round(Date.now() - start)}ms`,
        );
        return proxy.url;
      });

      /** Everything needed to serve (or re-serve) a Vite dev-server child. */
      interface ViteServeArgs {
        worker: RunnableWorkerConfig;
        rootDir: string | undefined;
        invalidate: Effect.Effect<void>;
        source: NonNullable<ViteChildConfig["source"]> | undefined;
        proxy: WorkerProxy.WorkerProxyInstance;
      }

      /** The Vite analogue of `latestServes`: everything needed to restart
       * the dev-server child when a sibling `Consumer` reconcile changes the
       * queue-consumer wiring (see `workerRestarts`). */
      const latestViteServes = new Map<string, ViteServeArgs>();

      /** The queue-consumer wiring (canonical JSON) each running Vite child
       * was started with, for the restart path's changed-wiring check. */
      const servedViteConsumers = new Map<string, string>();

      // Serve a Vite dev-server child with the same two guarantees
      // `serveWith` gives a plain worker: a `workerRestarts` hook so sibling
      // `Consumer` reconciles can restart the child with fresh queue-consumer
      // wiring, and a post-start re-check so wiring that lands while the
      // child is starting is not lost. Unlike `serveWith` this is
      // break-before-make — two Vite dev servers rooted at the same app
      // would race file watchers and Durable Object storage — so the proxy
      // queues requests across the gap. The child's scope is forked from
      // `rootScope` and tracked in `workerdScopes`, so it survives instance
      // restarts and is reclaimed by `stop`/handoff/`serveWith` like any
      // other running instance.
      const serveVite = (
        args: ViteServeArgs,
        options?: { onlyIfConsumersChanged?: boolean },
      ) =>
        Semaphore.withPermits(
          serveLock(args.worker.id),
          1,
        )(
          // The bookkeeping around `startViteChild` must not be torn in half
          // by an interrupt: once a replacement child is up it must be
          // recorded in `workerdScopes`, or it would leak until provider
          // shutdown while holding the worker's registry key.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const { worker, rootDir, invalidate, source, proxy } = args;
              if (options?.onlyIfConsumersChanged) {
                const current = yield* getQueueConsumers(worker.name);
                if (
                  workerdScopes.has(worker.id) &&
                  JSON.stringify(current) === servedViteConsumers.get(worker.id)
                ) {
                  return;
                }
              }
              // Queue requests while the child is (re)starting.
              yield* proxy.unset().pipe(Effect.forkChild);
              // The dev server and its workerd run in a child process rooted
              // at the app.
              const root = path.resolve(rootDir ?? process.cwd());
              const { accountId } = yield* cloudflareEnv;
              // Queue-consumer wiring can change while the child is starting
              // (a sibling `Consumer` reconcile), before the restart hook
              // below exists to pick it up. We hold the serve lock, so a
              // restart would deadlock — instead, loop and serve again until
              // the wiring is stable across a start.
              while (true) {
                const queueConsumers = yield* getQueueConsumers(worker.name);
                // Break-before-make: tear the previous child down before
                // starting its replacement (also covers a superseded child
                // from the previous loop iteration).
                yield* closeWorkerd(worker.id);
                const scope = yield* Scope.fork(rootScope);
                const child = yield* restore(
                  startViteChild(
                    {
                      rootDir: root,
                      publicUrl: proxy.url.toString().replace(/\/$/, ""),
                      accountId,
                      storageDirectory,
                      stack: { name: stack.name, stage: stack.stage },
                      // Already resolved to plain values by `start`
                      // (`Worker.URL` sentinels substituted); Redacted
                      // unwraps at the process boundary inside
                      // `startViteChild`.
                      env: worker.env ?? {},
                      source,
                      worker: {
                        name: worker.name,
                        compatibility: worker.compatibility,
                        main: worker.viteMain,
                        viteEnvironments: worker.viteEnvironments,
                        hasAssets: worker.hasAssets,
                        bindingDescriptors: worker.bindingDescriptors,
                        devRemote: worker.devRemote,
                        devAccess: worker.dev.access,
                        durableObjectNamespaces: worker.durableObjectNamespaces,
                        workflows: worker.workflows,
                        hyperdrives: worker.hyperdrives,
                        queueConsumers,
                        assets: yield* toRuntimeAssets(worker.assets),
                      },
                    },
                    (channel, line) => {
                      process[channel].write(`${worker.id} | ${line}\n`);
                    },
                  ).pipe(Scope.provide(scope)),
                ).pipe(
                  // The scope hangs off `rootScope`, so a failed or
                  // interrupted start must close it here — nothing else owns
                  // it yet.
                  Effect.onExit((exit) =>
                    exit._tag === "Failure"
                      ? Scope.close(scope, exit)
                      : Effect.void,
                  ),
                );
                workerdScopes.set(worker.id, scope);
                latestViteServes.set(worker.id, args);
                // Unexpected child death: log, park the proxy, and mark the
                // instance for update on the next plan. Forked into the
                // child's scope so a deliberate restart or teardown
                // interrupts the watcher before the process is killed.
                yield* child.exitCode.pipe(
                  Effect.flatMap((exitCode) =>
                    Effect.logWarning(
                      `[${worker.id}] Dev server child exited unexpectedly with code ${exitCode}`,
                    ),
                  ),
                  Effect.andThen(proxy.unset().pipe(Effect.ignore)),
                  Effect.andThen(invalidate),
                  Effect.forkIn(scope),
                );
                // Register the restart hook before the re-check below:
                // changes landing after the re-check find the hook; changes
                // before it are caught by the re-check. Nothing falls in
                // between.
                MutableHashMap.set(
                  localRuntimeState.workerRestarts,
                  worker.name,
                  restartWorker(worker.id),
                );
                const currentConsumers = yield* getQueueConsumers(worker.name);
                if (
                  JSON.stringify(currentConsumers) !==
                  JSON.stringify(queueConsumers)
                ) {
                  // Wiring changed while the child was starting — serve
                  // again with the fresh consumers before exposing it.
                  continue;
                }
                servedViteConsumers.set(
                  worker.id,
                  JSON.stringify(queueConsumers),
                );
                yield* proxy.set(child.url);
                return;
              }
            }),
          ),
        );

      const runVite = Effect.fn(function* (
        worker: RunnableWorkerConfig,
        rootDir: string | undefined,
        invalidate: Effect.Effect<void>,
        source?: NonNullable<ViteChildConfig["source"]>,
      ) {
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        yield* serveVite({ worker, rootDir, invalidate, source, proxy });
        return proxy.url;
      });

      // External source provider (`props.source`): the provider owns the
      // dev story. Two modes (see `SourceDevHandle`):
      // - `server`: the source runs its own dev server (framework dev);
      //   the proxy is pointed at its URL.
      // - `bundle`: the source supplies rebuild events; each successful
      //   bundle is served through the same make-before-break `serveWith`
      //   path the built-in bundler uses.
      const runSource = Effect.fn(function* (worker: RunnableWorkerConfig) {
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        // Queue requests until the source's first output is served —
        // whether that's the first workerd serve (bundle mode) or the dev
        // server URL (server mode).
        yield* proxy.unset().pipe(Effect.forkChild);
        // `loadSource` is typed against the full `SourceServices` union
        // (which includes the per-run Artifacts cache the live provider
        // supplies); local dev has no run-scoped cache, so hand the
        // module a fresh in-memory one.
        const source = yield* loadSource(worker.source!).pipe(
          Effect.provideService(
            AlchemyArtifacts,
            makeScopedArtifacts(createArtifactStore(), worker.id),
          ),
        );
        const devCtx: DevContext = {
          id: worker.id,
          workerName: worker.name,
          compatibility: worker.compatibility,
          entry: worker.bundleOptions.entry,
          stack: { name: stack.name, stage: stack.stage },
          env: worker.env,
          extraOptions: worker.bundleOptions.extraOptions,
          assets: worker.assets,
          worker: {
            bindings: worker.workerBindings,
            durableObjectNamespaces: worker.durableObjectNamespaces,
            hyperdrives: worker.hyperdrives,
            queueConsumers: getQueueConsumers(worker.name),
            assets: yield* toRuntimeAssets(worker.assets),
          },
          runtimeContext: context,
        };
        const handle = yield* source.dev(devCtx);
        if (handle.mode !== "bundle") {
          return yield* Effect.fail(
            new SourceProviderError({
              provider: worker.source!.provider,
              message:
                "A source declared devMode 'bundle' but returned a server-mode dev handle.",
            }),
          );
        }
        yield* serveBundleStream(worker, proxy, handle.bundles);
        return proxy.url;
      });

      return {
        resolveConfig,

        // The physical name only survives an update when it isn't changing.
        stables: ({ output, config }) =>
          Effect.succeed(
            output?.workerName === config.name
              ? (["workerName"] as ["workerName"])
              : undefined,
          ),

        precreate: Effect.fn(function* ({ id, news, bindings }) {
          const name = yield* createWorkerName(id, news.name);
          const durableObjectNamespaces: Record<string, string> = {};
          for (const { data } of bindings) {
            for (const binding of data?.bindings ?? []) {
              if (binding.type === "durable_object_namespace") {
                durableObjectNamespaces[binding.className] =
                  binding.namespaceId ??
                  encodeURIComponent(
                    `${binding.scriptName!}-${binding.className}`,
                  );
              }
            }
          }
          const { accountId } = yield* cloudflareEnv;
          const urls =
            news.dev?.mode === "external"
              ? // news.dev.url may be an unresolved output; avoid trying to resolve it here.
                []
              : yield* maybeStartProxy(id, {
                  ...news.dev,
                  mode: "worker" as const,
                  port: news.dev?.port ?? DEFAULT_DEV_PORT,
                }).pipe(Effect.flatMap((proxy) => resolveLocalUrls(proxy.url)));
          return {
            // No cloud script exists in dev — fabricate a `dev:`-marked
            // identity (the shared local-provider convention, and the
            // legacy-row mode marker; see LOCAL_ID_PREFIX).
            workerId: `dev:${name}`,
            workerName: name,
            namespace: undefined,
            logpush: undefined,
            url: urls[0],
            urls,
            domain: undefined,
            tags: [],
            durableObjectNamespaces,
            routes: [],
            crons: Array.from(
              new Set([...getCronBindings(bindings), ...(news.crons ?? [])]),
            ),
            accountId,
          };
        }),

        start: Effect.fn(function* ({ id, config, invalidate }) {
          const { accountId } = yield* cloudflareEnv;

          // `dev: { mode: "external" }` opts out of running a local Worker
          // entirely — typically because an external dev process
          // (Command.Dev) is serving requests. The instance exists in the
          // registry (with an empty scope) but has no workerd behind it. A
          // previous worker-mode instance for this id may have registered
          // serve/restart state — drop it, and tear down its workerd (with
          // make-before-break the running workerd outlives instance scopes
          // and must be closed explicitly on handoff).
          if (config.dev.mode === "external") {
            dropServeState(id);
            yield* closeWorkerd(id);
            const urls = config.dev.url ? [config.dev.url] : [];
            return {
              workerId: `dev:${config.name}`,
              workerName: config.name,
              namespace: undefined,
              logpush: undefined,
              url: urls[0],
              urls,
              domain: undefined,
              tags: [],
              durableObjectNamespaces: {},
              accountId,
              routes: [],
              crons: config.crons,
              tailConsumers: config.tailConsumers,
              streamingTailConsumers: config.streamingTailConsumers,
            } satisfies Worker["Attributes"];
          }

          // `Worker.URL` locally resolves to the worker's dev-proxy URL —
          // the proxy is stable per worker id (the same instance `runWorker`
          // / `runVite` attach to below), so the URL is known before workerd
          // starts. Trailing slash stripped to match the cloud value's shape.
          const needsSelfUrl =
            config.bindingDescriptors.some((b) => b.type === "self_url") ||
            Object.values(config.env ?? {}).some(isSelfUrl);
          const selfUrl = needsSelfUrl
            ? (yield* maybeStartProxy(id, config.dev)).url
                .toString()
                .replace(/\/$/, "")
            : undefined;
          // Substitute `Worker.URL` sentinels once, up front — the runtime
          // bindings, the Vite define entries, and the child-process config
          // all consume the resolved URL as a plain string.
          const env =
            config.env && selfUrl !== undefined
              ? Object.fromEntries(
                  Object.entries(config.env).map(([key, value]) => [
                    key,
                    isSelfUrl(value) ? selfUrl : value,
                  ]),
                )
              : config.env;
          const workerBindings = yield* materializeWorkerBindings(
            { ...config, env },
            selfUrl,
          );
          const worker: RunnableWorkerConfig = {
            ...config,
            env,
            dev: config.dev,
            workerBindings,
          };
          const serverUrl = yield* config.source
            ? config.source.devMode === "server"
              ? runVite(worker, config.source.rootDir, invalidate, {
                  descriptor: config.source,
                  id: worker.id,
                  assets: worker.assets,
                })
              : runSource(worker)
            : config.vite
              ? runVite(worker, config.viteRootDir, invalidate)
              : config.assetsOnly
                ? runAssetsOnly(worker)
                : runWorker(worker);
          // In dev, `urls` is the dev server's actual surface — localhost
          // first, then LAN addresses for wildcard hosts. Deployed domains
          // are not served by this session, so they don't appear.
          const urls = yield* resolveLocalUrls(serverUrl);
          return {
            workerId: `dev:${config.name}`,
            workerName: config.name,
            namespace: undefined,
            logpush: undefined,
            url: urls[0],
            urls,
            domain: undefined,
            tags: [],
            durableObjectNamespaces: Object.fromEntries(
              config.durableObjectNamespaces.map((namespace) => [
                namespace.className,
                namespace.uniqueKey,
              ]),
            ),
            routes: [],
            crons: config.crons,
            tailConsumers: config.tailConsumers,
            streamingTailConsumers: config.streamingTailConsumers,
            accountId,
          } satisfies Worker["Attributes"];
        }),

        stop: Effect.fn(function* ({ id }) {
          // Cross-restart state: the serve/restart bookkeeping, the running
          // workerd (which outlives instance scopes for make-before-break),
          // and the URL proxy live outside instance scopes and are only
          // reclaimed on a real delete.
          dropServeState(id);
          yield* closeWorkerd(id);
          yield* stopProxy(id);
        }),
      } satisfies LocalProvider.LocalProviderSpec<
        Worker,
        Effect.Success<ReturnType<typeof resolveConfig>>,
        // The Python-bundle watcher spawns `uv` (ChildProcessSpawner) and
        // reads vendored modules (FileSystem) from inside `start`;
        // `readAssetsConfigFiles` (assets `_headers`/`_redirects`) needs
        // FileSystem + Path.
        | ChildProcessSpawner.ChildProcessSpawner
        | FileSystem.FileSystem
        | Path.Path
      >;
    }),
  );

const toRuntimeAssets = Effect.fn(function* (
  assets: WorkerAssetsConfig | undefined,
) {
  if (!assets) return undefined;
  // Mirror the deploy path: the special `_headers` / `_redirects` files
  // in the assets directory carry the rules unless overridden by
  // explicit `headers` / `redirects` props. The local runtime parses
  // the raw string contents just like Cloudflare does.
  //
  // A Vite website's `assets` is config-only (`{ runWorkerFirst: true }`) —
  // the client output directory is the build's business, and in `dev` the
  // vite plugin serves assets from the dev server, so there is no directory
  // to read here.
  const directory: string | undefined =
    typeof assets === "string" ? assets : assets.directory;
  // An unreadable file just means no rules here — the assets plugin
  // reports directory problems itself.
  const files = yield* readAssetsConfigFiles(directory).pipe(
    Effect.orElseSucceed(() => ({
      _headers: undefined,
      _redirects: undefined,
    })),
  );
  if (typeof assets === "string") {
    return {
      directory: assets,
      headers: files._headers,
      redirects: files._redirects,
    };
  }
  return {
    directory: assets.directory,
    headers: assets.headers ?? files._headers,
    redirects: assets.redirects ?? files._redirects,
    htmlHandling: assets.htmlHandling,
    notFoundHandling: assets.notFoundHandling,
    // The deployed default is assets-first (`run_worker_first` omitted =
    // false on the cloud API), but the runtime's router inverts it — it
    // treats anything `!== false` (including `undefined`) as worker-first.
    // Pin the cloud default explicitly so a Worker with an assets directory
    // and a `main` serves asset paths from the asset layer locally exactly
    // like it does deployed.
    runWorkerFirst: assets.runWorkerFirst ?? false,
    serveDirectly: assets.serveDirectly,
  };
});

const moduleTypeFromExtension = (ext: string): Module["type"] | "SourceMap" => {
  switch (ext) {
    case ".wasm":
      return "Wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "Text";
    case ".bin":
      return "Data";
    case ".mjs":
    case ".js":
      return "ESModule";
    case ".cjs":
      return "CommonJsModule";
    case ".py":
      return "PythonModule";
    case ".map":
      return "SourceMap";
    default:
      return "Text";
  }
};
