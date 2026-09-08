import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Docker from "./Docker.ts";
import type * as Globals from "./globals/Globals.ts";
import * as Storage from "./globals/Storage.ts";
import {
  defaultDurableObjectUniqueKey,
  SERVICE_USER_WORKER,
  SOCKET_USER_ENTRY,
} from "./internal/constants.ts";
import { moduleToWorkerd } from "./internal/internal-modules.ts";
import type { BindingHook } from "./PluginContext.ts";
import * as PluginContext from "./PluginContext.ts";
import * as RegistryProxy from "./registry/RegistryProxy.ts";
import { type RuntimeError, SystemError } from "./RuntimeError.shared.ts";
import type { BindingHooks, RuntimeWorker } from "./RuntimeWorker.ts";
import * as Workerd from "./workerd/Workerd.ts";

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly start: <B extends BindingHooks>(
      worker: RuntimeWorker<B>,
    ) => Effect.Effect<URL, RuntimeError, BindingRequirements<B> | Scope.Scope>;
  }
>()("cloudflare-runtime/Runtime") {}

type BindingRequirements<B extends BindingHooks> =
  B extends Array<never>
    ? never
    : B extends Array<BindingHook<infer R>>
      ? R
      : never;

export const RuntimeLive = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const storage = yield* Storage.Storage;
    const docker = yield* Docker.Docker;
    const plugins =
      yield* PluginContext.pickPluginsFromContext<Globals.Globals>();

    const preparePlugins = Effect.fnUntraced(function* (worker: RuntimeWorker) {
      const context = yield* PluginContext.make(
        worker as RuntimeWorker,
        plugins,
      );
      const [bindings, { tails, streamingTails }] = yield* Effect.all(
        [
          Effect.all(worker.bindings as ReadonlyArray<BindingHook<never>>, {
            concurrency: "unbounded",
          }).pipe(Effect.provideService(PluginContext.PluginContext, context)),
          prepareTails(worker, context),
        ],
        { concurrency: "unbounded" },
      );
      return {
        config: yield* context.config,
        context,
        bindings,
        tails,
        streamingTails,
      };
    });

    /**
     * Resolve each (streaming) tail consumer name to a `ServiceDesignator`
     * through the dev registry proxy — the same path service bindings to other
     * local workers take (`Service.local`). The registry proxy's
     * `ExternalService` entrypoint forwards `tail()` batches and
     * `tailStream()` sessions to the consumer's process via the workerd debug
     * port, so consumers may live in other dev processes and may (re)start at
     * any time. Subscriptions must be registered before `context.config` is
     * computed, which is why this runs alongside the binding hooks in
     * `preparePlugins`.
     */
    const prepareTails = Effect.fnUntraced(function* (
      worker: RuntimeWorker,
      context: PluginContext.PluginContext["Service"],
    ) {
      if (!worker.tails?.length && !worker.streamingTails?.length) {
        return { tails: undefined, streamingTails: undefined };
      }
      const proxy = yield* context.get(RegistryProxy.RegistryProxy);
      const subscribeAll = (names: ReadonlyArray<string> | undefined) =>
        names?.length
          ? Effect.forEach([...new Set(names)], (scriptName) =>
              proxy.api.subscribe({ kind: "worker", scriptName }),
            )
          : Effect.succeed(undefined);
      const [tails, streamingTails] = yield* Effect.all(
        [subscribeAll(worker.tails), subscribeAll(worker.streamingTails)],
        { concurrency: "unbounded" },
      );
      return { tails, streamingTails };
    });

    const prepareContainers = Effect.fnUntraced(function* (
      worker: RuntimeWorker,
    ) {
      const containers = (worker.durableObjectNamespaces ?? []).flatMap(
        (namespace) => {
          if (!namespace.container) return [];
          return {
            className: namespace.className,
            container: namespace.container,
          };
        },
      );
      if (!containers.length) {
        return { imageNames: new Map() };
      }
      // Local development with containers relies on pulling/building `linux/amd64`
      // images, which the Docker daemon on Windows cannot do (it runs Windows
      // containers). Upstream workers-sdk bails out on Windows for the same
      // reason, directing users to WSL.
      if (process.platform === "win32") {
        return yield* new SystemError({
          subtag: "ContainersUnsupportedOnWindows",
          message:
            "Local development with containers is not supported on Windows.",
          hint: "Use WSL to develop the container part of your application, or remove the container configuration if you do not need it.",
        });
      }
      const imageNames = new Map<string, string>();

      const registerImage = (
        className: string,
        tag: string,
        env?: Record<string, string>,
      ) => {
        if (env) {
          // To prevent collisions between images with the same tag but different env,
          // `registerImageEnv` returns a unique alias for the image, which our Docker
          // proxy server then maps to the actual tag and injects the env variables.
          return docker
            .registerImageEnv(className, tag, env)
            .pipe(
              Effect.andThen((alias) =>
                Effect.sync(() => imageNames.set(className, alias)),
              ),
            );
        }
        return Effect.sync(() => imageNames.set(className, tag));
      };

      const [, containerEngine] = yield* Effect.forEach(
        containers,
        ({ className, container }) => {
          if ("tag" in container) {
            return docker
              .validate(container.tag)
              .pipe(
                Effect.andThen(
                  registerImage(className, container.tag, container.env),
                ),
              );
          }
          const tag = docker.generateImageTag(className);
          const prepare =
            "imageUri" in container
              ? docker.pull(tag, container)
              : docker.build(tag, container);
          return prepare.pipe(
            Effect.andThen(docker.validate(tag)),
            Effect.tap(() => {
              // Each start cleans up ONLY its own image tag when its scope
              // closes. Do NOT prune other same-name tags as "stale" here: a
              // dev session starts the worker more than once (precreate stub
              // → reconcile), and a cleanup that guesses which sibling tags
              // are dead can untag the tag a live workerd is about to
              // `docker create` from — every container start then fails and
              // the session serves 500s until redeploy.
              return Effect.addFinalizer(() =>
                docker
                  .removeContainer(tag)
                  .pipe(
                    Effect.andThen(docker.removeImageTag(tag)),
                    Effect.ignore,
                  ),
              );
            }),
            Effect.tap(() => registerImage(className, tag, container.env)),
          );
        },
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.zip(docker.getWorkerdDockerConfiguration, { concurrent: true }),
      );
      return { imageNames, containerEngine };
    });

    return Runtime.of({
      start: Effect.fn(function* (worker) {
        const [
          { config, context, bindings, tails, streamingTails },
          { containerEngine, imageNames },
        ] = yield* Effect.all(
          [preparePlugins(worker), prepareContainers(worker)],
          {
            concurrency: "unbounded",
          },
        );
        const ports = yield* workerd.serve(
          {
            sockets: [
              {
                name: SOCKET_USER_ENTRY,
                address: "127.0.0.1:0",
                service: { name: config.entry ?? SERVICE_USER_WORKER },
              },
              ...config.sockets,
            ],
            services: [
              {
                name: SERVICE_USER_WORKER,
                worker: {
                  compatibilityDate: worker.compatibilityDate,
                  compatibilityFlags: worker.compatibilityFlags,
                  bindings,
                  modules: worker.modules.map(moduleToWorkerd),
                  durableObjectNamespaces: worker.durableObjectNamespaces?.map(
                    (namespace) => {
                      const imageName = imageNames.get(namespace.className);
                      return {
                        className: namespace.className,
                        enableSql: namespace.sql,
                        uniqueKey:
                          namespace.uniqueKey ??
                          defaultDurableObjectUniqueKey(
                            worker.name,
                            namespace.className,
                          ),
                        ephemeralLocal: namespace.ephemeralLocal,
                        container: imageName ? { imageName } : undefined,
                      };
                    },
                  ),
                  durableObjectStorage: {
                    localDisk: storage.name,
                  },
                  containerEngine,
                  tails,
                  streamingTails,
                  ...config.userWorker,
                  ...worker.unsafe,
                },
              },
              ...config.services,
            ],
            extensions: config.extensions,
          },
          {
            "debug-port": "127.0.0.1:0",
            ...(worker.logging?.verbose ? { verbose: true } : undefined),
          },
          { onOutput: worker.logging?.onOutput },
        );
        yield* context.start(ports);
        return new URL(`http://127.0.0.1:${ports[SOCKET_USER_ENTRY]}`);
      }),
    });
  }),
);
