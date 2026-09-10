import type * as rolldown from "rolldown";
import type * as vite from "vite";
import { isSkippedEnvironment, type BasePluginOptions } from "./options.ts";

export interface PluginInput<A = any> {
  shared?: Omit<rolldown.Plugin<A>, "name">;
  rolldown?: Omit<rolldown.Plugin<A>, "name">;
  vite?: Omit<vite.Plugin<A>, "name">;
}

export interface NullablePluginOutput<A = any> {
  rolldown: (options: BasePluginOptions) => rolldown.Plugin<A> | null;
  vite: (options: BasePluginOptions) => vite.Plugin<A> | null;
}

export interface PluginOutput<A = any> {
  rolldown: (options: BasePluginOptions) => rolldown.Plugin<A>;
  vite: (options: BasePluginOptions) => vite.Plugin<A>;
}

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: BasePluginOptions) => PluginInput<A>,
): PluginOutput<A>;

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: BasePluginOptions) => PluginInput<A> | undefined,
): NullablePluginOutput<A>;

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: BasePluginOptions) => PluginInput<A> | undefined,
): PluginOutput<A> | NullablePluginOutput<A> {
  const name = `distilled-cloudflare:${pluginName}`;
  return {
    rolldown: (options: BasePluginOptions) => {
      const plugin = make(options);
      if (!plugin) return null;
      return {
        name,
        ...plugin.shared,
        ...plugin.rolldown,
      };
    },
    vite: (options: BasePluginOptions) => {
      const plugin = make(options);
      if (!plugin) return null;
      const vitePlugin = {
        name,
        sharedDuringBuild: true,
        ...plugin.shared,
        ...plugin.vite,
      } as vite.Plugin;
      // Scope every per-environment hook (resolveId/load/transform/...) away
      // from the browser `client` environment and any framework-owned
      // Node-side environments listed in `skipEnvironments` (e.g. Astro's
      // `astro` and `prerender` environments).
      const applyToEnvironment = vitePlugin.applyToEnvironment;
      vitePlugin.applyToEnvironment = function (environment) {
        if (isSkippedEnvironment(options, environment.name)) return false;
        return applyToEnvironment
          ? applyToEnvironment.call(this, environment)
          : true;
      };
      // `applyToEnvironment` only gates the per-environment plugin pipeline;
      // `configEnvironment` runs during config resolution for every
      // environment, so skipped environments must be filtered explicitly.
      const configEnvironment = vitePlugin.configEnvironment;
      if (configEnvironment && options.skipEnvironments?.length) {
        const handler =
          typeof configEnvironment === "function"
            ? configEnvironment
            : configEnvironment.handler;
        const wrapped: typeof handler = function (environmentName, ...args) {
          if (options.skipEnvironments?.includes(environmentName)) return;
          return handler.call(this, environmentName, ...args);
        };
        vitePlugin.configEnvironment =
          typeof configEnvironment === "function"
            ? wrapped
            : { ...configEnvironment, handler: wrapped };
      }
      return vitePlugin;
    },
  };
}
