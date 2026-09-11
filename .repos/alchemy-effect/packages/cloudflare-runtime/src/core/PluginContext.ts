import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { SERVICE_USER_WORKER } from "./internal/constants.ts";
import type * as Plugin from "./Plugin.ts";
import type { RuntimeError } from "./RuntimeError.shared.ts";
import { ConfigError } from "./RuntimeError.shared.ts";
import type { RuntimeWorker } from "./RuntimeWorker.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
import type * as Workerd from "./workerd/Workerd.ts";

export class PluginContext extends Context.Service<
  PluginContext,
  {
    readonly worker: RuntimeWorker;
    readonly plugins: ReadonlyMap<
      string,
      | Plugin.Plugin<any>
      | Effect.Effect<Plugin.Plugin<any>, never, PluginContext>
    >;
    readonly get: <Self, Identifier extends Plugin.PluginIdentifier, Api>(
      service: Plugin.PluginService<Self, Identifier, Api>,
    ) => Effect.Effect<Plugin.Plugin<Api>, ConfigError>;
    readonly start: (
      ports: Workerd.WorkerdPorts,
    ) => Effect.Effect<void, RuntimeError, Scope.Scope>;
    readonly config: Effect.Effect<
      {
        entry: string | undefined;
        sockets: Array<WorkerdConfig.Socket>;
        services: Array<WorkerdConfig.Service>;
        extensions: Array<WorkerdConfig.Extension>;
        userWorker: Partial<WorkerdConfig.Worker>;
      },
      RuntimeError
    >;
  }
>()("cloudflare-runtime/PluginContext") {}

export type ConfigHook<A, E, R> = Effect.Effect<
  A,
  E | ConfigError,
  R | PluginContext
>;
export type BindingHook<R = never> = ConfigHook<
  WorkerdConfig.Worker_Binding,
  never,
  R
>;

export const make = (
  worker: RuntimeWorker,
  inheritedPlugins?: PluginMap,
): Effect.Effect<PluginContext["Service"], RuntimeError> =>
  Effect.gen(function* () {
    const plugins = new Map<string, Plugin.Plugin<any>>();
    const context = PluginContext.of({
      worker,
      plugins,
      config: Effect.gen(function* () {
        const configs = yield* Effect.forEach(
          plugins.values(),
          (plugin) =>
            Effect.isEffect(plugin.defer)
              ? plugin.defer.pipe(
                  Effect.map((config) => ({ ...plugin, ...config })),
                  Effect.provideService(PluginContext, context),
                )
              : Effect.succeed(plugin),
          { concurrency: "unbounded" },
        );
        const services = configs.flatMap((config) => config.services ?? []);
        const sockets = configs.flatMap((config) => config.sockets ?? []);
        const extensions = configs.flatMap((config) => config.extensions ?? []);
        const userWorker = Object.assign(
          {},
          ...configs.map((config) => config.userWorker ?? {}),
        );
        const middlewares = configs
          .flatMap((config) => config.middlewares ?? [])
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return {
          entry: middlewares[0]?.name,
          sockets,
          extensions,
          userWorker,
          services: [
            ...services,
            ...middlewares.map((middleware, index) => ({
              name: middleware.name,
              worker: {
                ...middleware.worker,
                bindings: [
                  ...(middleware.worker.bindings ?? []),
                  {
                    name: middleware.upstreamBindingName,
                    service: {
                      name:
                        index < middlewares.length - 1
                          ? middlewares[index + 1].name
                          : SERVICE_USER_WORKER,
                    },
                  },
                ],
              },
            })),
          ],
        };
      }),
      start: Effect.fn(function* (ports) {
        yield* Effect.forEach(plugins.values(), (plugin) => {
          return plugin.start?.(ports) ?? Effect.void;
        });
      }),
      get: Effect.fn(function* (service) {
        const plugin = plugins.get(service.key);
        if (!plugin) {
          return yield* new ConfigError({
            subtag: "PluginNotFound",
            message: `Plugin "${service.key}" not found`,
            hint: `The plugin "${service.key}" is not registered in the current context.`,
            detail: {
              name: service.key,
            },
          });
        }
        return plugin;
      }),
    });
    const pluginMap: PluginMap = inheritedPlugins ?? new Map();
    const pluginsFromContext = yield* pickPluginsFromContext();
    for (const [key, builder] of pluginsFromContext.entries()) {
      pluginMap.set(key, builder);
    }
    yield* Effect.forEach(pluginMap.entries(), ([key, builder]) =>
      Effect.gen(function* () {
        const plugin = Effect.isEffect(builder)
          ? yield* builder.pipe(Effect.provideService(PluginContext, context))
          : builder;
        plugins.set(key, plugin);
      }),
    );
    return context;
  });

export type PluginMap = Map<
  Plugin.PluginIdentifier<string>,
  Plugin.PluginBuilder<any>
>;

export const pickPluginsFromContext = <R = never>() =>
  Effect.context<R>().pipe(
    Effect.map(
      (context): PluginMap =>
        new Map(context.mapUnsafe.entries().filter(isPlugin)),
    ),
  );

const isPlugin = <Identifier extends string>(
  entry: [string, any],
): entry is [Plugin.PluginIdentifier<Identifier>, Plugin.PluginBuilder<any>] =>
  entry[0].startsWith("cloudflare-runtime/plugin/");

export const use = Effect.fn("PluginContext.use")(
  PluginContext.use.bind(PluginContext),
);
export const useSync = Effect.fn("PluginContext.useSync")(
  PluginContext.useSync.bind(PluginContext),
);
