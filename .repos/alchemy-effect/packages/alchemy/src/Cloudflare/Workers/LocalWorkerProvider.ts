import {
  layerRuntime,
  Runtime,
  RuntimeError,
  type BindingHook,
  type BindingServices,
  type HyperdriveOrigin,
  type Module,
  type Assets as RuntimeAssets,
  type DurableObjectNamespace as RuntimeDurableObjectNamespace,
  type RuntimeServices,
} from "@distilled.cloud/cloudflare-runtime";
import {
  Ai,
  AnalyticsEngine,
  Artifacts,
  Assets,
  Browser,
  D1,
  Data,
  DispatchNamespace,
  DurableObjectNamespace,
  Hyperdrive,
  Images,
  Json,
  KvNamespace,
  MtlsCertificate,
  Pipelines,
  R2Bucket,
  RateLimit,
  SendEmail,
  Service,
  Text,
  Vectorize,
  VersionMetadata,
  WasmModule,
  WorkerLoader,
  Workflows,
} from "@distilled.cloud/cloudflare-runtime/bindings";
import * as WorkerProxy from "@distilled.cloud/cloudflare-runtime/proxy/WorkerProxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { WorkerAssetsConfig, WorkerProps } from "../Workers/Worker.ts";
import { getCompatibility } from "./Compatibility.ts";
import * as Vite from "./Vite.ts";
import { Worker } from "./Worker.ts";
import { getCronBindings } from "./WorkerAsyncBindings.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import { WorkerBundle, type WorkerBundleOptions } from "./WorkerBundle.ts";
import { createWorkerName } from "./WorkerName.ts";

export class WorkerValidationError extends Schema.TaggedErrorClass<WorkerValidationError>()(
  "WorkerValidationError",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    value: Schema.Unknown,
  },
) {}

export const localRuntimeServices = () =>
  RpcProvider.providerServicesEffect(
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const { dotAlchemy } = yield* AlchemyContext;
      const path = yield* Path.Path;
      return layerRuntime({
        api: {
          accountId,
        },
        storage: {
          directory: path.join(dotAlchemy, "local"),
        },
      });
    }),
  );

export const LocalWorkerProvider = () =>
  RpcProvider.effect(
    Worker,
    import.meta.resolve(
      // `import.meta.resolve(<string>)` is a runtime API — TypeScript's
      // `rewriteRelativeImportExtensions` does NOT touch the string literal, so
      // we have to pick the right extension ourselves. `import.meta.url` reflects
      // the actual on-disk extension of *this* file (`.ts` when loaded from
      // `src/` under Bun or vitest, `.js` when loaded from the compiled `lib/`
      // under Node), which is exactly the signal we need.
      import.meta.url.endsWith(".ts") ? "../Local.ts" : "../Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const bundler = yield* WorkerBundle;
      const runtime = yield* Runtime;
      const stack = yield* Stack;
      const path = yield* Path.Path;
      const workerProxy = yield* WorkerProxy.WorkerProxy;
      const proxyInstances = new Map<
        string,
        {
          serverOptions: WorkerConfig["dev"];
          instance: WorkerProxy.WorkerProxyInstance;
          scope: Scope.Closeable;
        }
      >();

      const startProxy = Effect.fn(function* (
        id: string,
        serverOptions: WorkerConfig["dev"],
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
        serverOptions: WorkerConfig["dev"],
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
            if (typeof file.content !== "string") {
              return yield* new WorkerValidationError({
                message: `Expected string for ${file.path} (${type})`,
                value: file.content,
              });
            }
            modules.push({
              name: file.path,
              type,
              content: file.content,
            });
          }
        }
        return modules;
      });

      const serveScoped = Effect.fnUntraced(function* (
        worker: WorkerConfig,
        bundle: Bundle.BundleOutput,
        proxy: WorkerProxy.WorkerProxyInstance,
      ) {
        const scope = yield* Effect.scope.pipe(Effect.flatMap(Scope.fork));
        const url = yield* runtime
          .start({
            name: worker.name,
            compatibilityDate: worker.compatibility.date,
            compatibilityFlags: worker.compatibility.flags,
            bindings: worker.workerBindings as never,
            hyperdrives: worker.hyperdrives,
            durableObjectNamespaces: toRuntimeDurableObjectNamespaces(
              worker.durableObjectNamespaces,
            ),
            modules: yield* toRuntimeModules(bundle),
            assets: toRuntimeAssets(worker.assets),
          })
          .pipe(Scope.provide(scope));
        const previous = workerdScopes.get(worker.id);
        if (previous) {
          yield* Effect.forkDetach(Scope.close(previous, Exit.void));
        }
        workerdScopes.set(worker.id, scope);
        yield* proxy.set(url);
        return url;
      });

      const buildConfig = Effect.fn(function* ({
        id,
        props,
        bindings,
      }: {
        id: string;
        props: WorkerProps;
        bindings: ResourceBinding<Worker["Binding"]>[];
      }) {
        const name = yield* createWorkerName(id, props.name);
        const compatibility = getCompatibility(props);
        const workerBindings: BindingHook<BindingServices>[] = [
          Text.local("ALCHEMY_PHASE", "runtime"),
          Text.local("ALCHEMY_STACK_NAME", stack.name),
          Text.local("ALCHEMY_STAGE", stack.stage),
          ...Object.entries(props.env ?? {}).map(([key, value]) => {
            const unredacted = Redacted.isRedacted(value)
              ? Redacted.value(value)
              : value;
            return typeof unredacted === "string"
              ? Text.local(key, unredacted)
              : Json.local(key, unredacted);
          }),
        ];
        const durableObjectNamespaces: Record<string, string> = {};
        const hyperdrives: Record<string, Required<HyperdriveOrigin>> = {};
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
              durableObjectNamespaces[binding.className] =
                binding.namespaceId ??
                encodeURIComponent(`${id}-${binding.className}`);
            }
            workerBindings.push(yield* toRuntimeBinding(binding));
          }
          if (data.hyperdrives) {
            for (const [id, origin] of Object.entries(data.hyperdrives)) {
              hyperdrives[id] = {
                scheme: origin.scheme,
                host: origin.host,
                port: origin.port,
                user: origin.user,
                database: origin.database,
                password: Redacted.isRedacted(origin.password)
                  ? Redacted.value(origin.password)
                  : origin.password,
                sslmode: origin.sslmode,
              };
            }
          }
        }
        return {
          id,
          name,
          compatibility,
          workerBindings,
          durableObjectNamespaces,
          hyperdrives,
          bundleOptions: {
            id,
            main: props.main!,
            compatibility,
            entry: props.isExternal
              ? { kind: "external" }
              : { kind: "effect", exports: (props.exports ?? {}) as any },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: props.build,
          } satisfies WorkerBundleOptions,
          assets: props.assets,
          dev: {
            ...props.dev,
            // This is the default. Vite and cloudflare-runtime will retry if unavailable, unless `strictPort` is true.
            port: props.dev?.port ?? 1337,
          },
        };
      });

      type WorkerConfig = Effect.Success<ReturnType<typeof buildConfig>>;

      const runServer = Effect.fnUntraced(function* (worker: WorkerConfig) {
        let start = Date.now();
        let status: "start" | "update" = "start";
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        yield* bundler.watch(worker.bundleOptions).pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              start = Date.now();
              if (status === "update") {
                return Effect.all([
                  Effect.log(`[${worker.id}] Rebuilding`),
                  // This tells the proxy to queue requests until the updated worker is ready.
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
            serveScoped(worker, bundle, proxy).pipe(
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
        return proxy.url.toString();
      });

      const rootScope = yield* Effect.scope;
      const workerdScopes = new Map<string, Scope.Closeable>();

      const context = yield* Effect.context<RuntimeServices>();
      const instances = new Map<
        string,
        {
          hash: number;
          fiber: Fiber.Fiber<
            Worker["Attributes"],
            Bundle.BundleError | WorkerValidationError | RuntimeError
          >;
          scope: Scope.Closeable;
        }
      >();

      const runInstance = Effect.fn(function* (options: {
        id: string;
        props: WorkerProps;
        bindings: ResourceBinding<Worker["Binding"]>[];
      }) {
        const { props, bindings } = options;
        const config = yield* buildConfig(options);
        let url: string;
        if (props.vite) {
          const devServer = yield* Vite.viteDev(
            props.vite.rootDir,
            props.env ?? {},
            {
              compatibilityDate: config.compatibility.date,
              compatibilityFlags: config.compatibility.flags,
              worker: {
                name: config.name,
                bindings: config.workerBindings,
                durableObjectNamespaces: toRuntimeDurableObjectNamespaces(
                  config.durableObjectNamespaces,
                ),
                hyperdrives: config.hyperdrives,
                assets: toRuntimeAssets(config.assets),
              },
              context,
            },
            config.dev,
          );
          url = devServer.resolvedUrls!.local[0];
        } else {
          url = yield* runServer(config);
        }
        return {
          workerId: config.name,
          workerName: config.name,
          logpush: undefined,
          url,
          tags: [],
          durableObjectNamespaces: config.durableObjectNamespaces,
          domains: [url],
          crons: Array.from(
            new Set([...getCronBindings(bindings), ...(props.crons ?? [])]),
          ),
          accountId,
        } satisfies Worker["Attributes"];
      });

      return {
        diff: Effect.fn(function* ({ id, news, newBindings, output }) {
          if (!isResolved(news) || !isResolved(newBindings)) return undefined;
          const options = {
            id,
            props: news,
            bindings: newBindings,
          };
          const hash = Hash.structure(options);
          if (instances.get(options.id)?.hash === hash) {
            return { action: "noop" };
          }
          const name = yield* createWorkerName(id, news.name);
          return {
            action: "update",
            stables: output?.workerName === name ? ["workerName"] : undefined,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings }) {
          const options = { id, props: news, bindings };
          const hash = Hash.structure(options);
          const existing = instances.get(options.id);
          if (existing) {
            if (existing.hash === hash) {
              yield* Effect.log(
                `[${options.id}] No changes, using existing instance`,
              );
              return yield* Fiber.join(existing.fiber);
            }
            yield* Effect.log(
              `[${options.id}] Changes detected, interrupting existing instance`,
            );
            yield* Fiber.interrupt(existing.fiber);
            yield* Scope.close(existing.scope, Exit.void);
            instances.delete(options.id);
          }
          const scope = yield* Scope.fork(rootScope);
          const fiber = yield* runInstance(options).pipe(
            Effect.forkDetach,
            Scope.provide(scope),
          );
          instances.set(options.id, { hash, fiber, scope });
          return yield* Fiber.join(fiber).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (exit._tag === "Failure") {
                  instances.delete(options.id);
                }
              }),
            ),
          );
        }),
        delete: Effect.fn(function* ({ id }) {
          const existing = instances.get(id);
          if (existing) {
            yield* Fiber.interrupt(existing.fiber);
            yield* Scope.close(existing.scope, Exit.void);
            instances.delete(id);
          }
        }),
      };
    }),
  );

const toRuntimeBinding = Effect.fnUntraced(function* (b: WorkerBinding) {
  const unsupported = () =>
    new WorkerValidationError({
      message: `${b.type} bindings are not supported in local mode`,
      value: b,
    });
  switch (b.type) {
    case "ai":
      return Ai.remote(b.name);
    case "analytics_engine":
      return AnalyticsEngine.local(b.name, b.dataset);
    case "artifacts":
      return Artifacts.remote(b.name, b.namespace);
    case "assets":
      return Assets.local(b.name);
    case "browser":
      return Browser.remote(b.name);
    case "d1":
      return D1.remote(b.name, b.databaseId);
    case "data_blob":
      return Data.local(b.name, Buffer.from(b.part));
    case "dispatch_namespace":
      return DispatchNamespace.remote({
        binding: b.name,
        namespace: b.namespace,
      });
    case "durable_object_namespace":
      return DurableObjectNamespace.local({
        binding: b.name,
        className: b.className,
        scriptName: b.scriptName,
      });
    case "hyperdrive":
      return Hyperdrive.local(b.name, b.id);
    case "images":
      return Images.remote(b.name);
    case "inherit":
      return yield* unsupported();
    case "json":
      return Json.local(b.name, b.json);
    case "kv_namespace":
      return KvNamespace.remote(b.name, b.namespaceId);
    case "mtls_certificate":
      return MtlsCertificate.remote(b.name, b.certificateId);
    case "pipelines":
      return Pipelines.remote(b.name, b.pipeline);
    case "plain_text":
      return Text.local(b.name, b.text);
    case "queue":
      return yield* unsupported();
    case "r2_bucket":
      return R2Bucket.remote(b.name, b.bucketName, b.jurisdiction);
    case "ratelimit":
      return RateLimit.local({
        binding: b.name,
        simple: b.simple,
        namespaceId: b.namespaceId,
      });
    case "secret_key":
      return yield* unsupported();
    case "secret_text":
      return Text.local(b.name, b.text);
    case "secrets_store_secret":
      return yield* unsupported();
    case "send_email":
      return SendEmail.remote({
        binding: b.name,
        destinationAddress: b.destinationAddress,
        allowedDestinationAddresses: b.allowedDestinationAddresses,
        allowedSenderAddresses: b.allowedSenderAddresses,
      });
    case "service":
      return Service.local({ binding: b.name, scriptName: b.service });
    case "text_blob":
      return Data.local(b.name, Buffer.from(b.part));
    case "vectorize":
      return Vectorize.remote(b.name, b.indexName);
    case "version_metadata":
      return VersionMetadata.local(b.name);
    case "wasm_module":
      return WasmModule.local(b.name, Buffer.from(b.part));
    case "worker_loader":
      return WorkerLoader.local(b.name);
    case "workflow":
      return Workflows.local({
        binding: b.name,
        workflowName: b.workflowName,
        className: b.className,
        scriptName: b.scriptName,
      });
    default:
      return yield* unsupported();
  }
});

const toRuntimeAssets = (
  assets: WorkerAssetsConfig | undefined,
): RuntimeAssets | undefined => {
  if (!assets) return undefined;
  if (typeof assets === "string") {
    return {
      directory: assets,
    };
  }
  return {
    directory: "directory" in assets ? assets.directory : assets.path,
    headers: assets.config?.headers,
    redirects: assets.config?.redirects,
    // Distilled widened generated string enums to open unions (`string & {}`);
    // the API only ever returns the known variants here.
    htmlHandling: assets.config?.htmlHandling as
      | "none"
      | "auto-trailing-slash"
      | "force-trailing-slash"
      | "drop-trailing-slash"
      | undefined,
    notFoundHandling: assets.config?.notFoundHandling as
      | "none"
      | "404-page"
      | "single-page-application"
      | undefined,
    runWorkerFirst: assets.config?.runWorkerFirst,
    serveDirectly: assets.config?.serveDirectly,
  };
};

const toRuntimeDurableObjectNamespaces = (
  namespaces: Record<string, string>,
): RuntimeDurableObjectNamespace[] => {
  return Object.entries(namespaces).map(([className, namespaceId]) => ({
    className,
    uniqueKey: namespaceId,
    sql: true,
  }));
};

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
    case ".map":
      return "SourceMap";
    default:
      return "Text";
  }
};
