import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopRemotePreviewProxyBridge,
  DesktopRemotePreviewProxyStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { remotePreviewProxyDialHost } from "@t3tools/shared/remotePreviewProxy";
import * as DateTime from "effect/DateTime";

import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";

import { reachesEnvironmentLoopback } from "./browserTargetResolver";

const remoteProxyBridge = (): DesktopRemotePreviewProxyBridge | null =>
  typeof window === "undefined" ? null : (window.desktopBridge?.preview?.remoteProxy ?? null);

/**
 * Desktop renders this environment's loopback URLs locally through its preview proxy. Without a
 * prepared connection the answer is still yes, so a tab never falls back to this computer.
 */
export function needsRemotePreviewProxy(environmentId: EnvironmentId): boolean {
  if (!isElectron || remoteProxyBridge() === null) return false;
  const target = readPreparedConnection(environmentId)?.target;
  return target === undefined || !reachesEnvironmentLoopback(target);
}

/** The environment port a loopback preview URL needs, or null for any other URL. */
export function remotePreviewPort(rawUrl: string): number | null {
  try {
    const url = new URL(rawUrl);
    if (remotePreviewProxyDialHost(url.hostname) === null) return null;
    if (url.port) return Number(url.port);
    if (url.protocol === "http:" || url.protocol === "ws:") return 80;
    if (url.protocol === "https:" || url.protocol === "wss:") return 443;
    return null;
  } catch {
    return null;
  }
}

const generations = new Map<EnvironmentId, number>();
const generationOf = (environmentId: EnvironmentId) => generations.get(environmentId) ?? 0;

const pending = new Map<EnvironmentId, Promise<DesktopRemotePreviewProxyStatus | null>>();
/** Ports the user opened per environment, so a failed approval can finish after reconnecting. */
const wanted = new Map<EnvironmentId, Set<number>>();
const waitingForConnection = new Map<EnvironmentId, () => void>();

const issueAndConfigure = async (
  bridge: DesktopRemotePreviewProxyBridge,
  environmentId: EnvironmentId,
  ports: ReadonlyArray<number>,
  generation: number,
): Promise<DesktopRemotePreviewProxyStatus | null> => {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error(`Environment ${environmentId} is not connected.`);
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.issueProxyGrant,
    { environmentId, input: { ports: [...ports] } },
    { reportFailure: false },
  );
  if (generationOf(environmentId) !== generation) return null;
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return bridge.configure({
    environmentId,
    label: connection.label,
    httpBaseUrl: connection.httpBaseUrl,
    grant: result.value.grant,
    expiresAt: DateTime.toEpochMillis(result.value.expiresAt),
    ports: result.value.ports,
  });
};

/** Retries on the next transition to connected; a still-connected failure waits for a reconnect. */
const retryWhenConnected = (environmentId: EnvironmentId) => {
  if (waitingForConnection.has(environmentId)) return;
  const presentationAtom = environmentPresentations.presentationAtom(environmentId);
  let connected = appAtomRegistry.get(presentationAtom)?.connection.phase === "connected";
  const unsubscribe = appAtomRegistry.subscribe(presentationAtom, (presentation) => {
    const now = presentation?.connection.phase === "connected";
    const reconnected = now && !connected;
    connected = now;
    if (!reconnected) return;
    waitingForConnection.get(environmentId)?.();
    waitingForConnection.delete(environmentId);
    void approveRemotePreviewPorts(environmentId, [], { refresh: true }).catch(() => undefined);
  });
  waitingForConnection.set(environmentId, unsubscribe);
};

/** Adds ports to the environment's approved set, issuing a fresh grant only when needed. */
export function approveRemotePreviewPorts(
  environmentId: EnvironmentId,
  ports: ReadonlyArray<number>,
  options: { readonly refresh?: boolean } = {},
): Promise<DesktopRemotePreviewProxyStatus | null> {
  const bridge = remoteProxyBridge();
  if (bridge === null) return Promise.resolve(null);
  const generation = generationOf(environmentId);
  const wantedPorts = wanted.get(environmentId) ?? new Set<number>();
  for (const port of ports) wantedPorts.add(port);
  wanted.set(environmentId, wantedPorts);
  const previous = pending.get(environmentId) ?? Promise.resolve(null);
  const next = previous
    .catch(() => null)
    .then(async () => {
      if (generationOf(environmentId) !== generation) return null;
      const status = await bridge.getStatus(environmentId);
      if (generationOf(environmentId) !== generation) return null;
      const approved = new Set(status?.ports ?? []);
      const all = new Set([...approved, ...wantedPorts]);
      if (all.size === 0) return status ?? null;
      if (
        status?.state === "ready" &&
        options.refresh !== true &&
        [...all].every((port) => approved.has(port))
      ) {
        return status;
      }
      return issueAndConfigure(bridge, environmentId, [...all], generation);
    });
  pending.set(environmentId, next);
  void next.then(
    () => {
      if (pending.get(environmentId) === next) pending.delete(environmentId);
    },
    () => {
      if (pending.get(environmentId) === next) pending.delete(environmentId);
      if (generationOf(environmentId) === generation) retryWhenConnected(environmentId);
    },
  );
  return next;
}

/** Approves the port a user-chosen loopback URL needs before the desktop navigates to it. */
export async function approveRemotePreviewUrl(
  environmentId: EnvironmentId,
  url: string,
): Promise<void> {
  if (!needsRemotePreviewProxy(environmentId)) return;
  const port = remotePreviewPort(url);
  if (port === null) return;
  await approveRemotePreviewPorts(environmentId, [port]);
}

/** Turns off this environment's preview access until the user opens a remote URL again. */
export async function revokeRemotePreview(environmentId: EnvironmentId): Promise<void> {
  generations.set(environmentId, generationOf(environmentId) + 1);
  pending.delete(environmentId);
  wanted.delete(environmentId);
  waitingForConnection.get(environmentId)?.();
  waitingForConnection.delete(environmentId);
  await remoteProxyBridge()?.revoke(environmentId);
}

/**
 * Re-issues a grant that lapsed while its environment was unreachable. Renewal itself runs in the
 * desktop; a revoked proxy stays off until the user opens a remote URL again.
 */
export function startRemotePreviewProxyMaintenance(): () => void {
  const bridge = remoteProxyBridge();
  if (bridge === null) return () => {};
  let disposed = false;
  const reconcile = (status: DesktopRemotePreviewProxyStatus) => {
    if (disposed) return;
    if (status.state !== "expired") return;
    void approveRemotePreviewPorts(status.environmentId, status.ports, { refresh: true }).catch(
      () => undefined,
    );
  };
  const unsubscribe = bridge.onStatus(reconcile);
  const initialGenerations = new Map(generations);
  void bridge
    .getStatuses()
    .then((statuses) => {
      for (const status of statuses) {
        if (
          generationOf(status.environmentId) === (initialGenerations.get(status.environmentId) ?? 0)
        )
          reconcile(status);
      }
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unsubscribe();
    for (const dispose of waitingForConnection.values()) dispose();
    waitingForConnection.clear();
  };
}
