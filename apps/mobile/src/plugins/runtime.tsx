import { clientPluginServices } from "@t3tools/client-runtime/plugins/runtime";
import type { PluginServiceContribution } from "@t3tools/shared/pluginKernel";
import * as Effect from "effect/Effect";
import type { PluginContribution } from "@t3tools/client-runtime/plugins";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CLIENT_HOST_SERVICES_PERMISSION,
  PluginManifest,
  type EnvironmentId,
  type PluginSnapshot,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as React from "react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useGT } from "gt-react-native";
// oxlint-disable-next-line eslint/no-restricted-imports -- The plugin host hands native plugins the whole react-native module.
import * as ReactNative from "react-native";

import { appAtomRegistry } from "../state/atom-registry";
import {
  getNativeBuiltinFeature,
  NativePluginEnvironmentContext,
  nativePluginFeatures,
  nativePluginSharedState,
  useNativeWorkspaceEnvironment,
  setNativeBuiltinEnabled,
  clearNativeBuiltinEnabled,
  type NativeFeatureComponents,
} from "./features";
import { localNativePlugins } from "./local";
import { builtinNativePlugins } from "./builtin";
import type { NativePluginDefinition, NativePluginHost, NativePluginServices } from "./sdk";
import { nativePluginAtoms } from "./state";
import { useEnvironments } from "../state/environments";
import { environmentCatalog } from "../connection/catalog";
import { usePreparedConnection } from "../state/session";
import { defineDeclarativeNativePlugin } from "./declarative";

const decodeNativeManifest = Schema.decodeUnknownSync(PluginManifest);
const nativeGeneration = nativePluginSharedState("generation-sequence", () => ({ revision: 0 }));

async function activateNativeDefinition(
  definition: NativePluginDefinition,
  host: NativePluginHost,
  signal: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal.aborted) throw new Error("Native plugin activation was superseded.");
    await Promise.race([
      Promise.resolve().then(() => definition.activate(host)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native plugin activation exceeded 10 seconds.")),
          10_000,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Native plugin activation was superseded."));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function activatePlugin(
  definition: NativePluginDefinition,
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<() => void> {
  const manifest = decodeNativeManifest(definition.manifest);
  const contributions: PluginContribution<NativeFeatureComponents>[] = [];
  const disposers: Array<() => void | Promise<void>> = [];
  const serviceContributions: PluginServiceContribution[] = [];
  const owner = `${environmentId}:${manifest.id}:${++nativeGeneration.revision}`;
  let unregisterServices: Effect.Effect<void> | undefined;
  let leases = 0;
  let retired = false;
  let registering = true;
  let alive = true;
  const runDisposer = async (dispose: () => void | Promise<void>) => {
    try {
      await dispose();
    } catch (cause) {
      console.error("[plugins] native cleanup failed", cause);
    }
  };
  const disposeResources = async () => {
    if (!alive) return;
    alive = false;
    registering = false;
    const pending = disposers.splice(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (pending.length) {
            const dispose = pending.pop();
            if (dispose) await runDisposer(dispose);
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn("[plugins] native cleanup exceeded 10 seconds", manifest.id);
            resolve();
          }, 10_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const release = Effect.promise(async () => {
    leases -= 1;
    if (retired && leases === 0) await disposeResources();
  });
  const retire = async () => {
    retired = true;
    registering = false;
    if (unregisterServices) await Effect.runPromise(unregisterServices);
    if (leases === 0) await disposeResources();
  };
  const requireServices = (permission: string) => {
    if (!registering || retired) throw new Error("Native services register during activation.");
    if (!manifest.permissions?.includes(permission))
      throw new Error(`Native services require ${permission} permission.`);
  };
  const accessServices = (permission: string) => {
    if (!alive || retired || !manifest.permissions?.includes(permission))
      throw new Error(
        `Native services require an active generation with ${permission} permission.`,
      );
  };
  const servicesForScope = (scope: string, permission: string): NativePluginServices => ({
    list: async () => {
      accessServices(permission);
      return clientPluginServices.list(scope);
    },
    get: async (key) => {
      accessServices(permission);
      return clientPluginServices.get(key, scope);
    },
    getBuiltin: async (key) => {
      accessServices(permission);
      return clientPluginServices.getBuiltin(key, scope);
    },
    register: (key, factory) => {
      requireServices(permission);
      if (
        (!key.startsWith(`${manifest.id}.`) && !key.startsWith(`${manifest.id}/`)) ||
        typeof factory !== "function"
      )
        throw new Error("Native service factories must use their plugin namespace.");
      serviceContributions.push({ kind: "register", key, factory, scope });
    },
    replace: (key, factory) => {
      requireServices(permission);
      if (!key.trim() || typeof factory !== "function")
        throw new Error("Native service replacement requires a key and factory.");
      serviceContributions.push({ kind: "replace", key, factory, scope });
    },
    wrap: (key, member, run) => {
      requireServices(permission);
      if (!key.trim() || !member.trim() || typeof run !== "function")
        throw new Error("Native service wrapper requires a key, member and handler.");
      serviceContributions.push({ kind: "wrap", key, member, run, scope });
    },
  });
  try {
    await activateNativeDefinition(
      definition,
      {
        id: manifest.id,
        environmentId,
        React,
        ReactNative,
        Effect,
        Schema,
        services: {
          ...servicesForScope("environment:" + environmentId, "client:services"),
          host: servicesForScope("host", CLIENT_HOST_SERVICES_PERMISSION),
        },
        getBuiltin: getNativeBuiltinFeature,
        register: (slot, component, options) => {
          if (!registering)
            throw new Error("Native contributions must register during activation.");
          contributions.push({
            slot,
            id: options?.id ?? "default",
            order: options?.order ?? 0,
            load: () => component as ComponentType<never>,
          });
        },
        invoke: async (targetEnvironmentId, method, input) => {
          if (!alive || retired)
            throw new Error("This native plugin generation has been disposed.");
          if (targetEnvironmentId !== environmentId) {
            throw new Error("Native plugin commands must use the plugin's environment.");
          }
          const result = await runAtomCommand(appAtomRegistry, nativePluginAtoms.invoke, {
            environmentId,
            input: { id: manifest.id, method, input },
          });
          if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
          return result.value.output;
        },
        onDispose: (dispose) => {
          if (typeof dispose !== "function")
            throw new Error("A native plugin disposer must be a function.");
          if (alive && !retired) disposers.push(dispose);
          else void runDisposer(dispose);
        },
      },
      signal,
    );
    registering = false;
    if (signal.aborted) throw new Error("Native plugin activation was superseded.");
    unregisterServices = await clientPluginServices.stage(
      owner,
      serviceContributions,
      Effect.sync(() => {
        if (retired || !alive) throw new Error("Native generation retired.");
        leases += 1;
        return release;
      }),
      manifest.id,
      { signal },
    );
    if (signal.aborted) throw new Error("Native plugin activation was superseded.");
    const unregister = nativePluginFeatures.register(
      `${environmentId}:${manifest.id}`,
      contributions,
    );
    return () => {
      unregister();
      void retire().catch((cause: unknown) =>
        console.error("[plugins] native retirement failed", cause),
      );
    };
  } catch (cause) {
    registering = false;
    await retire();
    throw cause;
  }
}

async function downloadNativePlugin(
  httpBaseUrl: string,
  mobileModuleUrl: string,
  manifest: PluginManifest,
  signal: AbortSignal,
) {
  const base = new URL(httpBaseUrl);
  const url = new URL(mobileModuleUrl, base);
  if (url.origin !== base.origin)
    throw new Error("Native plugin assets must belong to their environment.");
  const response = await fetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`Native plugin download failed (${response.status}).`);
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > 256 * 1024) throw new Error("Native plugin document exceeds 256 KiB.");
  const source = await response.text();
  if (source.length > 256 * 1024) throw new Error("Native plugin document exceeds 256 KiB.");
  return defineDeclarativeNativePlugin(manifest, JSON.parse(source));
}

/** Metro bundles and environment-owned declarative documents share native activation lifecycle. */
export function NativePluginsProvider({ children }: { readonly children: ReactNode }) {
  const { environments } = useEnvironments();
  const workspaceEnvironmentId = useNativeWorkspaceEnvironment();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const configured = [...catalog.entries.values()].filter((entry) => entry.enabled);
  const primaryEnvironmentId =
    configured.find((entry) => entry.target._tag === "PrimaryConnectionTarget")?.target
      .environmentId ??
    configured[0]?.target.environmentId ??
    null;
  const [mountedEnvironmentIds, setMountedEnvironmentIds] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  // Reconnecting temporarily removes live config, not the environment's plugin generations.
  const targets = environments.filter(
    (environment) =>
      environment.entry.enabled &&
      (environment.serverConfig?.environment.capabilities.plugins ??
        mountedEnvironmentIds.has(environment.environmentId)),
  );
  if (
    mountedEnvironmentIds.size !== targets.length ||
    targets.some((target) => !mountedEnvironmentIds.has(target.environmentId))
  ) {
    setMountedEnvironmentIds(new Set(targets.map((target) => target.environmentId)));
  }
  return (
    <NativePluginEnvironmentContext value={workspaceEnvironmentId ?? primaryEnvironmentId}>
      {targets.map((target) => (
        <NativeEnvironmentPlugins key={target.environmentId} environmentId={target.environmentId} />
      ))}
      {children}
    </NativePluginEnvironmentContext>
  );
}

function NativeEnvironmentPlugins({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const definitions = localNativePlugins;
  const snapshotResult = useAtomValue(nativePluginAtoms.snapshotAtom(environmentId));
  const [retainedSnapshot, setRetainedSnapshot] = useState<PluginSnapshot | null>(null);
  const snapshot = AsyncResult.isSuccess(snapshotResult) ? snapshotResult.value : retainedSnapshot;
  const connection = usePreparedConnection(environmentId);
  const [retainedHttpBaseUrl, setRetainedHttpBaseUrl] = useState<string | null>(null);
  const httpBaseUrl = Option.isSome(connection)
    ? connection.value.httpBaseUrl
    : retainedHttpBaseUrl;
  if (snapshot !== retainedSnapshot) setRetainedSnapshot(snapshot);
  if (httpBaseUrl !== retainedHttpBaseUrl) setRetainedHttpBaseUrl(httpBaseUrl);
  const generations = useRef(
    new Map<
      string,
      { definition: NativePluginDefinition; revision: number; dispose: () => void }
    >(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- activates and disposes native plugin generations to match each committed plugin snapshot
  useEffect(() => {
    if (!snapshot) return;
    setNativeBuiltinEnabled(environmentId, snapshot.plugins);
    for (const plugin of snapshot.plugins) {
      if (plugin.source !== "builtin") continue;
      void clientPluginServices
        .setEnabled(plugin.manifest.id, plugin.enabled, "environment:" + environmentId)
        .catch((cause: unknown) => console.error("[plugins] native service state failed", cause));
    }
    const abort = new AbortController();
    const seen = new Set<string>();
    for (const status of snapshot.plugins) {
      const bundled =
        status.source === "builtin"
          ? builtinNativePlugins.get(status.manifest.id)
          : definitions.find((definition) => definition.manifest.id === status.manifest.id);
      if (!bundled && !status.mobileModuleUrl) continue;
      if (!status?.enabled || status.status !== "active") continue;
      seen.add(status.manifest.id);
      const previous = generations.current.get(status.manifest.id);
      if (previous?.revision === status.revision && (!bundled || previous.definition === bundled))
        continue;
      void (async () => {
        let definition = bundled;
        if (!definition) {
          if (!httpBaseUrl || !status.mobileModuleUrl) return;
          definition = await downloadNativePlugin(
            httpBaseUrl,
            status.mobileModuleUrl,
            status.manifest,
            abort.signal,
          );
        }
        if (abort.signal.aborted) return;
        const dispose = await activatePlugin(definition, environmentId, abort.signal);
        if (abort.signal.aborted) {
          dispose();
          return;
        }
        previous?.dispose();
        generations.current.set(status.manifest.id, {
          definition,
          revision: status.revision,
          dispose,
        });
      })().catch((cause: unknown) => {
        if (!abort.signal.aborted)
          console.error("[plugins] native activation failed", status.manifest.id, cause);
      });
    }
    for (const [id, generation] of generations.current) {
      if (seen.has(id)) continue;
      generation.dispose();
      generations.current.delete(id);
    }
    return () => abort.abort();
  }, [environmentId, httpBaseUrl, snapshot]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes every active plugin generation and builtin state when the environment changes or unmounts
  useEffect(() => {
    const current = generations.current;
    return () => {
      for (const generation of current.values()) generation.dispose();
      current.clear();
      clearNativeBuiltinEnabled(environmentId);
    };
  }, [environmentId]);
  return <NativePluginRecovery environmentId={environmentId} snapshot={snapshot} />;
}

/** Recovery uses native primitives so disabling a contributed interface cannot hide it. */
function NativePluginRecovery({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PluginSnapshot | null;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = snapshot
    ? snapshot.plugins.filter(
        (plugin) =>
          plugin.source === "builtin" &&
          !plugin.enabled &&
          !plugin.manifest.id.startsWith("t3.provider."),
      )
    : [];
  if (disabled.length === 0) return null;
  const enable = async (id: string) => {
    if (pending) return;
    setPending(id);
    setError(null);
    await runAtomCommand(appAtomRegistry, nativePluginAtoms.setEnabled, {
      environmentId,
      input: { id, enabled: true },
    })
      .then((result) => {
        if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(null));
  };
  return (
    <ReactNative.View
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: 32,
        zIndex: 10000,
        padding: 16,
        backgroundColor: "white",
        borderRadius: 12,
      }}
    >
      <ReactNative.Button
        title={open ? gt("Close plugin recovery") : gt("Plugin recovery")}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <ReactNative.Text style={{ color: "black" }}>
            {gt("Re-enable a built-in plugin")}
          </ReactNative.Text>
          {disabled.map((plugin) => (
            <ReactNative.Button
              key={plugin.manifest.id}
              title={gt("Enable {name}", { name: plugin.manifest.name })}
              disabled={pending !== null}
              onPress={() => {
                void enable(plugin.manifest.id);
              }}
            />
          ))}
          {error ? <ReactNative.Text style={{ color: "#b91c1c" }}>{error}</ReactNative.Text> : null}
        </>
      ) : null}
    </ReactNative.View>
  );
}
