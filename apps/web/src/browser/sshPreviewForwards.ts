import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  // All of 127.0.0.0/8 names the remote machine; the forward targets remote localhost.
  if (!isLoopbackHost(url.hostname) && !isLocalLoopbackHost(url.hostname)) return null;
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
};

/**
 * Local port → remote port per environment. The desktop reuses the remote port
 * when it is free locally, so most entries are identity. Entries outlive their
 * leases: forwarded URLs come back through history, recents, and server
 * snapshots after the tab that created them is gone.
 */
const forwardedPorts = new Map<EnvironmentId, Map<number, number>>();

const isEnvironmentServer = (environmentId: EnvironmentId, url: URL): boolean => {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) return false;
  const server = new URL(connection.httpBaseUrl);
  return isLoopbackHost(server.hostname) && server.port === url.port;
};

const remotePortFor = (environmentId: EnvironmentId, port: number): number =>
  forwardedPorts.get(environmentId)?.get(port) ?? port;

/** Maps a URL loaded through a forward back to the remote URL it names. */
export function toRemotePreviewUrl(environmentId: EnvironmentId, url: string): string {
  const ports = forwardedPorts.get(environmentId);
  if (ports === undefined) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const loopbackPort = remoteLoopbackPort(parsed);
  const remotePort = loopbackPort === null ? undefined : ports.get(loopbackPort);
  if (remotePort === undefined || remotePort === loopbackPort) return url;
  parsed.port = String(remotePort);
  return parsed.toString();
}

export class SshPreviewForwardError extends Schema.TaggedError<SshPreviewForwardError>()(
  "SshPreviewForwardError",
  { remotePort: Schema.Number, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not forward remote port ${this.remotePort}: ${this.detail}`;
  }
}

export const isSshPreviewForwardError = Schema.is(SshPreviewForwardError);

/**
 * Acquires a forward when `url` is a loopback URL on an SSH environment.
 * Rejects with SshPreviewForwardError.
 */
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
  const remotePort = remotePortFor(environmentId, loopbackPort);
  const bridge = window.desktopBridge;
  if (bridge === undefined) {
    throw new SshPreviewForwardError({
      remotePort,
      detail: "previewing ports on an SSH environment requires the desktop app.",
    });
  }
  const forward = await bridge.acquireSshPortForward(target, remotePort).catch((cause: unknown) => {
    throw new SshPreviewForwardError({
      remotePort,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  });
  const ports = forwardedPorts.get(environmentId) ?? new Map<number, number>();
  ports.set(forward.localPort, remotePort);
  forwardedPorts.set(environmentId, ports);
  // `localhost` keeps the page's origin host stable for cookies and OAuth
  // callbacks; the forward itself only binds 127.0.0.1.
  parsed.hostname = "localhost";
  parsed.port = String(forward.localPort);
  return { url: parsed.toString(), leaseId: forward.leaseId };
}

const releaseLease = (leaseId: string | null): void => {
  if (leaseId === null) return;
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
 * started while the forward was being acquired, or the tab closed. Navigate
 * calls go out in token order, so a superseded navigation never loads last.
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
    return null;
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
  forwardedPorts.clear();
}
