import type { EnvironmentId, PluginStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { pluginSharedState } from "./features";

const STORAGE_PREFIX = "t3code:web-plugin-trust:v1:";
const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const Receipt = Schema.Struct({
  source: Schema.Literals(["local", "registry"]),
  contentSha256: Schema.String.check(Schema.isPattern(CONTENT_SHA256_PATTERN)),
  localDevelopmentDirectory: Schema.optionalKey(Schema.String),
  mode: Schema.Literals(["version", "local-development"]),
});
const isReceipt = Schema.is(Receipt);
type ApprovalMode = (typeof Receipt.Type)["mode"];
const state = pluginSharedState("web-plugin-trust", () => ({
  listeners: new Set<() => void>(),
  blocked: new Set<string>(),
  stopListening: null as (() => void) | null,
}));

export function pluginTrustOrigin(httpBaseUrl: string | null): string | null {
  if (!httpBaseUrl) return null;
  try {
    const url = new URL(httpBaseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function trustKey(environmentId: EnvironmentId, httpBaseUrl: string | null, plugin: PluginStatus) {
  const origin = pluginTrustOrigin(httpBaseUrl);
  return origin && plugin.source !== "builtin"
    ? STORAGE_PREFIX + JSON.stringify([environmentId, origin, plugin.manifest.id])
    : null;
}

function read(key: string | null) {
  if (!key || state.blocked.has(key) || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function decode(raw: string | null) {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return isReceipt(value) ? value : null;
  } catch {
    return null;
  }
}

function matches(plugin: PluginStatus, receipt: typeof Receipt.Type | null) {
  if (
    !CONTENT_SHA256_PATTERN.test(plugin.contentSha256 ?? "") ||
    !receipt ||
    receipt.source !== plugin.source
  )
    return false;
  return receipt.mode === "version"
    ? receipt.contentSha256 === plugin.contentSha256
    : plugin.source === "local" &&
        Boolean(plugin.localDevelopmentDirectory) &&
        receipt.localDevelopmentDirectory === plugin.localDevelopmentDirectory;
}

export function isPluginTrusted(
  environmentId: EnvironmentId,
  httpBaseUrl: string | null,
  plugin: PluginStatus,
) {
  return matches(plugin, decode(read(trustKey(environmentId, httpBaseUrl, plugin))));
}

function notify() {
  for (const listener of Array.from(state.listeners)) {
    try {
      listener();
    } catch (error) {
      console.error("Plugin trust observer failed", error);
    }
  }
}

/** Receipts are device-local and independently stored, so stale tabs cannot restore a revoke. */
export function subscribePluginTrust(listener: () => void) {
  if (state.listeners.size === 0 && typeof window !== "undefined") {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) notify();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", notify);
    state.stopListening = () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", notify);
    };
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0) {
      state.stopListening?.();
      state.stopListening = null;
    }
  };
}

export function usePluginTrust(
  environmentId: EnvironmentId,
  httpBaseUrl: string | null,
  plugin: PluginStatus,
) {
  const key = trustKey(environmentId, httpBaseUrl, plugin);
  const raw = useSyncExternalStore(
    subscribePluginTrust,
    () => read(key),
    () => null,
  );
  const receipt = decode(raw);
  return { approved: receipt !== null, trusted: matches(plugin, receipt), mode: receipt?.mode };
}

export function approvePlugin(
  environmentId: EnvironmentId,
  httpBaseUrl: string | null,
  plugin: PluginStatus,
  mode: ApprovalMode,
) {
  const key = trustKey(environmentId, httpBaseUrl, plugin);
  if (!key || !plugin.contentSha256 || typeof window === "undefined")
    throw new Error("Connect this environment and wait for its plugin content hash to approve it.");
  if (
    mode === "local-development" &&
    (plugin.source !== "local" || !plugin.localDevelopmentDirectory)
  )
    throw new Error("Development approval requires this plugin's local directory.");
  const receipt = {
    source: plugin.source,
    contentSha256: plugin.contentSha256,
    mode,
    ...(mode === "local-development"
      ? { localDevelopmentDirectory: plugin.localDevelopmentDirectory }
      : {}),
  };
  if (!isReceipt(receipt)) throw new Error("This plugin has no valid content hash.");
  const encoded = JSON.stringify(receipt);
  try {
    window.localStorage.setItem(key, encoded);
    if (window.localStorage.getItem(key) !== encoded) throw new Error("Approval was not saved.");
  } catch {
    state.blocked.add(key);
    notify();
    throw new Error("Device storage is unavailable. This plugin has not been approved.");
  }
  state.blocked.delete(key);
  notify();
}

export function revokePlugin(
  environmentId: EnvironmentId,
  httpBaseUrl: string | null,
  plugin: PluginStatus,
) {
  const key = trustKey(environmentId, httpBaseUrl, plugin);
  if (!key || typeof window === "undefined") throw new Error("This environment is unavailable.");
  state.blocked.add(key);
  try {
    window.localStorage.removeItem(key);
    if (window.localStorage.getItem(key) !== null) throw new Error("Revocation was not saved.");
    state.blocked.delete(key);
  } catch {
    throw new Error("Trust was revoked in this tab, but device storage could not save the change.");
  } finally {
    notify();
  }
}
