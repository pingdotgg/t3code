import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Docker from "./Docker.ts";
import type * as Globals from "./globals/Globals.ts";
import * as Storage from "./globals/Storage.ts";
import {
  defaultDurableObjectUniqueKey,
  SERVICE_USER_WORKER,
  SOCKET_USER_ENTRY,
  withDefaultFlags,
} from "./internal/constants.ts";
import { moduleToWorkerd } from "./internal/internal-modules.ts";
import type { BindingHook } from "./PluginContext.ts";
import * as PluginContext from "./PluginContext.ts";
import * as RegistryProxy from "./registry/RegistryProxy.ts";
import { type RuntimeError, SystemError } from "./RuntimeError.shared.ts";
import type { BindingHooks, RuntimeWorker } from "./RuntimeWorker.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
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
  B extends Array<never> ? never : B extends Array<BindingHook<infer R>> ? R : never;

export const RuntimeLive = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const storage = yield* Storage.Storage;
    const docker = yield* Docker.Docker;
    const plugins = yield* PluginContext.pickPluginsFromContext<Globals.Globals>();

    const preparePlugins = Effect.fnUntraced(function* (worker: RuntimeWorker) {
      const context = yield* PluginContext.make(worker as RuntimeWorker, plugins);
      const [bindings, { tails, streamingTails }] = yield* Effect.all(
        [
          Effect.all(worker.bindings as ReadonlyArray<BindingHook<never>>, {
            concurrency: "unbounded",
          }).pipe(Effect.provideService(PluginContext.PluginContext, context)),
          prepareTails(worker, context),
        ],
        { concurrency: "unbounded" },
      );
      return { config: yield* context.config, context, bindings, tails, streamingTails };
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
          : Effect.undefined;
      const [tails, streamingTails] = yield* Effect.all(
        [subscribeAll(worker.tails), subscribeAll(worker.streamingTails)],
        { concurrency: "unbounded" },
      );
      return { tails, streamingTails };
    });

    const prepareContainers = Effect.fnUntraced(function* (worker: RuntimeWorker) {
      const containers = (worker.durableObjectNamespaces ?? []).flatMap((namespace) => {
        if (!namespace.container) return [];
        return { className: namespace.className, container: namespace.container };
      });
      if (!containers.length) {
        return { containerOptions: new Map() };
      }
      // Local development with containers relies on pulling/building `linux/amd64`
      // images, which the Docker daemon on Windows cannot do (it runs Windows
      // containers). Upstream workers-sdk bails out on Windows for the same
      // reason, directing users to WSL.
      if (process.platform === "win32") {
        return yield* SystemError.make({
          subtag: "ContainersUnsupportedOnWindows",
          message: "Local development with containers is not supported on Windows.",
          hint: "Use WSL to develop the container part of your application, or remove the container configuration if you do not need it.",
        });
      }
      // workerd container options per Durable Object class name.
      const containerOptions = new Map<
        string,
        WorkerdConfig.Worker_DurableObjectNamespace_ContainerOptions
      >();

      /**
       * Make an image available to Docker and return the name workerd should
       * use for it. Images with env get a unique alias, which the Docker proxy
       * maps back to the real tag while injecting the env.
       */
      const prepareImage = Effect.fnUntraced(function* (
        className: string,
        image: Docker.ContainerImage,
      ) {
        let tag: string;
        if ("tag" in image) {
          tag = image.tag;
        } else {
          tag = docker.generateImageTag(className);
          if ("imageUri" in image) {
            yield* docker.pull(tag, image);
          } else {
            yield* docker.build(tag, image);
          }
          // Each start cleans up ONLY its own image tag when its scope
          // closes. Do NOT prune other same-name tags as "stale" here: a
          // dev session starts the worker more than once (precreate stub
          // → reconcile), and a cleanup that guesses which sibling tags
          // are dead can untag the tag a live workerd is about to
          // `docker create` from — every container start then fails and
          // the session serves 500s until redeploy.
          yield* Effect.addFinalizer(() =>
            docker
              .removeContainer(tag)
              .pipe(Effect.andThen(docker.removeImageTag(tag)), Effect.ignore),
          );
        }
        yield* docker.validate(tag);
        if (image.env) {
          return yield* docker.registerImageEnv(className, tag, image.env);
        }
        return tag;
      });

      /** A Durable Object-managed container exposes every image by name. */
      const prepareNamedImages = (
        className: string,
        images: Record<string, Docker.ContainerImage>,
      ) =>
        Effect.forEach(
          Object.entries(images),
          Effect.fnUntraced(function* ([name, image]) {
            return { name, image: yield* prepareImage(className, image) };
          }),
          { concurrency: "unbounded" },
        );

      // FUSE privileges are decided once per runtime and
      // resolve alongside the first image build or pull.
      const [, containerEngine] = yield* Effect.forEach(
        containers,
        Effect.fnUntraced(function* ({ className, container }) {
          if ("images" in container) {
            const [images, privileges] = yield* Effect.zip(
              prepareNamedImages(className, container.images),
              docker.getContainerPrivileges,
              { concurrent: true },
            );
            containerOptions.set(className, { images, privileges });
          } else {
            const [imageName, privileges] = yield* Effect.zip(
              prepareImage(className, container),
              docker.getContainerPrivileges,
              { concurrent: true },
            );
            containerOptions.set(className, { imageName, privileges });
          }
        }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.zip(docker.getWorkerdDockerConfiguration, { concurrent: true }));
      return { containerOptions, containerEngine };
    });

    return Runtime.of({
      start: Effect.fn(function* (worker) {
        worker = {
          ...worker,
          compatibilityFlags: withDefaultFlags(worker.compatibilityFlags, {
            date: worker.compatibilityDate,
          }),
        };
        const [
          { config, context, bindings, tails, streamingTails },
          { containerEngine, containerOptions },
        ] = yield* Effect.all([preparePlugins(worker), prepareContainers(worker)], {
          concurrency: "unbounded",
        });
        // Everything slow (image builds/pulls) is done; let the caller retire
        // whatever must be gone before this workerd boots.
        if (worker.beforeServe) yield* worker.beforeServe;
        const sockets: Array<WorkerdConfig.Socket> = [
          {
            name: SOCKET_USER_ENTRY,
            address: "127.0.0.1:0",
            service: { name: config.entry ?? SERVICE_USER_WORKER },
          },
          ...config.sockets,
        ];
        const exits = yield* Queue.unbounded<Workerd.WorkerdExit>();
        /**
         * Serves the Worker. `pinned` reuses the ports of a previous process,
         * so a replacement is reachable through the same URL, proxy target
         * and registry entry as the process it replaces.
         */
        const serveWorker = (pinned?: Workerd.WorkerdPorts) =>
          workerd.serve(
            {
              sockets: pinned ? sockets.map(pinSocket(pinned)) : sockets,
              services: [
                {
                  name: SERVICE_USER_WORKER,
                  worker: {
                    compatibilityDate: worker.compatibilityDate,
                    compatibilityFlags: worker.compatibilityFlags,
                    bindings,
                    modules: worker.modules.map(moduleToWorkerd),
                    durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => {
                      const container = containerOptions.get(namespace.className);
                      return {
                        className: namespace.className,
                        enableSql: namespace.sql,
                        uniqueKey:
                          namespace.uniqueKey ??
                          defaultDurableObjectUniqueKey(worker.name, namespace.className),
                        ephemeralLocal: namespace.ephemeralLocal,
                        container,
                      };
                    }),
                    durableObjectStorage: { localDisk: storage.name },
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
              v8Flags: worker.workerd?.v8Flags,
            },
            {
              "debug-port": `127.0.0.1:${pinned?.[SOCKET_DEBUG_PORT] ?? 0}`,
              ...(worker.logging?.verbose ? { verbose: true } : undefined),
            },
            {
              bin: worker.workerd?.path,
              env: worker.workerd?.env,
              onOutput: worker.logging?.onOutput,
              onExit: (exit) => {
                Queue.offerUnsafe(exits, exit);
              },
            },
          );
        const parentScope = yield* Effect.scope;
        let processScope = yield* Scope.fork(parentScope);
        const startProcess = (pinned?: Workerd.WorkerdPorts) =>
          serveWorker(pinned).pipe(
            Effect.tap((ports) => context.start(ports)),
            Scope.provide(processScope),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(processScope, exit) : Effect.void,
            ),
          );
        const ports = yield* startProcess();
        // A process that dies after startup (V8 aborting on heap exhaustion
        // is the common case) is replaced on the same ports. Without this
        // every request fails until the whole dev session is restarted.
        yield* Effect.gen(function* () {
          let restartTimes: Array<number> = [];
          while (true) {
            const exit = yield* Queue.take(exits);
            // Release the old process, output listeners and plugin tasks before
            // starting another generation. Closing also detaches this child
            // scope from the parent, so repeated crashes do not retain it.
            yield* Scope.close(processScope, Exit.void);
            const now = yield* Clock.currentTimeMillis;
            restartTimes = restartTimes.filter((time) => now - time < 60_000);
            if (restartTimes.length >= 3) {
              yield* Effect.logError(
                `The Workers runtime for "${worker.name}" stopped after 3 restarts within 60 seconds. Fix the crash and restart the dev session.`,
              );
              return;
            }
            restartTimes.push(now);
            yield* Effect.sleep(250 * 2 ** (restartTimes.length - 1));
            yield* Effect.logWarning(
              `The Workers runtime for "${worker.name}" exited unexpectedly (exit code ${exit.exitCode}, signal ${exit.signal}); starting a replacement on the same ports.${exit.stderr ? `\n${exit.stderr}` : ""}`,
            );
            processScope = yield* Scope.fork(parentScope);
            const restarted = yield* startProcess(ports).pipe(Effect.result);
            if (Result.isFailure(restarted)) {
              yield* Effect.logError(
                `The Workers runtime for "${worker.name}" could not be restarted: ${restarted.failure.message}`,
              );
              return;
            }
            worker.onRestart?.(exit);
          }
        }).pipe(Effect.forkScoped);
        return new URL(`http://127.0.0.1:${ports[SOCKET_USER_ENTRY]}`);
      }),
    });
  }),
);

const SOCKET_DEBUG_PORT = "debug-port";

const pinSocket =
  (ports: Workerd.WorkerdPorts) =>
  (socket: WorkerdConfig.Socket): WorkerdConfig.Socket => {
    const port = socket.name === undefined ? undefined : ports[socket.name];
    return port === undefined ? socket : { ...socket, address: `127.0.0.1:${port}` };
  };
