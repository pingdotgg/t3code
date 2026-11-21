import { createPluginRegistry } from "@t3tools/client-runtime/plugins";
import {
  Component,
  Suspense,
  createContext,
  createElement,
  memo,
  useContext,
  useSyncExternalStore,
  type ComponentType,
  type Context,
  type FunctionComponent,
  type ReactNode,
} from "react";
import { EnvironmentId, type PluginSnapshot, type ScopedThreadRef } from "@t3tools/contracts";

type FeatureComponents = Record<string, ComponentType<never>>;

const retained =
  (import.meta.hot?.data?.pluginState as Map<string, unknown> | undefined) ??
  new Map<string, unknown>();
if (import.meta.hot?.data) import.meta.hot.data.pluginState = retained;

/** Host state and context identities survive module replacement. */
export function pluginSharedState<Value>(key: string, initialize: () => Value): Value {
  if (!retained.has(key)) retained.set(key, initialize());
  return retained.get(key) as Value;
}

export function createPluginContext<Value>(key: string, initial: Value): Context<Value> {
  return pluginSharedState(`context:${key}`, () => createContext(initial));
}

export const pluginFeatures = pluginSharedState("features", () =>
  createPluginRegistry<FeatureComponents>(),
);
const slotSubscribers = new Map<string, (listener: () => void) => () => void>();
/** One subscribe function per slot, so useSyncExternalStore never resubscribes on render. */
function featureSlotSubscriber(slot: string) {
  let subscribe = slotSubscribers.get(slot);
  if (!subscribe) {
    // A registry retained by an earlier hot module still exposes the global subscription.
    subscribe = (listener) =>
      pluginFeatures.subscribeSlot?.(slot, listener) ?? pluginFeatures.subscribe(listener);
    slotSubscribers.set(slot, subscribe);
  }
  return subscribe;
}
export const PluginEnvironmentContext = createPluginContext<EnvironmentId | null>(
  "environment",
  null,
);
export const PluginRecoveryContext = createPluginContext("recovery", false);

const builtinFeatures = pluginSharedState(
  "builtin-features",
  () => new Map<string, ComponentType<never>>(),
);
const builtinFeatureListeners = pluginSharedState(
  "builtin-feature-listeners",
  () => new Map<string, Set<() => void>>(),
);
const builtinActivationOwners = pluginSharedState(
  "builtin-activation-owners",
  () => new Map<string, string>(),
);
const builtinRenderers = pluginSharedState(
  "builtin-renderers",
  () => new Map<string, ComponentType<never>>(),
);
const slotSnapshots = pluginSharedState(
  "slot-snapshots",
  () => new Map<string, ReturnType<typeof pluginFeatures.entries>>(),
);
const builtinEnabled = pluginSharedState(
  "builtin-enabled",
  () => new Map<EnvironmentId, ReadonlyMap<string, boolean>>(),
);
const enabledListeners = pluginSharedState("enabled-listeners", () => new Set<() => void>());
const enabledState = pluginSharedState("enabled-state", () => ({ revision: 0 }));
const builtinOwners = pluginSharedState("builtin-owners", () => new Map<string, string>());
const subscribeBuiltinEnabled = (listener: () => void) => {
  enabledListeners.add(listener);
  return () => {
    enabledListeners.delete(listener);
  };
};

export function reconcileBuiltinPlugins(environmentId: EnvironmentId, snapshot: PluginSnapshot) {
  const previous = builtinEnabled.get(environmentId);
  const next = new Map(
    snapshot.plugins
      .filter((plugin) => plugin.source === "builtin")
      .map((plugin) => [plugin.manifest.id, plugin.enabled]),
  );
  if (
    previous?.size === next.size &&
    [...next].every(([id, enabled]) => previous.get(id) === enabled)
  )
    return;
  builtinEnabled.set(environmentId, next);
  enabledState.revision += 1;
  for (const listener of enabledListeners) listener();
}

export function useBuiltinPluginRevision() {
  return useSyncExternalStore(
    subscribeBuiltinEnabled,
    () => enabledState.revision,
    () => 0,
  );
}

export function isBuiltinPluginEnabled(environmentId: EnvironmentId | null, id: string) {
  return environmentId === null || builtinEnabled.get(environmentId)?.get(id) !== false;
}

export function builtinPluginDefinitions() {
  const definitions = new Map<string, string[]>();
  for (const slot of builtinFeatures.keys()) {
    const id = builtinPluginId(slot);
    const slots = definitions.get(id) ?? [];
    slots.push(slot);
    definitions.set(id, slots);
  }
  return [...definitions].map(([id, slots]) => ({ id, slots }));
}

function slotSnapshot(slot: string) {
  const next = pluginFeatures.entries(slot);
  const previous = slotSnapshots.get(slot);
  if (previous === next) return next;
  if (previous?.length === next.length && next.every((entry, index) => entry === previous[index])) {
    return previous;
  }
  slotSnapshots.set(slot, next);
  return next;
}

export function builtinPluginId(slot: string): string {
  const cached = builtinOwners.get(slot);
  if (cached !== undefined) return cached;
  const id = classifyBuiltinPluginId(slot);
  builtinOwners.set(slot, id);
  return id;
}

function classifyBuiltinPluginId(slot: string): string {
  if (
    slot.startsWith("component:components/preview/PreviewPanelShell/") ||
    slot.startsWith("component:components/preview/RightPanelResizeHandle/") ||
    slot.startsWith("component:components/preview/ZoomIndicator/") ||
    slot === "component:components/preview/ThreadPreviewMiniPlayer/ThreadPreviewMiniPlayer" ||
    slot === "component:components/preview/ThreadPreviewMiniPlayer/MiniPlayerShell"
  )
    return "t3.ui";
  if (slot.startsWith("canvas.") || slot.startsWith("component:components/canvas/"))
    return "t3.canvas";
  if (slot.startsWith("route:/settings")) return "t3.settings";
  if (slot.startsWith("route:/_chat")) return "t3.chat";
  if (slot.startsWith("route:/usage")) return "t3.usage";
  if (slot.startsWith("component:components/settings/")) return "t3.settings";
  if (slot.startsWith("component:components/chat/")) return "t3.thread";
  if (slot.startsWith("component:components/preview/") || slot.startsWith("component:browser/"))
    return "t3.preview";
  if (slot.startsWith("component:components/pullRequest/")) return "t3.pull-requests";
  if (slot.startsWith("component:components/sidebar/")) return "t3.sidebar";
  if (slot.startsWith("component:components/files/")) return "t3.file-preview";
  if (slot.startsWith("component:components/diffs/")) return "t3.diff";
  if (slot.startsWith("sidebar.")) return "t3.sidebar";
  if (slot === "settings.connections") return "t3.connections";
  if (slot.startsWith("settings.")) return "t3.settings";
  if (slot.startsWith("pull-request")) return "t3.pull-requests";
  if (slot.startsWith("preview")) return "t3.preview";
  if (slot.startsWith("chat.")) return "t3.thread";
  if (slot.startsWith("markdown.")) return "t3.markdown";
  if (slot.startsWith("diff.")) return "t3.diff";
  if (["chat", "markdown", "diff", "file-preview", "usage"].includes(slot)) return `t3.${slot}`;
  return "t3.ui";
}

/** Feature modules keep recovery renderers, but their SDK activation owns contributions. */
export function declareBuiltinFeatures(pluginId: string, slots: readonly string[]) {
  for (const slot of slots) {
    const previousOwner = builtinPluginId(slot);
    builtinActivationOwners.set(slot, pluginId);
    builtinOwners.set(slot, pluginId);
    pluginFeatures.unregister(`${previousOwner}/${slot}`);
  }
}

/** Components keep their original props; erasure is confined to the dynamic registry. */
function registerBuiltinFeature<Props extends object>(
  slot: string,
  builtin: ComponentType<Props>,
): void {
  const previous = builtinFeatures.get(slot);
  builtinFeatures.set(slot, builtin as ComponentType<never>);
  if (!builtinActivationOwners.has(slot)) {
    const pluginId = builtinPluginId(slot);
    // Compatibility components still own independent registrations within their feature.
    pluginFeatures.register(`${pluginId}/${slot}`, [
      { slot, id: "default", order: -1000, load: () => builtin as ComponentType<never> },
    ]);
  }
  if (previous !== builtin) {
    for (const listener of builtinFeatureListeners.get(slot) ?? []) listener();
    // Cached originals from earlier hot modules still subscribe through the registry.
    if (import.meta.hot && builtinActivationOwners.has(slot)) pluginFeatures.notifySlot?.(slot);
  }
}

function getBuiltinFeature<Props extends object>(slot: string): ComponentType<Props> | undefined {
  return builtinFeatures.get(slot) as ComponentType<Props> | undefined;
}

/** A deferred original renderer also works before its route or panel chunk is loaded. */
export function builtinRenderer<Props extends object>(slot: string): ComponentType<Props> {
  let renderer = builtinRenderers.get(slot);
  if (!renderer) {
    const subscribe = (listener: () => void) => {
      let listeners = builtinFeatureListeners.get(slot);
      if (!listeners) {
        listeners = new Set();
        builtinFeatureListeners.set(slot, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    function Original(props: Props) {
      const builtin = useSyncExternalStore(
        subscribe,
        () => getBuiltinFeature<Props>(slot),
        () => getBuiltinFeature<Props>(slot),
      );
      return builtin ? createElement(builtin, props) : null;
    }
    renderer = Original as ComponentType<never>;
    builtinRenderers.set(slot, renderer);
  }
  return renderer as ComponentType<Props>;
}

class FeatureErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; target: ComponentType<never> },
  { failed: boolean; target: ComponentType<never> | null }
> {
  override state = { failed: false, target: null };

  static getDerivedStateFromProps(
    props: { target: ComponentType<never> },
    state: { target: ComponentType<never> | null },
  ) {
    return props.target === state.target ? null : { target: props.target, failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function PluginSlot<Props extends object>({
  slot,
  props,
  fallback,
}: {
  slot: string;
  props: Props;
  fallback?: ComponentType<Props>;
}) {
  const inheritedEnvironmentId = useContext(PluginEnvironmentContext);
  const recovery = useContext(PluginRecoveryContext);
  const explicitEnvironmentId =
    "environmentId" in props && typeof props.environmentId === "string"
      ? props.environmentId
      : "threadRef" in props &&
          typeof props.threadRef === "object" &&
          props.threadRef !== null &&
          "environmentId" in props.threadRef &&
          typeof props.threadRef.environmentId === "string"
        ? props.threadRef.environmentId
        : null;
  const environmentId = explicitEnvironmentId
    ? EnvironmentId.make(explicitEnvironmentId)
    : inheritedEnvironmentId;
  const contributions = useSyncExternalStore(
    featureSlotSubscriber(slot),
    () => slotSnapshot(slot),
    () => slotSnapshot(slot),
  );
  const enabled = useSyncExternalStore(
    subscribeBuiltinEnabled,
    () =>
      environmentId === null ||
      builtinEnabled.get(environmentId)?.get(builtinPluginId(slot)) !== false,
    () => true,
  );
  const builtin = enabled || recovery ? (fallback ?? getBuiltinFeature<Props>(slot)) : undefined;
  if (recovery) return builtin ? createElement(builtin, props) : null;
  const entries = contributions.filter((entry) =>
    entry.pluginId.includes(":") ? entry.pluginId.startsWith(`${environmentId}:`) : enabled,
  );
  const defaultEntry = entries.findLast((entry) => entry.id === "default");
  const resolved = defaultEntry?.load() as ComponentType<Props> | undefined;
  // Activation must not remount a conversation that already rendered during fast boot.
  const ownsBuiltin =
    builtinActivationOwners.has(slot) &&
    defaultEntry?.pluginId.startsWith(`${environmentId}:${builtinPluginId(slot)}#`);
  const Default = ownsBuiltin ? (builtin ?? resolved) : (resolved ?? builtin);
  const additions = entries.filter((entry) => entry.id !== "default");
  const fallbackNode = builtin ? createElement(builtin, props) : null;
  // The boundary and Suspense fall back to the builtin, so they only isolate a replacement.
  const defaultNode = !Default ? null : Default === builtin ? (
    createElement(builtin, { ...props, key: "default" })
  ) : (
    <Suspense key="default" fallback={fallbackNode}>
      <FeatureErrorBoundary
        key={slot}
        fallback={fallbackNode}
        target={Default as ComponentType<never>}
      >
        {createElement(Default, props)}
      </FeatureErrorBoundary>
    </Suspense>
  );
  const renderAddition = (entry: (typeof additions)[number]) => {
    const Feature = entry.load() as ComponentType<Props>;
    return (
      <Suspense key={`${entry.pluginId}:${entry.id}`} fallback={null}>
        <FeatureErrorBoundary fallback={null} target={Feature as ComponentType<never>}>
          {createElement(Feature, props)}
        </FeatureErrorBoundary>
      </Suspense>
    );
  };
  // The keyed default survives additions appearing around it without remounting.
  const content =
    additions.length === 0 ? (
      defaultNode
    ) : (
      <>
        {additions.filter((entry) => entry.order < 0).map(renderAddition)}
        {defaultNode}
        {additions.filter((entry) => entry.order >= 0).map(renderAddition)}
      </>
    );
  return environmentId === inheritedEnvironmentId ? (
    content
  ) : (
    <PluginEnvironmentContext value={environmentId}>{content}</PluginEnvironmentContext>
  );
}

/** Keeps generic call signatures, React 19 refs and component statics at the module boundary. */
export function definePluginComponent<Value>(
  slot: string,
  builtin: Value,
): Value & { displayName?: string } {
  const component = builtin as ComponentType<Record<string, unknown>>;
  registerBuiltinFeature(slot, component);
  function Feature(props: Record<string, unknown>) {
    return <PluginSlot slot={slot} props={props} fallback={component} />;
  }
  const isMemo =
    typeof builtin === "object" &&
    builtin !== null &&
    "$$typeof" in builtin &&
    builtin.$$typeof === Symbol.for("react.memo");
  const compare =
    isMemo && "compare" in builtin && typeof builtin.compare === "function"
      ? (builtin.compare as (
          previous: Record<string, unknown>,
          next: Record<string, unknown>,
        ) => boolean)
      : undefined;
  const prototype: unknown =
    typeof builtin === "function" ? Reflect.get(builtin, "prototype") : undefined;
  const isClass =
    typeof prototype === "object" && prototype !== null && "isReactComponent" in prototype;
  const wrapped = isMemo || isClass ? memo(Feature, compare) : Feature;
  for (const key of Reflect.ownKeys(Object(builtin))) {
    if (
      typeof key === "string" &&
      [
        "$$typeof",
        "type",
        "compare",
        "render",
        "_payload",
        "_init",
        "name",
        "length",
        "prototype",
        "caller",
        "arguments",
        "displayName",
      ].includes(key)
    )
      continue;
    Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(Object(builtin), key)!);
  }
  Object.assign(wrapped, { displayName: `PluginComponent(${slot})` });
  return wrapped as Value & { displayName?: string };
}

/** Builtin features and local modules contribute through the same registry. */
export function definePluginFeature<Props extends object>(
  slot: string,
  builtin: ComponentType<Props>,
): FunctionComponent<Props> {
  return definePluginComponent(slot, builtin) as FunctionComponent<Props>;
}

const EmptyBanner = () => null;
pluginSharedState("shared-preview-feature-owners", () => {
  // Existing hot-reload registries must move these shared components to their new owner too.
  for (const [slot, builtin] of builtinFeatures) {
    const owner = builtinOwners.get(slot);
    if (
      owner === undefined ||
      builtinActivationOwners.has(slot) ||
      owner === classifyBuiltinPluginId(slot)
    )
      continue;
    pluginFeatures.unregister(`${owner}/${slot}`);
    builtinOwners.delete(slot);
    registerBuiltinFeature(slot, builtin);
  }
  return true;
});
registerBuiltinFeature("app.banner", EmptyBanner);
registerBuiltinFeature("chat.banner", EmptyBanner);
registerBuiltinFeature("chat.composer.banners", EmptyBanner);

export function PluginBanner({
  slot = "app.banner",
  threadRef,
}: {
  slot?: string;
  threadRef?: ScopedThreadRef | null;
}) {
  return <PluginSlot slot={slot} props={{ threadRef }} />;
}
