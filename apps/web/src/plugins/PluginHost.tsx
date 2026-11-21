import { useLocation, useParams } from "@tanstack/react-router";
import {
  CLIENT_HOST_SERVICES_PERMISSION,
  EnvironmentId,
  type PluginSnapshot,
  type PluginStatus,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { clientPluginServices } from "@t3tools/client-runtime/plugins/runtime";
import type { PluginServiceContribution } from "@t3tools/shared/pluginKernel";
import * as Effect from "effect/Effect";
import * as React from "react";
import type {
  ClientFeatureContribution as SdkClientFeatureContribution,
  ClientPluginServices,
  WebPluginHost,
} from "@t3tools/plugin-sdk/web";
import type {
  CommandPaletteActionItem,
  CommandPaletteSubmenuItem,
} from "~/components/CommandPalette.logic";
import type { RightPanelSurface } from "~/rightPanelStore";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import {
  builtinRenderer,
  PluginEnvironmentContext,
  pluginFeatures,
  pluginSharedState,
  reconcileBuiltinPlugins,
} from "./features";
import { pluginEnvironment, usePluginSnapshot } from "./state";
import type { BuiltinRendererApi } from "./api";
import { pluginUi, type PluginUiApi } from "./ui";
import { isPluginTrusted, pluginTrustOrigin, subscribePluginTrust } from "./trust";
import { openPluginPanel, pluginPanels, type PluginPanelDescription } from "./panels";
import { builtinClientPlugins } from "./builtin";
import { installWebPluginModules } from "./modules";
import { pluginContributions, pluginRoutePath } from "./contributions";

export type ClientFeatureContribution<Props extends object = Record<string, unknown>> =
  SdkClientFeatureContribution<Props>;
export type ClientPluginServiceApi = ClientPluginServices;
export type ClientPluginSdk = Omit<
  WebPluginHost<
    PluginUiApi,
    RightPanelSurface,
    CommandPaletteActionItem | CommandPaletteSubmenuItem
  >,
  "builtin"
> & { readonly builtin: BuiltinRendererApi };

export interface ClientPluginStatus {
  readonly state: "awaiting-trust" | "loading" | "active" | "error";
  readonly revision: number;
  readonly error?: string;
}

const clientStatuses = pluginSharedState("client-statuses", () => ({
  snapshot: new Map<string, ClientPluginStatus>() as ReadonlyMap<string, ClientPluginStatus>,
  listeners: new Set<() => void>(),
  nextGeneration: 0,
}));

function reportClientStatus(key: string, status: ClientPluginStatus | null) {
  const previous = clientStatuses.snapshot.get(key);
  if (
    previous?.state === status?.state &&
    previous?.revision === status?.revision &&
    previous?.error === status?.error
  )
    return;
  const next = new Map(clientStatuses.snapshot);
  if (status === null) next.delete(key);
  else next.set(key, status);
  clientStatuses.snapshot = next;
  for (const listener of clientStatuses.listeners) listener();
}

function subscribeClientStatuses(listener: () => void) {
  clientStatuses.listeners.add(listener);
  return () => {
    clientStatuses.listeners.delete(listener);
  };
}

export function usePluginClientStatuses(environmentId: EnvironmentId | null) {
  const snapshot = React.useSyncExternalStore(
    subscribeClientStatuses,
    () => clientStatuses.snapshot,
    () => clientStatuses.snapshot,
  );
  return new Map(
    [...snapshot]
      .filter(([key]) => key.startsWith(`${environmentId}:`))
      .map(([key, value]) => [key.slice(String(environmentId).length + 1), value]),
  );
}

type ActiveGeneration = { dispose: () => void; revision: number };

function isFeatureComponent(value: unknown): value is React.ComponentType<never> {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object" || !("$$typeof" in value)) return false;
  return (
    value.$$typeof === Symbol.for("react.memo") ||
    value.$$typeof === Symbol.for("react.forward_ref") ||
    value.$$typeof === Symbol.for("react.lazy")
  );
}

/** Validates and stages a generation before replacing a working plugin's contributions. */
export function createClientPluginRuntime(environmentId: EnvironmentId, httpBaseUrl: string) {
  installWebPluginModules();
  const active = new Map<string, ActiveGeneration>();
  const pending = new Map<string, () => void>();
  const requested = new Map<string, number>();
  const waiting = new Set<string>();
  const serviceEnabled = new Map<string, boolean>();
  let reconciliation = Promise.resolve();
  let lifecycle = 0;
  let disposed = false;
  let latestSnapshot: PluginSnapshot | null = null;

  const unload = (id: string) => {
    waiting.delete(id);
    pending.get(id)?.();
    pending.delete(id);
    const generation = active.get(id);
    active.delete(id);
    generation?.dispose();
    reportClientStatus(`${environmentId}:${id}`, null);
  };

  const awaitTrust = (plugin: PluginStatus) => {
    const id = plugin.manifest.id;
    requested.delete(id);
    if (active.has(id) || pending.has(id)) unload(id);
    waiting.add(id);
    reportClientStatus(`${environmentId}:${id}`, {
      state: "awaiting-trust",
      revision: plugin.revision,
    });
  };

  const load = async (plugin: PluginStatus) => {
    const id = plugin.manifest.id;
    const compiled = plugin.source === "builtin" ? builtinClientPlugins.get(id) : undefined;
    const isTrusted = () =>
      compiled !== undefined || isPluginTrusted(environmentId, httpBaseUrl, plugin);
    const key = `${environmentId}:${id}`;
    const registrationKey = `${key}#${++clientStatuses.nextGeneration}`;
    const revision = plugin.revision;
    const startedLifecycle = lifecycle;
    const staged: {
      slot: string;
      id: string;
      order?: number;
      load: () => React.ComponentType<never>;
    }[] = [];
    const styles: string[] = [];
    const panels = new Map<string, PluginPanelDescription>();
    const extraContributions: Parameters<typeof pluginContributions.register>[1][number][] = [];
    const services: PluginServiceContribution[] = [];
    const serviceScope = `environment:${environmentId}`;
    let activationDisposer: (() => void | Promise<void>) | undefined;
    const disposalCallbacks: (() => void | Promise<void>)[] = [];
    let registrationOpen = true;
    let generationAlive = true;
    let committed = false;
    let leases = 0;
    let servicesStaging = false;
    let finalized = false;
    let releaseServices: Effect.Effect<void> | undefined;
    const runDisposer = (dispose: () => void | Promise<void>) => {
      try {
        void Promise.resolve(dispose()).catch((error) =>
          console.error(`Plugin ${id} cleanup failed`, error),
        );
      } catch (error) {
        console.error(`Plugin ${id} cleanup failed`, error);
      }
    };
    const finalizeActivation = () => {
      if (generationAlive || finalized || leases !== 0 || servicesStaging) return;
      finalized = true;
      if (activationDisposer) runDisposer(activationDisposer);
      for (const dispose of disposalCallbacks) runDisposer(dispose);
      disposalCallbacks.length = 0;
    };
    const disposeActivation = () => {
      generationAlive = false;
      registrationOpen = false;
      if (releaseServices) {
        const release = releaseServices;
        releaseServices = undefined;
        void Effect.runPromise(release).catch((error) =>
          console.error(`Plugin ${id} services cleanup failed`, error),
        );
      }
      finalizeActivation();
    };
    const retainServices = Effect.sync(() => {
      leases += 1;
      return Effect.sync(() => {
        leases -= 1;
        finalizeActivation();
      });
    });
    const assertServicesPermission = (
      permission: "client:services" | typeof CLIENT_HOST_SERVICES_PERMISSION,
    ) => {
      if (!generationAlive) throw new Error("This plugin generation has been disposed.");
      if (!plugin.manifest.permissions?.includes(permission))
        throw new Error(`Client services require ${permission} permission.`);
    };
    const serviceApi = (
      scope: string,
      permission: "client:services" | typeof CLIENT_HOST_SERVICES_PERMISSION,
    ): ClientPluginServiceApi => ({
      list: async () => {
        assertServicesPermission(permission);
        return clientPluginServices.list(scope);
      },
      get: async (serviceKey) => {
        assertServicesPermission(permission);
        return clientPluginServices.get(serviceKey, scope);
      },
      getBuiltin: async (serviceKey) => {
        assertServicesPermission(permission);
        return clientPluginServices.getBuiltin(serviceKey, scope);
      },
      register: (serviceKey, factory) => {
        assertServicesPermission(permission);
        if (!registrationOpen) throw new Error("Services register during activation.");
        if (
          typeof factory !== "function" ||
          (!serviceKey.startsWith(`${id}.`) && !serviceKey.startsWith(`${id}/`))
        )
          throw new Error("A new service requires its plugin's namespace and a factory.");
        services.push({ kind: "register", key: serviceKey, scope, factory });
      },
      replace: (serviceKey, factory) => {
        assertServicesPermission(permission);
        if (!registrationOpen) throw new Error("Services register during activation.");
        if (!serviceKey?.trim() || typeof factory !== "function")
          throw new Error("A service replacement requires a key and factory.");
        services.push({ kind: "replace", key: serviceKey, scope, factory });
      },
      wrap: (serviceKey, member, run) => {
        assertServicesPermission(permission);
        if (!registrationOpen) throw new Error("Services register during activation.");
        if (!serviceKey?.trim() || !member?.trim() || typeof run !== "function")
          throw new Error("A service wrapper requires a key, member and handler.");
        services.push({ kind: "wrap", key: serviceKey, scope, member, run });
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("The web plugin did not activate within 10 seconds.")),
        10_000,
      );
    });
    pending.get(id)?.();
    pending.set(id, disposeActivation);
    reportClientStatus(key, { state: "loading", revision });

    try {
      let moduleUrl: URL | undefined;
      if (!compiled) {
        if (!plugin.clientModuleUrl) throw new Error("This plugin has no web entry.");
        moduleUrl = new URL(plugin.clientModuleUrl, httpBaseUrl);
        if (
          moduleUrl.origin !== pluginTrustOrigin(httpBaseUrl) ||
          !["https:", "http:"].includes(moduleUrl.protocol)
        )
          throw new Error("A web plugin entry must come from its approved environment origin.");
      }
      if (!isTrusted()) {
        awaitTrust(plugin);
        return;
      }
      const loaded: unknown = await Promise.race([
        compiled ? Promise.resolve(compiled) : import(/* @vite-ignore */ moduleUrl!.href),
        deadline,
      ]);
      if (!generationAlive || requested.get(id) !== revision || startedLifecycle !== lifecycle)
        return;
      if (!isTrusted()) {
        awaitTrust(plugin);
        return;
      }
      if (loaded === null || typeof loaded !== "object") throw new Error("Invalid plugin module.");
      const exports = loaded as Record<string, unknown>;
      const activate = exports.activate ?? exports.default;
      if (typeof activate !== "function")
        throw new Error("A web plugin must export activate(host) or default(host).");
      const sdk: ClientPluginSdk = {
        React,
        Effect,
        environmentId,
        manifest: plugin.manifest,
        builtin: builtinRenderer,
        ui: pluginUi,
        features: () =>
          pluginFeatures
            .snapshot()
            .contributions.filter(
              (entry) =>
                !entry.pluginId.includes(":") || entry.pluginId.startsWith(`${environmentId}:`),
            ),
        register: (contributions) => {
          if (!registrationOpen)
            throw new Error("Feature registration is only available during plugin activation.");
          for (const contribution of contributions) {
            if (
              typeof contribution.slot !== "string" ||
              contribution.slot.length === 0 ||
              !isFeatureComponent(contribution.component)
            ) {
              throw new Error("A feature contribution requires a slot and React component.");
            }
            const component = contribution.component as React.ComponentType<never>;
            staged.push({
              slot: contribution.slot,
              id: contribution.id ?? "default",
              ...(contribution.order === undefined ? {} : { order: contribution.order }),
              load: () => component,
            });
          }
        },
        style: (css) => {
          if (!registrationOpen)
            throw new Error("Style registration is only available during plugin activation.");
          if (typeof css !== "string") throw new Error("A plugin stylesheet must be a string.");
          styles.push(css);
        },
        onDispose: (dispose) => {
          if (typeof dispose !== "function")
            throw new Error("A plugin disposer must be a function.");
          if (finalized) runDisposer(dispose);
          else disposalCallbacks.push(dispose);
        },
        panels: {
          register: (contributions) => {
            if (!registrationOpen)
              throw new Error("Panel registration is only available during plugin activation.");
            for (const panel of contributions) {
              if (
                !/^[a-z0-9][a-z0-9._-]*$/.test(panel.id) ||
                panels.has(panel.id) ||
                !panel.title?.trim() ||
                !isFeatureComponent(panel.component) ||
                (panel.icon !== undefined && !isFeatureComponent(panel.icon)) ||
                (panel.available !== undefined && typeof panel.available !== "function") ||
                (panel.surfaceKind !== undefined && panel.surfaceKind !== "canvas")
              ) {
                throw new Error("A panel requires a unique id, title, and React component.");
              }
              const slot = `panel:${id}/${panel.id}`;
              const { id: _panelId, component: _component, ...description } = panel;
              panels.set(panel.id, { ...description, slot });
              staged.push({
                slot,
                id: "default",
                load: () => panel.component as React.ComponentType<never>,
              });
            }
          },
          open: (threadRef, panelId) => {
            if (!generationAlive || !committed || threadRef.environmentId !== environmentId)
              throw new Error("Panels can open after activation in the plugin's environment.");
            const panel = panels.get(panelId);
            if (!panel) throw new Error("This plugin has not registered that panel.");
            openPluginPanel(threadRef, panel);
          },
        },
        routes: {
          path: (routeId) => pluginRoutePath(environmentId, id, routeId),
          register: (routes) => {
            if (!registrationOpen) throw new Error("Routes register during activation.");
            if (!plugin.manifest.permissions?.includes("routing"))
              throw new Error("Route registration requires routing permission.");
            for (const route of routes) {
              if (
                !/^[a-z0-9][a-z0-9._-]*$/.test(route.id) ||
                !route.title?.trim() ||
                !isFeatureComponent(route.component)
              )
                throw new Error("A route requires an id, title and React component.");
              extraContributions.push({
                slot: "routes",
                id: route.id,
                load: () => ({ ...route, id: `${id}/${route.id}` }),
              });
              staged.push({
                slot: `route:${id}/${route.id}`,
                id: "default",
                load: () => route.component as React.ComponentType<never>,
              });
            }
          },
        },
        navigation: {
          register: (items) => {
            if (!registrationOpen) throw new Error("Navigation registers during activation.");
            if (!plugin.manifest.permissions?.includes("ui"))
              throw new Error("Navigation registration requires ui permission.");
            for (const item of items) {
              if (
                !item.id?.trim() ||
                !item.title?.trim() ||
                !item.path.startsWith("/") ||
                item.path.startsWith("//")
              )
                throw new Error("Navigation requires an id, title and local path.");
              extraContributions.push({
                slot: "navigation",
                id: item.id,
                ...(item.order === undefined ? {} : { order: item.order }),
                load: () => ({ ...item, id: `${id}/${item.id}` }),
              });
            }
          },
          open: (path) => {
            if (!generationAlive || !committed)
              throw new Error("Navigation is available after plugin activation.");
            if (!path.startsWith("/") || path.startsWith("//"))
              throw new Error("Plugin navigation requires a local path.");
            window.dispatchEvent(
              new CustomEvent("t3:plugin:navigate", { detail: { environmentId, path } }),
            );
          },
        },
        actions: {
          register: (actions) => {
            if (!registrationOpen) throw new Error("Actions register during activation.");
            if (!plugin.manifest.permissions?.includes("actions"))
              throw new Error("Action registration requires actions permission.");
            for (const action of actions) {
              if (!action.id?.trim() || !action.title?.trim() || typeof action.run !== "function")
                throw new Error("An action requires an id, title and handler.");
              extraContributions.push({
                slot: "actions",
                id: action.id,
                load: () => ({
                  ...action,
                  id: `${id}/${action.id}`,
                  run: (context) => {
                    if (!generationAlive || !committed || context.environmentId !== environmentId)
                      throw new Error("This action is unavailable in the current environment.");
                    return action.run(context);
                  },
                }),
              });
            }
          },
        },
        services: {
          ...serviceApi(serviceScope, "client:services"),
          host: serviceApi("host", CLIENT_HOST_SERVICES_PERMISSION),
        },
        invoke: async (method, input) => {
          if (!generationAlive) throw new Error("This plugin generation has been disposed.");
          const result = await runAtomCommand(appAtomRegistry, pluginEnvironment.invoke, {
            environmentId,
            input: { id, method, ...(input === undefined ? {} : { input }) },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value.output;
        },
        desktop: window.desktopBridge?.plugins
          ? {
              invoke: async (method, input) => {
                if (!generationAlive) throw new Error("This plugin generation has been disposed.");
                const bridge = window.desktopBridge?.plugins;
                if (!bridge) throw new Error("Desktop plugin commands are unavailable.");
                return (
                  await bridge.invoke({ id, method, ...(input === undefined ? {} : { input }) })
                ).output;
              },
            }
          : null,
      };
      const activation = Promise.resolve(activate(sdk)).then((activated: unknown) => {
        if (typeof activated === "function") {
          const dispose = activated as () => void | Promise<void>;
          if (!finalized) activationDisposer = dispose;
          else runDisposer(dispose);
        }
      });
      await Promise.race([activation, deadline]);
      registrationOpen = false;
      if (!generationAlive || requested.get(id) !== revision || startedLifecycle !== lifecycle) {
        disposeActivation();
        return;
      }
      if (!isTrusted()) {
        awaitTrust(plugin);
        return;
      }
      if (services.length > 0) {
        servicesStaging = true;
        const staging = clientPluginServices
          .stage(registrationKey, services, retainServices, id)
          .then((release) => {
            releaseServices = release;
            if (!generationAlive) disposeActivation();
          })
          .finally(() => {
            servicesStaging = false;
            finalizeActivation();
          });
        await Promise.race([staging, deadline]);
        if (!generationAlive || requested.get(id) !== revision || startedLifecycle !== lifecycle) {
          disposeActivation();
          return;
        }
        if (!isTrusted()) {
          awaitTrust(plugin);
          return;
        }
      }

      const nodes = styles.map((css) => {
        const node = document.createElement("style");
        node.dataset.t3Plugin = key;
        const root = `[data-t3-plugin-environment="${CSS.escape(environmentId)}"]`;
        node.textContent = `@scope (${root}) to ([data-t3-plugin-environment]) {\n${css}\n}`;
        return node;
      });
      let unregister = () => pluginFeatures.unregister(registrationKey);
      let unregisterPanels = () => pluginPanels.unregister(registrationKey);
      let unregisterContributions = () => pluginContributions.unregister(registrationKey);
      const cleanup = () => {
        for (const remove of [
          unregister,
          unregisterPanels,
          unregisterContributions,
          ...nodes.map((node) => () => node.remove()),
        ]) {
          try {
            remove();
          } catch (error) {
            console.error(`Plugin ${id} rollback failed`, error);
          }
        }
        disposeActivation();
      };
      try {
        for (const node of nodes) document.head.append(node);
        unregister = pluginFeatures.register(registrationKey, staged);
        unregisterPanels = pluginPanels.register(
          registrationKey,
          [...panels].map(([panelId, panel]) => ({
            slot: "panels",
            id: panelId,
            load: () => panel,
          })),
        );
        unregisterContributions = pluginContributions.register(registrationKey, extraContributions);
      } catch (error) {
        cleanup();
        throw error;
      }
      if (!generationAlive || requested.get(id) !== revision || startedLifecycle !== lifecycle) {
        cleanup();
        return;
      }
      if (!isTrusted()) {
        cleanup();
        awaitTrust(plugin);
        return;
      }
      const previous = active.get(id);
      active.set(id, {
        revision,
        dispose: cleanup,
      });
      committed = true;
      previous?.dispose();
      reportClientStatus(key, { state: "active", revision });
    } catch (error) {
      disposeActivation();
      if (requested.get(id) !== revision || startedLifecycle !== lifecycle) return;
      if (!isTrusted()) {
        awaitTrust(plugin);
        return;
      }
      reportClientStatus(key, {
        state: "error",
        revision,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (pending.get(id) === disposeActivation) pending.delete(id);
    }
  };

  const reconcile = (snapshot: PluginSnapshot) => {
    if (disposed) return;
    latestSnapshot = snapshot;
    const desired = snapshot.plugins.filter(
      (plugin) =>
        plugin.enabled &&
        (plugin.source === "builtin"
          ? builtinClientPlugins.has(plugin.manifest.id)
          : plugin.clientModuleUrl ||
            (plugin.status === "error" && active.has(plugin.manifest.id))),
    );
    const wanted = new Set(desired.map((plugin) => plugin.manifest.id));
    // Disabling removes renderers and hosts before asynchronous service reconciliation.
    for (const id of new Set([...requested.keys(), ...waiting])) {
      if (wanted.has(id)) continue;
      requested.delete(id);
      unload(id);
    }
    // Revokes take effect before queued service reconciliation can yield.
    for (const plugin of snapshot.plugins) {
      if (
        plugin.enabled &&
        plugin.source !== "builtin" &&
        (plugin.manifest.entries?.web ||
          plugin.clientModuleUrl ||
          active.has(plugin.manifest.id)) &&
        !isPluginTrusted(environmentId, httpBaseUrl, plugin)
      )
        awaitTrust(plugin);
    }
    const startedLifecycle = lifecycle;
    reconciliation = reconciliation
      .then(async () => {
        if (startedLifecycle !== lifecycle) return;
        for (const plugin of snapshot.plugins) {
          if (
            plugin.source !== "builtin" ||
            serviceEnabled.get(plugin.manifest.id) === plugin.enabled
          )
            continue;
          await clientPluginServices.setEnabled(
            plugin.manifest.id,
            plugin.enabled,
            `environment:${environmentId}`,
          );
          serviceEnabled.set(plugin.manifest.id, plugin.enabled);
        }
        if (startedLifecycle !== lifecycle) return;
        if (latestSnapshot !== snapshot) return;
        for (const plugin of desired) {
          if (plugin.source !== "builtin" && !isPluginTrusted(environmentId, httpBaseUrl, plugin)) {
            awaitTrust(plugin);
            continue;
          }
          waiting.delete(plugin.manifest.id);
          if (requested.get(plugin.manifest.id) === plugin.revision) continue;
          requested.set(plugin.manifest.id, plugin.revision);
          void load(plugin);
        }
      })
      .catch((error) => console.error(`Plugin reconciliation failed for ${environmentId}`, error));
  };
  const unsubscribeTrust = subscribePluginTrust(() => {
    if (latestSnapshot) reconcile(latestSnapshot);
  });
  return {
    reconcile,
    dispose: () => {
      disposed = true;
      unsubscribeTrust();
      latestSnapshot = null;
      lifecycle += 1;
      for (const id of new Set([...requested.keys(), ...waiting])) unload(id);
      requested.clear();
    },
  };
}

type ClientRuntimeLease = {
  readonly runtime: ReturnType<typeof createClientPluginRuntime>;
  references: number;
};
const environmentRuntimes = pluginSharedState(
  "environment-runtimes",
  () => new Map<string, ClientRuntimeLease>(),
);
pluginSharedState("web-plugin-trust-runtime-migration", () => {
  // Retire hot-reload runtimes created before device approval was enforced.
  for (const lease of environmentRuntimes.values()) lease.runtime.dispose();
  environmentRuntimes.clear();
  return true;
});

function acquireEnvironmentRuntime(environmentId: EnvironmentId, httpBaseUrl: string) {
  const key = `${environmentId}\0${httpBaseUrl}`;
  let lease = environmentRuntimes.get(key);
  if (!lease) {
    lease = { runtime: createClientPluginRuntime(environmentId, httpBaseUrl), references: 0 };
    environmentRuntimes.set(key, lease);
  }
  lease.references += 1;
  const acquired = lease;
  let released = false;
  return {
    runtime: acquired.runtime,
    release: () => {
      if (released) return;
      released = true;
      acquired.references -= 1;
      if (acquired.references !== 0) return;
      if (environmentRuntimes.get(key) === acquired) environmentRuntimes.delete(key);
      acquired.runtime.dispose();
    },
  };
}

/** Nested surfaces share one live runtime and subscription per environment. */
export function EnvironmentPluginHost({
  environmentId,
  children,
}: {
  environmentId: EnvironmentId | null;
  children: React.ReactNode;
}) {
  const preparedHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const environment = useEnvironment(environmentId);
  const [mounted, setMounted] = React.useState<{
    environmentId: EnvironmentId;
    httpBaseUrl: string;
    runtime: ReturnType<typeof createClientPluginRuntime>;
  } | null>(null);
  const updateMounted = React.useEffectEvent(setMounted);
  // Reconnecting removes live configuration temporarily, not the environment's active plugins.
  const retained = mounted?.environmentId === environmentId ? mounted : null;
  const httpBaseUrl = preparedHttpBaseUrl ?? retained?.httpBaseUrl ?? null;
  const supported =
    environment !== null &&
    environment.entry.enabled &&
    (environment.serverConfig?.environment.capabilities.plugins ?? retained !== null);
  const result = usePluginSnapshot(supported ? environmentId : null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the environment's plugin runtime lease while mounted and releases it on change or unmount
  React.useEffect(() => {
    if (!supported || !environmentId || !httpBaseUrl) {
      updateMounted(null);
      return;
    }
    const lease = acquireEnvironmentRuntime(environmentId, httpBaseUrl);
    updateMounted({ environmentId, httpBaseUrl, runtime: lease.runtime });
    return lease.release;
  }, [environmentId, httpBaseUrl, supported]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles the mounted plugin runtime and builtin registry with each committed plugin snapshot
  React.useEffect(() => {
    if (
      supported &&
      result._tag === "Success" &&
      mounted?.environmentId === environmentId &&
      mounted.httpBaseUrl === httpBaseUrl
    ) {
      reconcileBuiltinPlugins(environmentId, result.value);
      mounted.runtime.reconcile(result.value);
    }
  }, [environmentId, httpBaseUrl, mounted, result, supported]);

  return (
    <PluginEnvironmentContext value={environmentId}>
      <div data-t3-plugin-environment={environmentId ?? ""} style={{ display: "contents" }}>
        {children}
      </div>
    </PluginEnvironmentContext>
  );
}

/** The current route chooses the shell's environment; detail surfaces can select their own. */
export function PluginHost({ children }: { children: React.ReactNode }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const params = useParams({ strict: false });
  const machine = useLocation({
    select: (location) =>
      "machine" in location.search && typeof location.search.machine === "string"
        ? location.search.machine
        : null,
  });
  const draft = useComposerDraftStore((store) =>
    params.draftId ? store.getDraftSession(DraftId.make(params.draftId)) : null,
  );
  const environmentId = params.environmentId
    ? EnvironmentId.make(params.environmentId)
    : (draft?.environmentId ?? (machine ? EnvironmentId.make(machine) : primaryEnvironmentId));
  return <EnvironmentPluginHost environmentId={environmentId}>{children}</EnvironmentPluginHost>;
}
