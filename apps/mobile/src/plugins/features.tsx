import { createPluginRegistry } from "@t3tools/client-runtime/plugins";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  createContext,
  createElement,
  Component,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type ComponentClass,
  type ReactNode,
} from "react";

import { parseActiveThreadPath } from "../features/keyboard/hardwareKeyboardCommands";

export type NativeFeatureComponents = Record<string, ComponentType<never>>;

const stateKey = Symbol.for("t3.native.pluginState");
const stateHost = globalThis as typeof globalThis & { [stateKey]?: Map<string, unknown> };
const sharedState = (stateHost[stateKey] ??= new Map<string, unknown>());

/** Metro refresh replaces builtin implementations while preserving active extension registrations. */
export function nativePluginSharedState<Value>(key: string, initialize: () => Value): Value {
  if (!sharedState.has(key)) sharedState.set(key, initialize());
  return sharedState.get(key) as Value;
}

export const nativePluginFeatures = nativePluginSharedState("features", () =>
  createPluginRegistry<NativeFeatureComponents>(),
);
export const NativePluginEnvironmentContext = nativePluginSharedState("environment-context", () =>
  createContext<string | null>(null),
);
const builtinFeatures = nativePluginSharedState(
  "builtins",
  () => new Map<string, ComponentType<never>>(),
);
const builtinActivationOwners = nativePluginSharedState(
  "builtin-activation-owners",
  () => new Map<string, string>(),
);
const builtinFeatureListeners = nativePluginSharedState(
  "builtin-feature-listeners",
  () => new Map<string, Set<() => void>>(),
);
const builtinRenderers = nativePluginSharedState(
  "builtin-renderers",
  () => new Map<string, ComponentType<never>>(),
);
const builtinEnabled = nativePluginSharedState(
  "enabled",
  () => new Map<string, ReadonlyMap<string, boolean>>(),
);
const enabledListeners = nativePluginSharedState("enabled-listeners", () => new Set<() => void>());
const workspace = nativePluginSharedState("workspace", () => ({
  environmentId: null as EnvironmentId | null,
}));
const workspaceListeners = nativePluginSharedState(
  "workspace-listeners",
  () => new Set<() => void>(),
);

/** Recovery stays independent of contributed components so a broken plugin can be removed. */
class NativePluginBoundary extends Component<
  {
    readonly children: import("react").ReactNode;
    readonly resetKeys?: readonly unknown[];
    readonly renderFallback: () => import("react").ReactNode;
  },
  { readonly failed: boolean; readonly resetKeys?: readonly unknown[] }
> {
  override state = { failed: false, resetKeys: this.props.resetKeys };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: NativePluginBoundary["props"],
    state: NativePluginBoundary["state"],
  ) {
    return props.resetKeys?.some((key, index) => key !== state.resetKeys?.[index])
      ? { failed: false, resetKeys: props.resetKeys }
      : null;
  }
  override render() {
    return this.state.failed ? this.props.renderFallback() : this.props.children;
  }
}

function setWorkspaceEnvironment(environmentId: EnvironmentId | null) {
  if (workspace.environmentId === environmentId) return;
  workspace.environmentId = environmentId;
  for (const listener of workspaceListeners) listener();
}

export function useNativeWorkspaceEnvironment() {
  return useSyncExternalStore(
    (listener) => {
      workspaceListeners.add(listener);
      return () => {
        workspaceListeners.delete(listener);
      };
    },
    () => workspace.environmentId,
    () => null,
  );
}

export function getNativeBuiltinFeature<Props extends object>(slot: string) {
  return builtinFeatures.get(slot) as ComponentType<Props> | undefined;
}

/** Only explicitly compiled features defer their registrations to activation. */
export function declareNativeBuiltinFeatures(pluginId: string, slots: readonly string[]) {
  for (const slot of slots) {
    builtinActivationOwners.set(slot, pluginId);
    nativePluginFeatures.unregister(`builtin/${slot}`);
  }
}

/** Metro keeps the platform implementation; refreshed originals retain their slot renderer. */
export function nativeBuiltinRenderer<Props extends object>(slot: string): ComponentType<Props> {
  let renderer = builtinRenderers.get(slot);
  if (!renderer) {
    function Original(props: Props) {
      const builtin = useSyncExternalStore(
        (listener) => {
          const listeners = builtinFeatureListeners.get(slot) ?? new Set<() => void>();
          listeners.add(listener);
          builtinFeatureListeners.set(slot, listeners);
          return () => {
            listeners.delete(listener);
          };
        },
        () => getNativeBuiltinFeature<Props>(slot),
        () => getNativeBuiltinFeature<Props>(slot),
      );
      return builtin ? createElement(builtin, props) : null;
    }
    renderer = Original as ComponentType<never>;
    builtinRenderers.set(slot, renderer);
  }
  return renderer as ComponentType<Props>;
}

export function setNativeBuiltinEnabled(
  environmentId: string,
  plugins: readonly {
    readonly manifest: { readonly id: string };
    readonly source: string;
    readonly enabled: boolean;
  }[],
) {
  const next = new Map(
    plugins
      .filter((plugin) => plugin.source === "builtin")
      .map((plugin) => [plugin.manifest.id, plugin.enabled]),
  );
  const previous = builtinEnabled.get(environmentId);
  if (previous?.size === next.size && [...next].every(([id, value]) => previous.get(id) === value))
    return;
  builtinEnabled.set(environmentId, next);
  for (const listener of enabledListeners) listener();
}

export function clearNativeBuiltinEnabled(environmentId: string) {
  if (!builtinEnabled.delete(environmentId)) return;
  for (const listener of enabledListeners) listener();
}

export function nativeBuiltinPluginId(slot: string) {
  const activationOwner = builtinActivationOwners.get(slot);
  if (activationOwner) return activationOwner;
  if (slot === "chat" || slot.includes("voice-input")) return "t3.chat";
  if (slot.startsWith("chat.")) return "t3.thread";
  if (slot === "markdown" || slot.includes("markdown")) return "t3.markdown";
  if (slot === "diff" || slot.includes(".diffs.") || slot.includes(".review.")) return "t3.diff";
  if (
    ["file-preview", "file-tree", "attachment-preview"].includes(slot) ||
    slot.includes(".files.")
  )
    return "t3.file-preview";
  if (slot === "usage" || slot.includes(".usage.")) return "t3.usage";
  if (slot.includes("sidebar")) return "t3.sidebar";
  if (slot.startsWith("settings.connections") || slot.includes(".connection."))
    return "t3.connections";
  if (slot === "settings" || slot.startsWith("settings.") || slot.includes(".settings."))
    return "t3.settings";
  if (slot === "device" || slot.includes(".preview.")) return "t3.preview";
  if (slot.includes(".threads.")) return "t3.thread";
  if (slot.includes(".projects.")) return "t3.projects";
  if (slot === "terminal" || slot.includes(".terminal.")) return "t3.terminal";
  if (slot.includes(".cloud.")) return "t3.auth";
  if (
    slot.startsWith("native.app.") ||
    slot.startsWith("native.navigation") ||
    slot.includes(".widgets.")
  )
    return "t3.mobile";
  return "t3.ui";
}

export function nativeBuiltinPluginDefinitions() {
  return [...builtinFeatures.keys()].map((slot) => ({
    slot,
    pluginId: nativeBuiltinPluginId(slot),
  }));
}

function NativeFeature<Props extends object>({
  slot,
  props,
  fallback: Builtin,
}: {
  readonly slot: string;
  readonly props: Props;
  readonly fallback: ComponentType<Props>;
}) {
  const inheritedEnvironmentId = useContext(NativePluginEnvironmentContext);
  const environmentId = resolveFeatureEnvironment(props) ?? inheritedEnvironmentId;
  const enabled = useSyncExternalStore(
    (listener) => {
      enabledListeners.add(listener);
      return () => {
        enabledListeners.delete(listener);
      };
    },
    () =>
      environmentId === null ||
      builtinEnabled.get(environmentId)?.get(nativeBuiltinPluginId(slot)) !== false,
    () => true,
  );
  const workspaceEnvironment =
    "pathname" in props && typeof props.pathname === "string"
      ? (parseActiveThreadPath(props.pathname)?.environmentId ?? null)
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the app layout's active workspace environment to the shared plugin state until unmount
  useEffect(() => {
    if (slot !== "app-layout") return;
    setWorkspaceEnvironment(workspaceEnvironment);
    return () => setWorkspaceEnvironment(null);
  }, [slot, workspaceEnvironment]);
  const contributions = useSyncExternalStore(
    (listener) =>
      nativePluginFeatures.subscribeSlot?.(slot, listener) ??
      nativePluginFeatures.subscribe(listener),
    () => nativePluginFeatures.entries(slot),
    () => nativePluginFeatures.entries(slot),
  );
  const entries = contributions.filter((entry) => {
    if (!entry.pluginId.includes(":")) return enabled;
    if (environmentId === null || !entry.pluginId.startsWith(`${environmentId}:`)) return false;
    const pluginId = entry.pluginId.slice(environmentId.length + 1);
    return builtinEnabled.get(environmentId)?.get(pluginId) !== false;
  });
  const defaultEntry = entries.findLast((entry) => entry.id === "default");
  const ownsBuiltin =
    builtinActivationOwners.has(slot) &&
    defaultEntry?.pluginId === `${environmentId}:${nativeBuiltinPluginId(slot)}`;
  // Activating an original must preserve the already mounted conversation and composer.
  const Default = (
    ownsBuiltin ? Builtin : (defaultEntry?.load() ?? (enabled ? Builtin : null))
  ) as ComponentType<Props> | null;
  const additions = entries.filter((entry) => entry.id !== "default");
  const renderAddition = (entry: (typeof additions)[number]) => {
    const Feature = entry.load() as ComponentType<Props>;
    return (
      <NativePluginBoundary
        key={`${entry.pluginId}:${entry.id}`}
        resetKeys={[Feature]}
        renderFallback={() => null}
      >
        {createElement(Feature, props)}
      </NativePluginBoundary>
    );
  };
  return (
    <NativePluginEnvironmentContext value={environmentId}>
      {additions.filter((entry) => entry.order < 0).map(renderAddition)}
      {Default ? (
        <NativePluginBoundary
          resetKeys={[Default]}
          renderFallback={() => (enabled ? createElement(Builtin, props) : null)}
        >
          {createElement(Default, props)}
        </NativePluginBoundary>
      ) : null}
      {additions.filter((entry) => entry.order >= 0).map(renderAddition)}
    </NativePluginEnvironmentContext>
  );
}

function resolveFeatureEnvironment(props: object): string | null {
  if ("environmentId" in props && typeof props.environmentId === "string")
    return props.environmentId;
  if (
    "threadRef" in props &&
    typeof props.threadRef === "object" &&
    props.threadRef !== null &&
    "environmentId" in props.threadRef &&
    typeof props.threadRef.environmentId === "string"
  )
    return props.threadRef.environmentId;
  if (
    "route" in props &&
    typeof props.route === "object" &&
    props.route !== null &&
    "params" in props.route &&
    typeof props.route.params === "object" &&
    props.route.params !== null &&
    "environmentId" in props.route.params &&
    typeof props.route.params.environmentId === "string"
  )
    return props.route.params.environmentId;
  if ("pathname" in props && typeof props.pathname === "string") {
    return parseActiveThreadPath(props.pathname)?.environmentId ?? null;
  }
  return null;
}

/** Native features retain originals for boot and recovery; compiled features own activation. */
export function defineNativePluginFeature<Feature extends (props: never) => ReactNode>(
  slot: string,
  builtin: Feature,
): Feature & { displayName?: string };
export function defineNativePluginFeature<Props extends object>(
  slot: string,
  builtin: ComponentClass<Props>,
): ComponentType<Props> & { displayName?: string };
export function defineNativePluginFeature(slot: string, builtin: unknown) {
  const builtinComponent = builtin as ComponentType<object>;
  if (typeof builtin === "function" && !builtinComponent.displayName) {
    builtinComponent.displayName = builtin.name.replace(/^Builtin/, "");
  }
  const previous = builtinFeatures.get(slot);
  builtinFeatures.set(slot, builtinComponent as ComponentType<never>);
  if (!builtinActivationOwners.has(slot)) {
    nativePluginFeatures.register(`builtin/${slot}`, [
      { slot, id: "default", order: -1000, load: () => builtinComponent as ComponentType<never> },
    ]);
  }
  if (previous !== builtinComponent) {
    for (const listener of builtinFeatureListeners.get(slot) ?? []) listener();
  }
  function Feature(props: object) {
    return <NativeFeature slot={slot} props={props} fallback={builtinComponent} />;
  }
  Feature.displayName = `NativePluginFeature(${slot})`;
  return Object.assign(Feature, builtinComponent);
}

const EmptyBanner = () => null;
export const NativePluginBanner = defineNativePluginFeature("app.banner", EmptyBanner);
