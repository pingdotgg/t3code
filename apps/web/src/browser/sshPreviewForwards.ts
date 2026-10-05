import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Option from "effect/Option";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";

/**
 * Loopback preview URLs on an SSH environment name ports on the remote host, so
 * the desktop reaches them through an `ssh -L` forward. The desktop shares one
 * forward per remote port across leases; this module tracks which lease each
 * preview tab holds. A tab holds at most one lease, swapped when it navigates
 * and released when the tab leaves the thread's preview state. The desktop tab
 * itself may close and reopen on the same forwarded URL while the preview tab
 * lives, so its lifetime is the wrong owner.
 */
export interface PreviewForward {
  /** URL to load in the desktop tab. */
  readonly url: string;
  readonly leaseId: string | null;
}

export function readSshEnvironmentTarget(
  environmentId: EnvironmentId,
): DesktopSshEnvironmentTarget | null {
  const entry = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  if (entry?.target._tag !== "SshConnectionTarget") return null;
  const profile = Option.getOrNull(entry.profile);
  return profile?._tag === "SshConnectionProfile" ? profile.target : null;
}

const remoteLoopbackPort = (url: URL): number | null => {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isLoopbackHost(url.hostname)) return null;
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
};

/** Every lease this client still holds. */
const heldLeases = new Map<string, { readonly localPort: number; readonly remotePort: number }>();

const isEnvironmentServer = (environmentId: EnvironmentId, url: URL): boolean => {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) return false;
  const server = new URL(connection.httpBaseUrl);
  return isLoopbackHost(server.hostname) && server.port === url.port;
};

/**
 * The remote port a loopback URL names. A URL on a port this client already
 * forwards (it returns through history, re-navigation, and server snapshots)
 * maps back to that forward's remote port.
 */
const remotePortFor = (port: number): number => {
  for (const lease of heldLeases.values()) {
    if (lease.localPort === port) return lease.remotePort;
  }
  return port;
};

/** Acquires a forward when `url` is a loopback URL on an SSH environment. */
export async function acquirePreviewForward(
  environmentId: EnvironmentId,
  url: string,
): Promise<PreviewForward> {
  const target = readSshEnvironmentTarget(environmentId);
  if (target === null) return { url, leaseId: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, leaseId: null };
  }
  const loopbackPort = remoteLoopbackPort(parsed);
  // The environment's own server is itself a local SSH forward (asset URLs).
  if (loopbackPort === null || isEnvironmentServer(environmentId, parsed)) {
    return { url, leaseId: null };
  }
  const remotePort = remotePortFor(loopbackPort);
  const bridge = window.desktopBridge;
  if (bridge === undefined) {
    throw new Error("Previewing ports on an SSH environment requires the desktop app.");
  }
  const forward = await bridge.acquireSshPortForward(target, remotePort);
  heldLeases.set(forward.leaseId, { localPort: forward.localPort, remotePort });
  // `localhost` keeps the page's origin host stable for cookies and OAuth
  // callbacks; the forward itself only binds 127.0.0.1.
  parsed.hostname = "localhost";
  parsed.port = String(forward.localPort);
  return { url: parsed.toString(), leaseId: forward.leaseId };
}

const releaseLease = (leaseId: string | null): void => {
  if (leaseId === null) return;
  heldLeases.delete(leaseId);
  void window.desktopBridge?.releaseSshPortForward(leaseId).catch(() => undefined);
};

export function releasePreviewForward(forward: PreviewForward): void {
  releaseLease(forward.leaseId);
}

interface TabForward {
  /** Increments per navigation; only the newest navigation may load or commit. */
  latest: number;
  committed: number;
  leaseId: string | null;
}

const tabForwards = new Map<string, TabForward>();

const tabKey = (threadRef: ScopedThreadRef, tabId: string): string =>
  `${scopedThreadKey(threadRef)}\u0000${tabId}`;

const tabForward = (key: string): TabForward => {
  let current = tabForwards.get(key);
  if (!current) {
    current = { latest: 0, committed: 0, leaseId: null };
    tabForwards.set(key, current);
  }
  return current;
};

/**
 * Hands a forward acquired for a new tab to the tab that now shows it, or
 * releases it when the open failed.
 */
export function settleOpenedForward(
  threadRef: ScopedThreadRef,
  forward: PreviewForward | null,
  tabId: string | null,
): void {
  if (forward === null) return;
  if (tabId === null) {
    releasePreviewForward(forward);
    return;
  }
  const state = tabForward(tabKey(threadRef, tabId));
  state.latest += 1;
  commit(state, state.latest, forward.leaseId);
}

function commit(state: TabForward, token: number, leaseId: string | null): void {
  if (token <= state.committed) {
    releaseLease(leaseId);
    return;
  }
  const previous = state.leaseId;
  state.committed = token;
  state.leaseId = leaseId;
  // Released after the swap: when both point at the same remote port the
  // desktop keeps the shared ssh child alive across the handoff.
  if (previous !== leaseId) releaseLease(previous);
}

/**
 * Navigates an existing desktop tab, forwarding SSH loopback URLs first.
 * Returns the URL loaded, or null when a newer navigation of the same tab
 * started while the forward was being acquired.
 */
export async function navigateTabThroughForward(input: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly navigate: (url: string) => Promise<void>;
}): Promise<string | null> {
  const key = tabKey(input.threadRef, input.tabId);
  const state = tabForward(key);
  state.latest += 1;
  const token = state.latest;
  const forward = await acquirePreviewForward(input.threadRef.environmentId, input.url);
  if (token !== state.latest || tabForwards.get(key) !== state) {
    releasePreviewForward(forward);
    return null;
  }
  try {
    await input.navigate(forward.url);
  } catch (error) {
    releasePreviewForward(forward);
    throw error;
  }
  if (tabForwards.get(key) !== state) {
    releasePreviewForward(forward);
    return forward.url;
  }
  commit(state, token, forward.leaseId);
  return forward.url;
}

/** Called by the preview state store for every tab it drops, whatever dropped it. */
export function releaseTabForward(threadRef: ScopedThreadRef, tabId: string): void {
  const key = tabKey(threadRef, tabId);
  const state = tabForwards.get(key);
  if (!state) return;
  tabForwards.delete(key);
  releaseLease(state.leaseId);
}

export function resetSshPreviewForwardsForTests(): void {
  tabForwards.clear();
  heldLeases.clear();
}
