import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ThreadId,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  PluginId,
  PluginManifest,
} from "@t3tools/contracts";

/** Source modules import these exact host instances, including their JSX runtime on web. */
export const PLUGIN_WEB_RUNTIME_KEY = "t3.plugin-runtime.web.v1";

// The source compiler exposes only public React imports; the web host supplies their values.
export const pluginReactExports = [
  "default",
  "Activity",
  "Children",
  "Component",
  "Fragment",
  "Profiler",
  "PureComponent",
  "StrictMode",
  "Suspense",
  "cache",
  "cacheSignal",
  "cloneElement",
  "createContext",
  "createElement",
  "createRef",
  "forwardRef",
  "isValidElement",
  "lazy",
  "memo",
  "startTransition",
  "use",
  "useActionState",
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useEffectEvent",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTransition",
  "version",
] as const;

export const definePlugin = <Plugin>(plugin: Plugin): Plugin => plugin;

export const pluginEffectModules: Readonly<Record<string, object>> = {
  effect: { Context, Effect, Layer, Option, Schema, Scope, Stream },
  "effect/Context": Context,
  "effect/Effect": Effect,
  "effect/Layer": Layer,
  "effect/Option": Option,
  "effect/Schema": Schema,
  "effect/Scope": Scope,
  "effect/Stream": Stream,
  "@t3tools/plugin-sdk": { definePlugin },
  "@t3tools/plugin-sdk/contracts": {
    ThreadId,
    EnvironmentId,
    ProjectId,
    ScopedThreadRef,
    PluginId,
    PluginManifest,
  },
};

/** The compiler needs export names, never another physical copy of the host packages. */
export const pluginModuleExports = (modules: Readonly<Record<string, object>>) =>
  Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, Object.keys(module)]));

export const pluginWebModuleExports = {
  ...pluginModuleExports(pluginEffectModules),
  react: pluginReactExports,
  "react/jsx-runtime": ["Fragment", "jsx", "jsxs"],
  "react/jsx-dev-runtime": ["Fragment", "jsxDEV"],
};

export function installPluginRuntime(key: string, modules: Readonly<Record<string, object>>) {
  const symbol = Symbol.for(key);
  const previous: unknown = Reflect.get(globalThis, symbol);
  Reflect.set(globalThis, symbol, modules);
  return () => {
    if (Reflect.get(globalThis, symbol) !== modules) return;
    if (previous === undefined) Reflect.deleteProperty(globalThis, symbol);
    else Reflect.set(globalThis, symbol, previous);
  };
}
