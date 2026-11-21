import type { ComponentType, FunctionComponent } from "react";
import { builtinPluginId, definePluginComponent } from "./features";
import { pluginContributions, type PluginRouteProps } from "./contributions";

/** The renderer registration travels with the router's split component module. */
export function definePluginRouteRenderer<Props extends object>(
  path: string,
  renderer: string,
  builtin: ComponentType<Props>,
): FunctionComponent<Props> {
  const component = definePluginComponent(`route:${path}/${renderer}`, builtin);
  if (renderer === "component") registerRouteComponent(path, component);
  return component as FunctionComponent<Props>;
}

function registerRouteComponent(path: string, component: unknown) {
  pluginContributions.register(`${builtinPluginId(`route:${path}`)}/route:${path}`, [
    {
      slot: "routes",
      id: path,
      load: () => ({
        id: path,
        title: path,
        component: component as ComponentType<PluginRouteProps>,
      }),
    },
  ]);
}

/** Register and install the file router's real renderers without changing loader contracts. */
export function registerBuiltinRoute<Value>(path: string, value: Value): Value {
  const route = value as unknown as {
    readonly options: Record<string, unknown>;
    readonly update: (options: Record<string, unknown>) => unknown;
  };
  const options = route.options;
  if (options.component) registerRouteComponent(path, options.component);
  return value;
}
