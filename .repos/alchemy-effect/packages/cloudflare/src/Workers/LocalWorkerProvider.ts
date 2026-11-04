import * as os from "node:os";
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
import type { ContainerImage as RuntimeContainerImage } from "@alchemy.run/cloudflare-runtime/core/Docker";
import * as WorkerProxy from "@alchemy.run/cloudflare-runtime/core/proxy/WorkerProxy";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import {
  Artifacts as AlchemyArtifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "alchemy/Artifacts";
import type * as Bundle from "alchemy/Bundle/Bundle";
import * as LocalProvider from "alchemy/Local/LocalProvider";
import { Stack } from "alchemy/Stack";
import { unwrapRedacted } from "alchemy/Util";
import { isPathWithin } from "alchemy/Util/isPathWithin";
import { LogAnnotation } from "alchemy/Util/LogAnnotation";
import { makeResourceLogger, makeResourceOutput } from "alchemy/Util/ResourceOutput";
import { sha256 } from "alchemy/Util/sha256";
import { ANSI_RESET, ansiFg, colorsEnabled } from "alchemy/Util/Terminal";
import { theme } from "alchemy/Util/Theme";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as PlatformFileSystem from "effect/FileSystem";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { DevContainerImage } from "../Containers/ContainerApplication.ts";
import {
  assertBindingContainersOnAsyncClasses,
  mergeWorkerContainers,
} from "../Containers/ContainerConfiguration.ts";
import { localAccountId } from "../LocalAccount.ts";
import {
  isLiveId,
  LOCAL_PROVIDERS_URL,
  LocalRuntimeState,
  localStorageDirectory,
} from "../LocalRuntime.ts";
import type { ConsumerSettings } from "../Queues/Consumer.ts";
import type { WorkerAssetsConfig, WorkerProps } from "../Workers/Worker.ts";
import { readAssetsConfigFiles } from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { isDurableObjectExport } from "./DurableObject.ts";
import { LocalEdge } from "./LocalEdge.ts";
import { routePatternHost } from "./RoutePattern.ts";
import { materializeRuntimeBindings, WorkerValidationError } from "./RuntimeBindings.ts";
import { resolveSource, SourceProviderError, type DevContext } from "./Source.ts";
import { workerBundleOptions } from "./Sources/Rolldown.ts";
import { DEFAULT_DEV_PORT, type ViteChildConfig } from "./ViteChild.shared.ts";
import { startViteChild } from "./ViteChild.ts";
import { resolveViteMain } from "./ViteMain.ts";
import { isSelfUrl, Worker } from "./Worker.ts";
import { getCronBindings } from "./WorkerAsyncBindings.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import { createWorkerName } from "./WorkerName.ts";
import { resolveTailConsumers } from "./WorkerProvider.ts";

/** Local dev-server options (the worker-mode arm of `WorkerProps["dev"]`). */
type DevServerOptions = Extract<WorkerProps["dev"], { mode?: "worker" }> & {
  port: number;
};

const workerStartedMessage = (elapsed: number, url: URL): string => {
  const duration = `${Math.round(elapsed)}ms`;
  if (!colorsEnabled()) {
    return `Started in ${duration} → ${url}`;
  }
  return `Started in ${ansiFg(theme.color.success)}${duration}${ANSI_RESET} → ${ansiFg(theme.color.info)}\x1b[4m${url}${ANSI_RESET}`;
};

const workerUpdatedMessage = (elapsed: number): string => {
  const duration = `${Math.round(elapsed)}ms`;
  return colorsEnabled()
    ? `Updated in ${ansiFg(theme.color.success)}${duration}${ANSI_RESET}`
    : `Updated in ${duration}`;
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
    LOCAL_PROVIDERS_URL,
    Effect.gen(function* () {
      const runtimeBase = process.cwd();
      const dotAlchemy = yield* dotAlchemyDirectory;
      const runtime = yield* Runtime;
      const stack = yield* Stack;
      const storageDirectory = yield* localStorageDirectory;
      const path = yield* Path.Path;
      const localRuntimeState = yield* LocalRuntimeState;
      const workerProxy = yield* WorkerProxy.WorkerProxy;
      const edge = yield* LocalEdge;
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
          settings?.maxWaitTimeMs !== undefined ? settings.maxWaitTimeMs / 1000 : undefined,
        maxRetries: settings?.maxRetries,
        retryDelay: settings?.retryDelay,
      });

      const getQueueConsumers = Effect.fn(function* (scriptName: string) {
        const consumers: RuntimeQueueConsumer[] = [];
        for (const consumer of MutableHashMap.values(localRuntimeState.queueConsumers)) {
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
            const queue = MutableHashMap.get(localRuntimeState.queues, consumer.queueId).pipe(
              Option.getOrUndefined,
            );
            if (queue) {
              consumers.push({
                queueName: queue.queueName,
                deadLetterQueue: consumer.deadLetterQueue,
                ...toRuntimeConsumerSettings(consumer.settings),
              });
            } else {
              return yield* Effect.die(`Queue ${String(consumer.queueId)} not found`);
            }
          }
        }
        return consumers;
      });

      const startProxy = Effect.fn(function* (id: string, serverOptions: DevServerOptions) {
        const scope = yield* Scope.fork(rootScope);
        const instance = yield* workerProxy.serve(serverOptions).pipe(Scope.provide(scope));
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

      const maybeStartProxy = Effect.fn(function* (id: string, serverOptions: DevServerOptions) {
        const existing = proxyInstances.get(id);
        if (existing) {
          if (Equal.equals(existing.serverOptions, serverOptions)) {
            return existing.instance;
          }
          yield* stopProxy(id);
        }
        return yield* startProxy(id, serverOptions);
      });

      const toRuntimeModules = Effect.fn(function* (bundle: Bundle.BundleOutput) {
        const modules: Module[] = [];
        for (const file of bundle.files) {
          // Vendored Python packages are opaque Data modules named by their
          // `python_modules/<relpath>` — mirroring the deploy path — except
          // the `workers-runtime-sdk` JS shims, which the runtime imports
          // as ES modules via `import_from_javascript()`.
          if (file.path.startsWith("python_modules/")) {
            const isJsShim =
              file.path.startsWith("python_modules/workers/") && /\.m?js$/.test(file.path);
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
          const type =
            file.type === "Text"
              ? "Text"
              : file.type === "Data"
                ? "Data"
                : file.type === "CompiledWasm"
                  ? "Wasm"
                  : moduleTypeFromExtension(path.extname(file.path));
          if (type === "SourceMap") continue;
          if (type === "Data" && typeof file.content === "string") {
            modules.push({
              name: file.path,
              type,
              content: new TextEncoder().encode(file.content),
            });
          } else if (type === "Data" || type === "Wasm") {
            if (!(file.content instanceof Uint8Array)) {
              return yield* WorkerValidationError.make({
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
        fqn,
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
        const containers: Record<string, NonNullable<RuntimeDurableObject["container"]>> = {};
        // Content hashes of the container images, keyed like `containers`.
        // `ContainerImage` itself only carries stable paths (context /
        // dockerfile / imageUri), so without the hash an image CONTENT
        // change (a Dockerfile edit, a rebuilt bundle) would never change
        // the config and the running container would serve stale code.
        const containerHashes: Record<string, string> = {};
        const containerRows: NonNullable<Worker["Binding"]["containers"]> = [];
        const boundEnv: Record<string, any> = { ...props.env };
        for (const { data } of bindings) {
          if (data.env) Object.assign(boundEnv, data.env);
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
                binding.namespaceId ?? encodeURIComponent(`${name}-${binding.className}`);
              durableObjectNamespaces[binding.className] = {
                className: binding.className,
                uniqueKey: namespaceId,
                // A key-value backed class has no SQL storage, as on Cloudflare.
                sql: binding.storage !== "legacy-kv",
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
          if (data.containers) containerRows.push(...data.containers);
        }
        // A Durable Object-managed class merges the images of every bound
        // Container (keyed by Container id); a fleet class has one image.
        // Build paths resolve against the stack's working directory here: a
        // Vite Worker's runtime runs in a child whose cwd is the site root.
        const toRuntimeImage = (image: DevContainerImage) =>
          "dockerfile" in image
            ? {
                ...image,
                ...(image.context !== undefined
                  ? { context: path.resolve(runtimeBase, image.context) }
                  : { dockerfile: path.resolve(runtimeBase, image.dockerfile) }),
                env: unwrapRedacted(image.env),
                buildSecrets: unwrapRedacted(image.buildSecrets),
              }
            : { ...image, env: unwrapRedacted(image.env) };
        const exportMap = (props.exports ?? {}) as Record<string, unknown>;
        yield* assertBindingContainersOnAsyncClasses(
          containerRows,
          Object.keys(exportMap).filter((name) => isDurableObjectExport(exportMap[name])),
        );
        for (const container of yield* mergeWorkerContainers(containerRows)) {
          if (container.devImages !== undefined) {
            const images: Record<string, RuntimeContainerImage> = {};
            for (const [key, image] of Object.entries(container.devImages)) {
              images[key] = toRuntimeImage(image);
            }
            containers[container.className] = { images };
          } else if (container.dev) {
            containers[container.className] = toRuntimeImage(container.dev);
          } else {
            return yield* Effect.die(`Container ${container.className} has no dev image`);
          }
          if (container.hash !== undefined) {
            containerHashes[container.className] = container.hash;
          }
        }
        for (const [className, dev] of Object.entries(containers)) {
          if (!durableObjectNamespaces[className]) {
            return yield* Effect.die(`Durable Object namespace ${className} not found`);
          }
          durableObjectNamespaces[className].container = dev;
        }
        const dev: DevServerOptions | { readonly mode: "external"; readonly url?: string } =
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
          /** Namespace-qualified id — the display prefix for every log line. */
          fqn,
          name,
          compatibility,
          /** User env (Redacted preserved — the canonical hasher unwraps). */
          env: Object.keys(boundEnv).length > 0 ? boundEnv : props.env,
          /**
           * Raw inline module source (mutually exclusive with `main`).
           * Serves as-is without the bundler; part of the hashed config so
           * editing the script restarts the instance.
           */
          script: props.script,
          // External source providers (`props.source`) opt in through
          // `devAssetsBinding` instead (see `ViteChildRunner`): injecting
          // the hook for every source would fail in dev hosts with no
          // assets service configured (the hook errors when the Assets
          // service is unconfigured).
          hasAssets: !!(props.assets || props.vite) && !props.source,
          /**
           * Assets-only Worker (no entry module at all): served locally by
           * a stub that delegates every request to the ASSETS binding.
           */
          assetsOnly:
            props.main === undefined && props.script === undefined && !props.vite && !!props.assets,
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
            ? yield* resolveViteMain(
                path.resolve(props.vite.rootDir ?? process.cwd()),
                props.vite.main,
              )
            : undefined,
          viteEnvironments: props.vite?.viteEnvironments,
          viteRootDir: props.vite?.rootDir,
          bundleOptions: workerBundleOptions({
            id,
            props,
            compatibility,
            stack: { name: stack.name, stage: stack.stage },
          }),
          assets: props.assets,
          dev,
          crons: Array.from(new Set([...getCronBindings(bindings), ...(props.crons ?? [])])),
          // Tail consumers, resolved to plain `{ service }` records exactly
          // like the live provider hashes/uploads them (script names only,
          // deliberately hash-safe). Restart-relevant: serve lowers the list
          // into workerd's native `tails` service designators.
          tailConsumers: resolveTailConsumers(props.tailConsumers),
          // Streaming tail consumers, same resolution — serve lowers the
          // list into workerd's `streamingTails` designators, which deliver
          // the producer's events live via the consumer's `tailStream()`.
          streamingTailConsumers: resolveTailConsumers(props.streamingTailConsumers),
          /**
           * Zone routes, emulated by the local edge (see `LocalEdge`). The
           * zone is never resolved in dev — `zoneId` is the declared id or
           * a `dev:`-marked stand-in.
           */
          routes: (props.routes ?? []).map((route) => {
            const pattern = route.pattern.trim();
            const zone =
              route.zoneName ??
              (typeof route.zone === "string" ? route.zone : route.zone?.zoneId) ??
              routePatternHost(pattern) ??
              pattern;
            return { id: `dev:${pattern}`, pattern, zoneId: route.zoneId ?? `dev:${zone}` };
          }),
          /**
           * The custom-domain hostname. In dev the Worker's own URL serves
           * it, with zone routes for the hostname applied in front.
           */
          edgeDomain:
            typeof props.domain === "string" ? props.domain : (props.domain?.name ?? undefined),
          /**
           * The zone outbound `fetch()`es report in `CF-Worker`: the custom
           * domain, else the first route's zone, as Wrangler derives it.
           */
          zone:
            (typeof props.domain === "string" ? props.domain : props.domain?.name) ??
            props.routes?.[0]?.zoneName ??
            (props.routes?.[0] ? routePatternHost(props.routes[0].pattern.trim()) : undefined),
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
        const accountId = yield* localAccountId;
        return yield* materializeRuntimeBindings(
          {
            ...config,
            devAccess: config.dev.mode === "external" ? undefined : config.dev.access,
          },
          {
            accountId,
            selfUrl,
            stack: { name: stack.name, stage: stack.stage },
          },
        );
      });

      // Latest successful serve per worker FQN, so runtime wiring changes
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
      // Serializes serves per worker FQN: a restart triggered by a sibling
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
      // Workers with containers are the exception: their previous instance
      // is retired after the images are ready but before the new workerd
      // boots (see `beforeServe` in `serveWith`).
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
       * One container-context watcher per worker FQN, keyed by the watched
       * path set. Registry-held (NOT per-serve-scope): a worker restarts
       * through several code paths that overlap scopes, and a watcher per
       * serve produced DUPLICATES whose simultaneous restarts storm the
       * instance until the DO's container link breaks.
       */
      const containerWatchers = new Map<string, { key: string; fiber: Fiber.Fiber<void> }>();

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
          ChildProcessSpawner.ChildProcessSpawner | PlatformFileSystem.FileSystem | Path.Path
        >,
      ) =>
        Effect.gen(function* () {
          const fs = yield* PlatformFileSystem.FileSystem;
          const watched = new Map<string, { dockerfile: string | undefined }>();
          for (const namespace of worker.durableObjectNamespaces) {
            const container = namespace.container;
            if (container === undefined) continue;
            const images = "images" in container ? Object.values(container.images) : [container];
            for (const image of images) {
              if (!("dockerfile" in image)) continue;
              const context = path.resolve(runtimeBase, image.context ?? ".");
              if (isPathWithin(dotAlchemy, context, runtimeBase)) continue;
              watched.set(context, {
                dockerfile:
                  image.dockerfile !== undefined
                    ? path.resolve(context, image.dockerfile)
                    : undefined,
              });
            }
          }
          const key = JSON.stringify(
            [...watched.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          );
          const existing = containerWatchers.get(worker.fqn);
          if (existing !== undefined) {
            if (existing.key === key) return; // same watcher keeps running
            yield* stopContainerWatcher(worker.fqn);
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
                    hashes.push(`${file}:${yield* fs.readFile(file).pipe(Effect.flatMap(sha256))}`);
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

          const streams = [...watched.entries()].flatMap(([context, { dockerfile }]) => [
            fs.watch(context, { recursive: true }),
            ...(dockerfile !== undefined && !dockerfile.startsWith(context)
              ? [fs.watch(path.dirname(dockerfile))]
              : []),
          ]);
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
                  yield* Effect.logInfo(`Container build context changed, restarting instance`);
                  yield* restart;
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning(`Container context watch failed`, Cause.squash(cause)),
              ),
            );
          });
          const fiber = yield* watchLoop.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const current = containerWatchers.get(worker.fqn);
                if (current?.fiber === fiber) {
                  containerWatchers.delete(worker.fqn);
                }
              }),
            ),
            Effect.forkIn(rootScope),
          );
          containerWatchers.set(worker.fqn, { key, fiber });
        });

      // Custom-domain hostnames handed to the local edge, per worker FQN.
      const edgeDomains = new Map<string, { host: string; script: string }>();

      const releaseEdgeDomain = Effect.fn(function* (fqn: string) {
        const previous = edgeDomains.get(fqn);
        if (previous) {
          edgeDomains.delete(fqn);
          yield* edge.removeDomain(previous.host, previous.script);
        }
      });

      /**
       * Point the worker's stable proxy at a freshly served workerd. A
       * custom-domain worker is handed to the local edge instead, which
       * fronts it with the zone-route router whenever routes match its
       * hostname (Cloudflare's routes-over-custom-domain precedence).
       */
      const exposeWorker = Effect.fn(function* (
        worker: RunnableWorkerConfig,
        proxy: WorkerProxy.WorkerProxyInstance,
        url: URL,
      ) {
        const previous = edgeDomains.get(worker.fqn);
        if (previous && (previous.host !== worker.edgeDomain || previous.script !== worker.name)) {
          yield* releaseEdgeDomain(worker.fqn);
        }
        if (worker.edgeDomain === undefined) {
          return yield* proxy.set(url);
        }
        edgeDomains.set(worker.fqn, { host: worker.edgeDomain, script: worker.name });
        yield* edge.serveDomain(worker.edgeDomain, { script: worker.name, proxy, upstream: url });
      });

      const serveWith = (
        worker: RunnableWorkerConfig,
        bundle: Bundle.BundleOutput,
        proxy: WorkerProxy.WorkerProxyInstance,
      ) =>
        Semaphore.withPermits(
          serveLock(worker.fqn),
          1,
        )(
          // The bookkeeping around `runtime.start` must not be torn in half
          // by an interrupt: once a replacement workerd is up, it must be
          // recorded in `workerdScopes` and the superseded instances must be
          // closed, or one of the workerds would leak until provider
          // shutdown while holding the shared registry key.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const previous = workerdScopes.get(worker.fqn);
              // Instances to tear down once the replacement is up: `previous`
              // plus any instance whose queue-consumer wiring went stale
              // while it was starting (never exposed via the proxy).
              const retiring: Scope.Closeable[] = previous ? [previous] : [];
              const closeRetiring = Effect.suspend(() =>
                Effect.forEach(
                  retiring.splice(0),
                  (replaced) =>
                    Scope.close(replaced, Exit.void).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          `Failed to stop previous local worker instance`,
                          Cause.squash(cause),
                        ),
                      ),
                    ),
                  { discard: true },
                ),
              ).pipe(Effect.uninterruptible);
              // Container names are deterministic per Durable Object, so a
              // new workerd would "recover" the previous instance's
              // still-running container — which the previous instance's
              // teardown then removes (with its networking sidecar) out from
              // under it. For workers with containers, break before make:
              // retire the previous instance after the slow part of the start
              // (image builds/pulls) but before the new workerd boots, parking
              // requests on the proxy until the cutover.
              const hasContainers = worker.durableObjectNamespaces.some(
                (namespace) => namespace.container !== undefined,
              );
              const beforeServe = hasContainers
                ? Effect.suspend(() =>
                    retiring.length > 0
                      ? Effect.andThen(proxy.unset(), closeRetiring)
                      : Effect.void,
                  )
                : undefined;
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
                // `logging.onOutput` REPLACES workerd's stdio inheritance, so
                // this is the only path its output takes: complete lines become
                // log records tagged with the worker.
                // One splitter per channel: a shared buffer would splice a
                // partial stdout line onto the next stderr chunk, and stderr
                // would lose its severity on the way to the console.
                const splitters = yield* makeResourceOutput(worker.fqn);
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => {
                    splitters.stdout.flush();
                    splitters.stderr.flush();
                  }),
                );
                url = yield* restore(
                  runtime
                    .start({
                      name: worker.name,
                      logging: {
                        // `(chunk, stream)` — chunk first; the stream name
                        // indexes the splitters directly.
                        onOutput: (chunk, stream) => splitters[stream].push(chunk),
                      },
                      compatibilityDate: worker.compatibility.date,
                      compatibilityFlags: worker.compatibility.flags,
                      zone: worker.zone,
                      // `dev.access` populates the Worker's native `ctx.access`.
                      access: worker.dev.access,
                      // Stream preview and Images variant URLs use the stable URL
                      // clients reach the Worker at, as Miniflare uses its public URL.
                      publicUrl: proxy.url.toString().replace(/\/$/, ""),
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
                      streamingTails: worker.streamingTailConsumers?.map((c) => c.service),
                      // Cache API opt-out (`dev: { cache: false }`) — matches
                      // production workers.dev, where the Cache API is a no-op.
                      cache: worker.dev.cache,
                      // Per-worker request.cf override (`dev: { cf: {...} }`).
                      cf: worker.dev.cf,
                      workerd: worker.dev.workerd,
                      modules: yield* toRuntimeModules(bundle),
                      assets: yield* toRuntimeAssets(worker.assets),
                      beforeServe,
                    })
                    .pipe(Scope.provide(scope)),
                ).pipe(
                  // The scope hangs off `rootScope`, so a failed or
                  // interrupted start must close it here — nothing else owns
                  // it yet.
                  Effect.onExit((exit) =>
                    exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void,
                  ),
                );
                workerdScopes.set(worker.fqn, scope);
                latestServes.set(worker.fqn, { worker, bundle, proxy });
                // Register the restart hook before the re-check below: changes
                // landing after the re-check find the hook; changes before it
                // are caught by the re-check. Nothing falls in between.
                MutableHashMap.set(
                  localRuntimeState.workerRestarts,
                  worker.name,
                  restartWorker(worker.fqn),
                );
                // Idempotent: the registry keeps ONE watcher per worker FQN
                // across restarts (a new one only when the watched path set
                // changed).
                yield* ensureContainerWatcher(
                  worker,
                  Effect.suspend(() => restartWorker(worker.fqn)),
                );
                const currentConsumers = yield* getQueueConsumers(worker.name);
                if (JSON.stringify(currentConsumers) !== JSON.stringify(queueConsumers)) {
                  // Wiring changed while workerd was starting — serve again
                  // with the fresh consumers before exposing the instance.
                  retiring.push(scope);
                  continue;
                }
                break;
              }
              yield* exposeWorker(worker, proxy, url);
              // Only now tear the replaced instances down (unless
              // `beforeServe` already did): `previous` kept serving — and
              // stayed registered in the dev registry — until the cutover
              // above. The registry's entry removal is owner-aware, so these
              // closes cannot delete the replacement's registration.
              yield* closeRetiring;
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
      const logRestartFailure = (fqn: string) =>
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.logWarning(`Failed to restart local worker`, Cause.squash(cause)).pipe(
            Effect.annotateLogs(LogAnnotation.fqn, fqn),
          ),
        );

      const restartWorker = (
        id: string,
      ): Effect.Effect<
        void,
        never,
        ChildProcessSpawner.ChildProcessSpawner | PlatformFileSystem.FileSystem | Path.Path
      > =>
        Effect.suspend(() => {
          const latest = latestServes.get(id);
          if (latest) {
            return serveWith(latest.worker, latest.bundle, latest.proxy).pipe(
              Effect.asVoid,
              logRestartFailure(latest.worker.fqn),
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
              logRestartFailure(vite.worker.fqn),
            );
          }
          return Effect.void;
        });

      // Tear down the running workerd for a worker FQN, if any. Used when the
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
          MutableHashMap.remove(localRuntimeState.workerRestarts, latest.worker.name);
          latestServes.delete(id);
          latestViteServes.delete(id);
          servedViteConsumers.delete(id);
          servedViteHttps.delete(id);
        }
      };

      /**
       * Drain a stream of bundle-watch events into the make-before-break
       * `serveWith` path, forked into the instance scope: queue requests
       * while a rebuild is in flight, serve every successful bundle, and
       * log build/serve errors without tearing the instance down.
       *
       * Used by every bundle-mode source (`runSource`), which all speak the
       * {@link Bundle.BundleWatchEvent} protocol.
       */
      const serveBundleStream = Effect.fn(function* <E, R>(
        worker: RunnableWorkerConfig,
        proxy: WorkerProxy.WorkerProxyInstance,
        bundles: Stream.Stream<Bundle.BundleWatchEvent, E, R>,
      ) {
        let start = Date.now();
        let status: "start" | "update" = "start";
        // Resolved once the first bundle is served (or its build or serve
        // failed): the instance's `start` returns at readiness, so a restart
        // never completes while the previous bundle is still the latest
        // serve (`latestServes`) that restart hooks re-serve.
        const firstServe = yield* Deferred.make<void>();
        yield* bundles.pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              start = Date.now();
              if (status === "update") {
                return Effect.all([
                  Effect.log(`Rebuilding`),
                  // Tells the proxy to queue requests until the updated
                  // worker is ready.
                  proxy.unset(),
                ]);
              }
            } else if (event._tag === "Error") {
              return Effect.all([
                Effect.logError(`Bundle error`, event.error),
                // No updated worker is coming from this build: answer
                // parked requests with the error now instead of after the
                // pending timeout.
                proxy.fail(event.error.message),
                Deferred.succeed(firstServe, undefined),
              ]);
            }
            return Effect.void;
          }),
          Stream.filterMap((event) =>
            event._tag === "Success" ? Result.succeed(event.output) : Result.failVoid,
          ),
          Stream.mapEffect((bundle) =>
            serveWith(worker, bundle, proxy).pipe(
              Effect.exit,
              Effect.tap((exit) => {
                if (exit._tag === "Success") {
                  // URL on first start only — vite-banner style; rebuild
                  // lines stay compact.
                  const message = Effect.log(
                    status === "update"
                      ? workerUpdatedMessage(Date.now() - start)
                      : workerStartedMessage(Date.now() - start, proxy.url),
                  );
                  status = "update";
                  return message;
                } else {
                  return Effect.all([
                    Effect.logError(`Error`, Cause.squash(exit.cause)),
                    proxy.fail(Cause.pretty(exit.cause)),
                  ]);
                }
              }),
              Effect.ensuring(Deferred.succeed(firstServe, undefined)),
            ),
          ),
          Stream.runDrain,
          // A stream that ends or fails before any bundle must not park
          // `start` forever.
          Effect.ensuring(Deferred.succeed(firstServe, undefined)),
          Effect.forkScoped,
        );
        yield* Deferred.await(firstServe);
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
            content: "export default { fetch: (request, env) => env.ASSETS.fetch(request) };",
            hash: "assets-only-stub",
          },
        ],
        hash: "assets-only-stub",
      };

      const runAssetsOnly = Effect.fn(function* (worker: RunnableWorkerConfig) {
        const start = Date.now();
        const proxy = yield* maybeStartProxy(worker.fqn, worker.dev);
        yield* serveWith(worker, assetsOnlyBundle, proxy);
        yield* Effect.log(workerStartedMessage(Date.now() - start, proxy.url));
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

      /** Whether each running Vite child serves HTTPS (the app's
       * `server.https`): the proxy relays TLS untouched, so its URL takes the
       * child's scheme. */
      const servedViteHttps = new Map<string, boolean>();

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
      const serveVite = (args: ViteServeArgs, options?: { onlyIfConsumersChanged?: boolean }) =>
        Semaphore.withPermits(
          serveLock(args.worker.fqn),
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
                  workerdScopes.has(worker.fqn) &&
                  JSON.stringify(current) === servedViteConsumers.get(worker.fqn)
                ) {
                  return;
                }
              }
              // Queue requests while the child is (re)starting.
              yield* proxy.unset();
              // The dev server and its workerd run in a child process rooted
              // at the app.
              const root = path.resolve(rootDir ?? process.cwd());
              const accountId = yield* localAccountId;
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
                yield* closeWorkerd(worker.fqn);
                const scope = yield* Scope.fork(rootScope);
                const logResourceOutput = makeResourceLogger(worker.fqn);
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
                        crons: worker.crons,
                        tails: worker.tailConsumers?.map((c) => c.service),
                        streamingTails: worker.streamingTailConsumers?.map((c) => c.service),
                        cache: worker.dev.cache,
                        cf: worker.dev.cf,
                        workerd: worker.dev.workerd,
                        zone: worker.zone,
                        assets: yield* toRuntimeAssets(worker.assets),
                      },
                    },
                    logResourceOutput,
                  ).pipe(Scope.provide(scope)),
                ).pipe(
                  // The scope hangs off `rootScope`, so a failed or
                  // interrupted start must close it here — nothing else owns
                  // it yet.
                  Effect.onExit((exit) =>
                    exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void,
                  ),
                );
                workerdScopes.set(worker.fqn, scope);
                latestViteServes.set(worker.fqn, args);
                // Unexpected child death: log, fail the proxy so requests
                // see why instead of parking, and mark the instance for
                // update on the next plan. Forked into the child's scope so
                // a deliberate restart or teardown interrupts the watcher
                // before the process is killed.
                yield* child.exitCode.pipe(
                  Effect.flatMap((exitCode) => {
                    const message = `Dev server child exited unexpectedly with code ${exitCode}`;
                    return Effect.all([Effect.logWarning(message), proxy.fail(message)]);
                  }),
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
                  restartWorker(worker.fqn),
                );
                const currentConsumers = yield* getQueueConsumers(worker.name);
                if (JSON.stringify(currentConsumers) !== JSON.stringify(queueConsumers)) {
                  // Wiring changed while the child was starting — serve
                  // again with the fresh consumers before exposing it.
                  continue;
                }
                servedViteConsumers.set(worker.fqn, JSON.stringify(queueConsumers));
                servedViteHttps.set(worker.fqn, child.url.protocol === "https:");
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
        const start = Date.now();
        const proxy = yield* maybeStartProxy(worker.fqn, worker.dev);
        yield* serveVite({ worker, rootDir, invalidate, source, proxy });
        const url = new URL(proxy.url);
        if (servedViteHttps.get(worker.fqn)) url.protocol = "https:";
        // The programmatic vite API never prints the CLI's URL banner — and
        // vite's own URL is the internal (port-shuffled) server behind the
        // stable proxy, so advertise the proxy instead.
        yield* Effect.log(workerStartedMessage(Date.now() - start, url));
        return url;
      });

      // Every Worker served from bundles goes through its source provider's
      // `dev()`, as deploy goes through its `build()` (see `resolveSource`):
      // the built-in sources (inline script, Python, prebuilt, rolldown)
      // and external ones (`props.source`). Two modes (see
      // `SourceDevHandle`); `server` sources are run by `runVite`, so this
      // serves `bundle`: each successful bundle is served through the
      // make-before-break `serveWith` path.
      const runSource = Effect.fn(function* (worker: RunnableWorkerConfig) {
        const proxy = yield* maybeStartProxy(worker.fqn, worker.dev);
        // Queue requests until the source's first bundle is served.
        yield* proxy.unset();
        // `resolveSource` is typed against the full `SourceServices` union
        // (which includes the per-run Artifacts cache the live provider
        // supplies); local dev has no run-scoped cache, so hand the
        // source a fresh in-memory one.
        const source = yield* resolveSource({
          source: worker.source,
          script: worker.script,
          main: worker.source ? undefined : worker.bundleOptions.main,
          bundle: worker.prebuilt ? false : undefined,
          rules: worker.rules,
        }).pipe(
          Effect.provideService(
            AlchemyArtifacts,
            makeScopedArtifacts(createArtifactStore(), worker.fqn),
          ),
        );
        const devCtx: DevContext = {
          dotAlchemy,
          id: worker.id,
          fqn: worker.fqn,
          workerName: worker.name,
          compatibility: worker.compatibility,
          entry: worker.bundleOptions.entry,
          stack: { name: stack.name, stage: stack.stage },
          env: worker.env,
          // Dev hands `env` to the source unresolved; the Worker's own URL
          // is only substituted into a build's inlined env on deploy.
          selfUrl: undefined,
          extraOptions: worker.bundleOptions.extraOptions,
          assets: worker.assets,
          worker: {
            bindings: worker.workerBindings,
            durableObjectNamespaces: worker.durableObjectNamespaces,
            hyperdrives: worker.hyperdrives,
            queueConsumers: getQueueConsumers(worker.name),
            assets: yield* toRuntimeAssets(worker.assets),
            options: {
              workflows: worker.workflows,
              crons: worker.crons,
              tails: worker.tailConsumers?.map((c) => c.service),
              streamingTails: worker.streamingTailConsumers?.map((c) => c.service),
              cache: worker.dev.cache,
              cf: worker.dev.cf,
              zone: worker.zone,
              access: worker.dev.access,
              workerd: worker.dev.workerd,
            },
          },
          runtimeContext: context,
        };
        const handle = yield* source.dev(devCtx);
        if (handle.mode !== "bundle") {
          return yield* new SourceProviderError({
            provider: worker.source?.provider ?? "built-in",
            message: "A source declared devMode 'bundle' but returned a server-mode dev handle.",
          });
        }
        yield* serveBundleStream(worker, proxy, handle.bundles);
        return proxy.url;
      });

      return {
        resolveConfig,

        // The physical name only survives an update when it isn't changing.
        stables: ({ output, config }) =>
          Effect.succeed(
            output?.workerName === config.name ? (["workerName"] as ["workerName"]) : undefined,
          ),

        precreate: Effect.fn(function* ({ id, fqn, news, bindings }) {
          const name = yield* createWorkerName(id, news.name);
          const durableObjectNamespaces: Record<string, string> = {};
          for (const { data } of bindings) {
            for (const binding of data?.bindings ?? []) {
              if (binding.type === "durable_object_namespace") {
                // Only classes this Worker hosts get a namespace, as in the
                // live provider's `getDurableObjectBindings`. A cross-script
                // reference names another Worker, by an Output that is still
                // unresolved here.
                if (binding.scriptName !== undefined && binding.scriptName !== name) continue;
                durableObjectNamespaces[binding.className] =
                  binding.namespaceId ?? encodeURIComponent(`${name}-${binding.className}`);
              }
            }
          }
          const accountId = yield* localAccountId;
          const urls =
            news.dev?.mode === "external"
              ? // news.dev.url may be an unresolved output; avoid trying to resolve it here.
                []
              : yield* maybeStartProxy(fqn, {
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
            crons: Array.from(new Set([...getCronBindings(bindings), ...(news.crons ?? [])])),
            accountId,
          };
        }),

        start: Effect.fn(function* ({ fqn, config, invalidate }) {
          const accountId = yield* localAccountId;

          // `dev: { mode: "external" }` opts out of running a local Worker
          // entirely — typically because an external dev process
          // (Command.Dev) is serving requests. The instance exists in the
          // registry (with an empty scope) but has no workerd behind it. A
          // previous worker-mode instance for this FQN may have registered
          // serve/restart state — drop it, and tear down its workerd (with
          // make-before-break the running workerd outlives instance scopes
          // and must be closed explicitly on handoff).
          if (config.dev.mode === "external") {
            dropServeState(fqn);
            yield* closeWorkerd(fqn);
            yield* edge.removeRoutes(fqn);
            yield* releaseEdgeDomain(fqn);
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
          // the proxy is stable per worker FQN (the same instance `runWorker`
          // / `runVite` attach to below), so the URL is known before workerd
          // starts. Trailing slash stripped to match the cloud value's shape.
          const needsSelfUrl =
            config.bindingDescriptors.some(
              (b) => b.type === "self_url" || b.type === "r2_s3_credentials",
            ) || Object.values(config.env ?? {}).some(isSelfUrl);
          const selfUrl = needsSelfUrl
            ? (yield* maybeStartProxy(fqn, config.dev)).url.toString().replace(/\/$/, "")
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
          const workerBindings = yield* materializeWorkerBindings({ ...config, env }, selfUrl);
          const worker: RunnableWorkerConfig = {
            ...config,
            env,
            dev: config.dev,
            workerBindings,
          };
          // Zone routes target this script through the local edge's router.
          yield* edge.setRoutes(
            fqn,
            config.routes.map((route) => ({ pattern: route.pattern, script: config.name })),
          );
          // Only workerd-served workers can sit behind the edge router (it
          // reaches them over service bindings); dev-server modes keep
          // their proxy pointed at the dev server.
          if (config.vite || config.source?.devMode === "server") {
            yield* releaseEdgeDomain(fqn);
          }
          const serverUrl = yield* config.source
            ? config.source.devMode === "server"
              ? runVite(worker, config.source.rootDir, invalidate, {
                  descriptor: config.source,
                  id: worker.id,
                  fqn: worker.fqn,
                  assets: worker.assets,
                })
              : runSource(worker)
            : config.vite
              ? runVite(worker, config.viteRootDir, invalidate)
              : config.assetsOnly
                ? runAssetsOnly(worker)
                : runSource(worker);
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
            // Each route reports the edge listener serving its hostname.
            routes: yield* Effect.forEach(config.routes, (route) => {
              const host = routePatternHost(route.pattern);
              return host === undefined
                ? Effect.succeed(route)
                : edge.url(host).pipe(Effect.map((url) => ({ ...route, url: url?.origin })));
            }),
            crons: config.crons,
            tailConsumers: config.tailConsumers,
            streamingTailConsumers: config.streamingTailConsumers,
            accountId,
          } satisfies Worker["Attributes"];
        }),

        stop: Effect.fn(function* ({ fqn }) {
          // Cross-restart state: the serve/restart bookkeeping, the running
          // workerd (which outlives instance scopes for make-before-break),
          // and the URL proxy live outside instance scopes and are only
          // reclaimed on a real delete.
          dropServeState(fqn);
          yield* edge.removeRoutes(fqn);
          yield* releaseEdgeDomain(fqn);
          yield* closeWorkerd(fqn);
          yield* stopProxy(fqn);
        }),
      } satisfies LocalProvider.LocalProviderSpec<
        Worker,
        Effect.Success<ReturnType<typeof resolveConfig>>,
        // The Python-bundle watcher spawns `uv` (ChildProcessSpawner) and
        // reads vendored modules (FileSystem) from inside `start`;
        // `readAssetsConfigFiles` (assets `_headers`/`_redirects`) needs
        // FileSystem + Path.
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >;
    }),
  );

const toRuntimeAssets = Effect.fn(function* (assets: WorkerAssetsConfig | undefined) {
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
  const directory: string | undefined = typeof assets === "string" ? assets : assets.directory;
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
      return "Data";
  }
};
