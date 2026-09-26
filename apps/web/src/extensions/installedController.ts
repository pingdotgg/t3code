import { sha256 } from "@noble/hashes/sha2";
import { installedStream } from "./installedStream";
import type { ExtensionInstallation } from "@t3tools/contracts";
import {
  copyJson,
  validateContext,
  type Json,
  type ViewContext,
} from "@t3tools/extension-sdk/contracts";
import {
  validateEnvironmentPackage,
  type ClientFactory,
  type ClientHost,
  type EnvironmentPackage,
  type GlobalCommandsHandle,
} from "@t3tools/extension-sdk/environment";
import type { Extension } from "@t3tools/extension-sdk/host";
import type {
  ApiDiscovery,
  ApiInvocation,
  ApiStreamInvocation,
  ApiStreamFrame,
  ApiSelection,
  ApiUnavailableReason,
} from "@t3tools/extension-sdk/capabilities";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type * as React from "react";
import type { BrowserSurfaceBinding } from "./browserSurfaceBridge";
import type { BrowserFramesBinding } from "./browserFramesBridge";
import type { KeybindingsHostBinding } from "./keybindingsHostBridge";
import type {
  BrowserFramesHost,
  BrowserSurfaceHost,
  UiKeybindingsHost,
} from "@t3tools/extension-sdk/catalogue";
import {
  discardStagedGlobalCommands,
  stageGlobalCommands,
  unregisterInstallationCommands,
} from "./extensionCommandRegistry";

export type InstalledPackage = Omit<ExtensionInstallation, "package"> & {
  readonly package: EnvironmentPackage;
};
export interface InstalledSnapshot {
  readonly supportsCatalogueChanges?: boolean;
  readonly supportsApiStreams?: boolean;
  readonly supportedPackageFormats?: readonly number[];
  readonly apiSelections?: readonly ApiSelection[];
  readonly apiResolution?: readonly {
    id: string;
    providerId?: string;
    reason?: ApiUnavailableReason;
  }[];
  readonly pluginResolution?: readonly {
    id: string;
    status: "available" | "disabled" | "unavailable";
    reason?: ApiUnavailableReason;
  }[];
  readonly installations: readonly InstalledPackage[];
  readonly loading: boolean;
  readonly error: string | null;
}
export const EMPTY_INSTALLED: InstalledSnapshot = {
  installations: [],
  loading: false,
  error: null,
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** Cancellation bounds waiting for async module evaluation; trusted synchronous code cannot be preempted. */
function waitForClient(
  load: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Installed client load cancelled"));
      return;
    }
    const loading = new AbortController();
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      loading.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new Error("Installed client load cancelled"));
    const timer = setTimeout(() => finish(new Error("Installed client load timed out")), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (settled) throw new Error("Installed client load cancelled");
        return load(loading.signal);
      })
      .then(
        (value) => finish(null, value),
        (error) =>
          finish(error instanceof Error ? error : new Error("Installed client load failed")),
      );
  });
}
export function createInstalledExtensionController(options: {
  readonly environmentId: string;
  readonly React: typeof React;
  readonly list: (signal: AbortSignal) => Promise<{
    installations: readonly ExtensionInstallation[];
    supportsCatalogueChanges?: boolean;
    supportsApiStreams?: boolean;
    supportedPackageFormats?: readonly number[];
    apiSelections?: readonly ApiSelection[];
    apiResolution?: readonly { id: string; providerId?: string; reason?: ApiUnavailableReason }[];
    pluginResolution?: readonly {
      id: string;
      status: "available" | "disabled" | "unavailable";
      reason?: ApiUnavailableReason;
    }[];
  }>;
  readonly policyChanged?: (policy: {
    apiSelections: readonly ApiSelection[];
    apiResolution: readonly { id: string; providerId?: string; reason?: ApiUnavailableReason }[];
  }) => void;
  readonly client: (
    id: string,
    hash: string,
    signal: AbortSignal,
  ) => Promise<{ code: string; contentHash: string }>;
  readonly readAsset?: (
    id: string,
    hash: string,
    path: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly invoke: (
    toolId: string,
    input: Json,
    context: ViewContext,
    hash: string,
    signal: AbortSignal,
  ) => Promise<Json>;
  readonly invokeApi?: (
    id: string,
    hash: string,
    request: ApiInvocation,
    signal: AbortSignal,
  ) => Promise<Json>;
  readonly subscribeApi?: (
    id: string,
    hash: string,
    request: ApiStreamInvocation,
    signal: AbortSignal,
  ) => AsyncIterable<ApiStreamFrame>;
  readonly discoverApis?: (
    id: string,
    hash: string,
    context: ViewContext,
    signal: AbortSignal,
  ) => Promise<readonly ApiDiscovery[]>;
  readonly load: (code: string, signal: AbortSignal) => Promise<unknown>;
  readonly register: (extension: Extension<SurfaceRenderer>, client: ClientHost) => () => void;
  readonly changed: (snapshot: InstalledSnapshot) => void;
  /**
   * `t3.browser/surface@1.0.0` host bridge factory — bound per installation so
   * the resulting `host.browserSurface` enforces that installation's grants
   * and ends its leases with the installation lifetime.
   */
  readonly browserSurface?: (binding: BrowserSurfaceBinding) => BrowserSurfaceHost;
  /**
   * `t3.browser/frames@1.0.0` presenter bridge — bound per installation so
   * the resulting `host.browserFrames` checks that installation's grants
   * and detaches its views with the installation lifetime.
   */
  readonly browserFrames?: (binding: BrowserFramesBinding) => BrowserFramesHost;
  /**
   * `t3.ui/keybindings@1.1.0` client capability — bound per installation so
   * `host.keybindings` exists only under that installation's grant and
   * retires with its lifetime.
   */
  readonly keybindings?: (binding: KeybindingsHostBinding) => UiKeybindingsHost | undefined;
}) {
  const active = new Map<string, { signature: string; stop: () => void }>();
  // One epoch per live registration — a re-registered installation gets a new
  // one so stale command bindings can be told apart from live ones.
  const epochs = new Map<string, number>();
  let epochCounter = 0;
  let generation = 0;
  let pending: AbortController | undefined;
  let disposed = false;
  let snapshot = EMPTY_INSTALLED;
  const publish = (next: InstalledSnapshot) => {
    snapshot = next;
    options.changed(next);
  };
  const clear = () => {
    for (const entry of active.values()) entry.stop();
    active.clear();
  };
  return {
    async refresh() {
      if (disposed) return;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const current = ++generation;
      const live = () => !disposed && generation === current && !controller.signal.aborted;
      publish({ ...snapshot, loading: true, error: null });
      try {
        const response = await options.list(controller.signal);
        if (!live()) return;
        if (response.installations.length > 64)
          throw new Error("Environment extension limit exceeded");
        const installations = response.installations.map((item) => {
          const pkg = validateEnvironmentPackage(item.package);
          if (pkg.manifest.id !== item.id || !/^[a-f0-9]{64}$/.test(item.contentHash))
            throw new Error("Invalid installed package identity");
          return {
            ...item,
            grants: {
              capabilities: [...item.grants.capabilities],
              projectIds: [...item.grants.projectIds],
            },
            package: pkg,
          };
        });
        if (new Set(installations.map((item) => item.id)).size !== installations.length)
          throw new Error("Duplicate installed package");
        options.policyChanged?.({
          apiSelections: response.apiSelections ?? [],
          apiResolution: response.apiResolution ?? [],
        });
        const eligible = (item: InstalledPackage) =>
          item.enabled &&
          (item.package.format < 3 ||
            (response.supportedPackageFormats?.includes(item.package.format) === true &&
              response.supportsApiStreams === true &&
              (item.package.format !== 4 || options.readAsset !== undefined))) &&
          (!response.pluginResolution ||
            response.pluginResolution.find((state) => state.id === item.id)?.status ===
              "available");
        const signatures = new Map<string, string>();
        const byId = new Map(installations.map((item) => [item.id, item]));
        const apiResolution = new Map(
          (response.apiResolution ?? []).map((item) => [item.id, item]),
        );
        const apiSelections = new Map(
          (response.apiSelections ?? []).map((item) => [item.id, item]),
        );
        // A dependent client owns the lifetime of its selected providers as well as its own code.
        // Capture only its dependency closure so unrelated catalogue changes retain live viewers.
        const signature = (item: InstalledPackage) => {
          const cached = signatures.get(item.id);
          if (cached !== undefined) return cached;
          const plugins = new Map<string, unknown>();
          const apis = new Map<string, unknown>();
          const visit = (id: string) => {
            if (plugins.has(id)) return;
            const dependency = byId.get(id);
            plugins.set(
              id,
              dependency ? [dependency.contentHash, dependency.enabled, dependency.grants] : null,
            );
            if (!dependency) return;
            for (const named of dependency.package.dependencies ?? []) visit(named.pluginId);
            const required = new Set([
              ...(dependency.package.requires ?? []).map((api) => api.id),
              ...(dependency.package.provides ?? []).map((api) => api.id),
              ...(dependency.package.dependencies ?? []).flatMap((named) =>
                (named.apis ?? []).map((api) => api.id),
              ),
            ]);
            for (const id of required) {
              const resolved = apiResolution.get(id);
              apis.set(id, [resolved ?? null, apiSelections.get(id) ?? null]);
              if (resolved?.providerId && byId.has(resolved.providerId)) visit(resolved.providerId);
            }
          };
          visit(item.id);
          const value = canonical([
            [...plugins].sort(([a], [b]) => a.localeCompare(b)),
            [...apis].sort(([a], [b]) => a.localeCompare(b)),
          ]);
          signatures.set(item.id, value);
          return value;
        };
        for (const [id, entry] of active) {
          const item = installations.find((candidate) => candidate.id === id);
          if (
            !item ||
            !eligible(item) ||
            !item.package.clientEntry ||
            signature(item) !== entry.signature
          ) {
            entry.stop();
            active.delete(id);
          }
        }
        const errors: string[] = installations
          .filter(
            (item) =>
              item.enabled &&
              item.package.format >= 3 &&
              !(
                response.supportedPackageFormats?.includes(item.package.format) === true &&
                response.supportsApiStreams === true &&
                (item.package.format !== 4 || options.readAsset !== undefined)
              ),
          )
          .map(
            (item) =>
              item.id + ": This host does not support package format " + item.package.format + ".",
          );
        for (const item of installations) {
          if (!live()) return;
          if (!eligible(item) || !item.package.clientEntry || active.has(item.id)) continue;
          const lifetime = new AbortController();
          let registered = false;
          try {
            const code = await options.client(item.id, item.contentHash, controller.signal);
            if (!live()) return;
            if (
              code.contentHash !== item.contentHash ||
              new TextEncoder().encode(code.code).length > 1024 * 1024
            )
              throw new Error("Installed client changed or exceeds size limit");
            const factory = await waitForClient(
              (signal) => options.load(code.code, signal),
              controller.signal,
            );
            if (!live()) return;
            if (typeof factory !== "function")
              throw new Error("Installed client must export a factory");
            const identity = signature(item);
            const browserSurface = options.browserSurface?.({
              grants: item.grants,
              lifetime: lifetime.signal,
            });
            const browserFrames = options.browserFrames?.({
              grants: item.grants,
              lifetime: lifetime.signal,
            });
            const keybindings = options.keybindings?.({
              grants: item.grants,
              lifetime: lifetime.signal,
            });
            const clientHost: ClientHost = {
              React: options.React,
              async invokeApi(request, callerSignal) {
                const signal = AbortSignal.any([callerSignal, lifetime.signal]);
                const context = validateContext(request.context);
                if (
                  !registered ||
                  disposed ||
                  signal.aborted ||
                  context.resource.environmentId !== options.environmentId ||
                  !context.resource.projectId ||
                  !item.grants.projectIds.some((id) => id === context.resource.projectId) ||
                  !options.invokeApi
                )
                  throw new Error("Installed API is unavailable in this scope");
                const result = await options.invokeApi(
                  item.id,
                  item.contentHash,
                  { ...request, context },
                  signal,
                );
                if (!registered || disposed || signal.aborted)
                  throw new Error("Installed API invocation expired");
                return copyJson(result);
              },
              subscribeApi(request, callerSignal) {
                const signal = AbortSignal.any([callerSignal, lifetime.signal]);
                const context = validateContext(request.context);
                const validate = () => {
                  if (
                    !registered ||
                    disposed ||
                    signal.aborted ||
                    context.resource.environmentId !== options.environmentId ||
                    !context.resource.projectId ||
                    !item.grants.projectIds.some((id) => id === context.resource.projectId) ||
                    response.supportsApiStreams !== true ||
                    !options.subscribeApi
                  )
                    throw new Error("Installed API stream is unavailable in this scope");
                };
                return installedStream(
                  (streamSignal) => {
                    validate();
                    return options.subscribeApi!(
                      item.id,
                      item.contentHash,
                      { ...request, input: copyJson(request.input), context },
                      streamSignal,
                    );
                  },
                  signal,
                  validate,
                );
              },
              async discoverApis(context, callerSignal) {
                const signal = AbortSignal.any([callerSignal, lifetime.signal]);
                const captured = validateContext(context);
                if (
                  !registered ||
                  disposed ||
                  signal.aborted ||
                  captured.resource.environmentId !== options.environmentId ||
                  !captured.resource.projectId ||
                  !item.grants.projectIds.some((id) => id === captured.resource.projectId) ||
                  !options.discoverApis
                )
                  throw new Error("Installed API discovery is unavailable in this scope");
                const result = await options.discoverApis(
                  item.id,
                  item.contentHash,
                  captured,
                  signal,
                );
                if (!registered || disposed || signal.aborted)
                  throw new Error("Installed API discovery expired");
                return copyJson(result);
              },
              async readAsset(path, callerSignal) {
                const signal = AbortSignal.any([callerSignal, lifetime.signal]);
                const validate = () => {
                  if (!registered || disposed || signal.aborted)
                    throw new Error("Installed asset lifetime expired");
                };
                validate();
                const declaration =
                  item.package.format === 4
                    ? item.package.assets.find((asset) => asset.path === path)
                    : undefined;
                if (!declaration || !options.readAsset)
                  throw new Error("Installed asset is not declared or supported");
                const bytes = await options.readAsset(item.id, item.contentHash, path, signal);
                validate();
                if (!(bytes instanceof Uint8Array) || bytes.byteLength !== declaration.byteLength)
                  throw new Error("Installed asset length mismatch");
                // The existing browser-safe hash also works for direct HTTP environments.
                const digest = Array.from(sha256(bytes), (byte) =>
                  byte.toString(16).padStart(2, "0"),
                ).join("");
                if (digest !== declaration.sha256)
                  throw new Error("Installed asset digest mismatch");
                validate();
                return { bytes, mediaType: declaration.mediaType, sha256: digest };
              },
              async invokeTool(toolId, input, context, callerSignal) {
                const signal = AbortSignal.any([callerSignal, lifetime.signal]);
                const captured = validateContext(context);
                if (
                  !registered ||
                  disposed ||
                  signal.aborted ||
                  captured.resource.environmentId !== options.environmentId ||
                  !captured.resource.projectId ||
                  !item.grants.projectIds.some((id) => id === captured.resource.projectId) ||
                  !item.package.tools.some((tool) => tool.id === toolId)
                )
                  throw new Error("Installed tool is unavailable in this scope");
                const result = await options.invoke(
                  toolId,
                  copyJson(input),
                  captured,
                  item.contentHash,
                  signal,
                );
                if (disposed || signal.aborted)
                  throw new Error("Installed tool invocation expired");
                return copyJson(result);
              },
              registerGlobalCommands(commands, handler) {
                // Factory-time staging only: the commit flush runs once the
                // installation is registered and a seam socket is live.
                const entry = stageGlobalCommands(
                  options.environmentId,
                  item.id,
                  commands,
                  handler,
                );
                const handle: GlobalCommandsHandle = {
                  get status() {
                    return entry.status;
                  },
                  get token() {
                    return entry.token;
                  },
                  get rejections() {
                    return entry.rejections;
                  },
                  onDidChange(listener) {
                    entry.listeners.add(listener);
                    return () => {
                      entry.listeners.delete(listener);
                    };
                  },
                };
                return handle;
              },
              ...(browserSurface ? { browserSurface } : {}),
              ...(browserFrames ? { browserFrames } : {}),
              ...(keybindings ? { keybindings } : {}),
            };
            const extension = (factory as ClientFactory)(clientHost);
            if (canonical(extension.manifest) !== canonical(item.package.manifest))
              throw new Error("Installed client manifest does not match its package");
            const unregister = options.register(extension, clientHost);
            epochs.set(item.id, ++epochCounter);
            active.set(item.id, {
              signature: identity,
              stop: () => {
                lifetime.abort();
                unregister();
                unregisterInstallationCommands(options.environmentId, item.id);
              },
            });
            registered = true;
          } catch (error) {
            if (!live()) return;
            errors.push(
              item.id + ": " + (error instanceof Error ? error.message : "Client unavailable"),
            );
          } finally {
            if (!registered) {
              lifetime.abort();
              discardStagedGlobalCommands(options.environmentId, item.id);
            }
          }
        }
        if (live())
          publish({
            installations,
            supportsCatalogueChanges: response.supportsCatalogueChanges === true,
            supportsApiStreams: response.supportsApiStreams === true,
            supportedPackageFormats: response.supportedPackageFormats ?? [1, 2],
            apiSelections: response.apiSelections ?? [],
            apiResolution: response.apiResolution ?? [],
            pluginResolution: response.pluginResolution ?? [],
            loading: false,
            error: errors.length ? errors.join("; ").slice(0, 2048) : null,
          });
      } catch (error) {
        if (!live()) return;
        clear();
        publish({
          installations: [],
          supportsCatalogueChanges: snapshot.supportsCatalogueChanges === true,
          supportsApiStreams: snapshot.supportsApiStreams === true,
          supportedPackageFormats: snapshot.supportedPackageFormats ?? [1, 2],
          loading: false,
          error: error instanceof Error ? error.message : "Could not load environment extensions",
        });
      }
    },
    /** Live registration epoch for an installation, or null when it is not active. */
    installationEpoch(installationId: string) {
      return active.has(installationId) ? (epochs.get(installationId) ?? null) : null;
    },
    dispose() {
      disposed = true;
      generation++;
      pending?.abort();
      clear();
    },
  };
}
