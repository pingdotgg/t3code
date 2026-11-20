import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atomRegistry";

const SLOW_RPC_ACK_THRESHOLD_MS = 15_000;
/**
 * Updates wait for package installs; VCS refreshes may wait for background work and network calls.
 * Give these requests longer than the normal 15s warning threshold.
 */
const LONG_RUNNING_RPC_ACK_THRESHOLD_MS = 120_000;
const MAX_TRACKED_RPC_ACK_REQUESTS = 256;
let slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;

export interface SlowRpcAckRequest {
  readonly requestId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly tag: string;
  readonly thresholdMs: number;
}

interface PendingRpcAckRequest {
  readonly request: SlowRpcAckRequest;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRpcAckRequests = new Map<string, PendingRpcAckRequest>();
// Background reports nobody waits on. A busy host delays them first, and warning
// about a request the user never made does not say what is wrong. A sign-in wait
// lasts as long as the user takes on the forge.
const untrackedRpcAckMethods = new Set<string>([
  WS_METHODS.serverGetUsageSummary,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.sourceControlSignInWait,
]);
const longRunningRpcAckMethods = new Set<string>([
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.serverUpdateServer,
  WS_METHODS.vcsRefreshStatus,
]);

const slowRpcAckRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-ack-requests"),
);

function setSlowRpcAckRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  appAtomRegistry.set(slowRpcAckRequestsAtom, [...requests]);
}

function getSlowRpcAckRequestsValue(): ReadonlyArray<SlowRpcAckRequest> {
  return appAtomRegistry.get(slowRpcAckRequestsAtom);
}

function shouldTrackRpcAck(method: string): boolean {
  return (
    !method.includes("subscribe") &&
    !method.startsWith("pullRequests.") &&
    !untrackedRpcAckMethods.has(method)
  );
}

function rpcAckThresholdMs(method: string): number {
  return longRunningRpcAckMethods.has(method)
    ? Math.max(slowRpcAckThresholdMs, LONG_RUNNING_RPC_ACK_THRESHOLD_MS)
    : slowRpcAckThresholdMs;
}

export function trackRpcRequestSent(requestId: string, method: string, tag = method): void {
  if (!shouldTrackRpcAck(method)) {
    return;
  }

  clearTrackedRpcRequest(requestId);
  evictOldestPendingRpcRequestIfNeeded();

  const startedAtMs = Date.now();
  const thresholdMs = rpcAckThresholdMs(method);
  const request: SlowRpcAckRequest = {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag,
    thresholdMs,
  };
  const timeoutId = setTimeout(() => {
    pendingRpcAckRequests.delete(requestId);
    appendSlowRpcAckRequest(request);
  }, thresholdMs);

  pendingRpcAckRequests.set(requestId, {
    request,
    timeoutId,
  });
}

export function acknowledgeRpcRequest(requestId: string): void {
  clearTrackedRpcRequest(requestId);
  const slowRequests = getSlowRpcAckRequestsValue();
  if (!slowRequests.some((request) => request.requestId === requestId)) {
    return;
  }

  setSlowRpcAckRequests(slowRequests.filter((request) => request.requestId !== requestId));
}

function clearTrackedRpcRequest(requestId: string): void {
  const pending = pendingRpcAckRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRpcAckRequests.delete(requestId);
}

function appendSlowRpcAckRequest(request: SlowRpcAckRequest): void {
  const requests = [...getSlowRpcAckRequestsValue(), request];
  if (requests.length <= MAX_TRACKED_RPC_ACK_REQUESTS) {
    setSlowRpcAckRequests(requests);
    return;
  }

  setSlowRpcAckRequests(requests.slice(-MAX_TRACKED_RPC_ACK_REQUESTS));
}

function evictOldestPendingRpcRequestIfNeeded(): void {
  while (pendingRpcAckRequests.size >= MAX_TRACKED_RPC_ACK_REQUESTS) {
    const oldestRequestId = pendingRpcAckRequests.keys().next().value;
    if (oldestRequestId === undefined) {
      return;
    }

    clearTrackedRpcRequest(oldestRequestId);
  }
}

export function subscribeSlowRpcAckRequests(
  listener: (requests: ReadonlyArray<SlowRpcAckRequest>) => void,
): () => void {
  return appAtomRegistry.subscribe(slowRpcAckRequestsAtom, listener);
}
