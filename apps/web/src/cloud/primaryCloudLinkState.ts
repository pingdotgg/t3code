import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";
import { useCallback, useEffect, useMemo } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPrimaryCloudLinkState, type CloudLinkTarget } from "./linkEnvironment";

const primaryCloudLinkAtomRuntime = Atom.runtime(
  Layer.effect(
    HttpClient.HttpClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, HttpClient.HttpClient)),
    ),
  ),
);

const primaryCloudLinkStateAtom = Atom.family((key: string) => {
  const target = JSON.parse(key) as CloudLinkTarget;
  return primaryCloudLinkAtomRuntime
    .atom(readPrimaryCloudLinkState({ target }))
    .pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`primary-cloud-link:${target.environmentId}`),
    );
});

const EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentCloudLinkStateResult | null>(null),
).pipe(Atom.keepAlive, Atom.withLabel("primary-cloud-link:null"));

function targetKey(target: CloudLinkTarget): string {
  return JSON.stringify(target);
}

export function refreshPrimaryCloudLinkState(target: CloudLinkTarget | null): void {
  if (target) {
    appAtomRegistry.refresh(primaryCloudLinkStateAtom(targetKey(target)));
  }
}

// Older environment servers predate the managedTunnelActive field; for them a
// link always implies a managed tunnel, so fall back to `linked`.
export function resolveManagedTunnelActive(
  state: Pick<EnvironmentCloudLinkStateResult, "managedTunnelActive" | "linked"> | null | undefined,
): boolean {
  return state?.managedTunnelActive ?? state?.linked ?? false;
}

// Startup reconcile applies relay config after routes are already live. The
// first link-state read can cache `managedTunnelActive: false`; a short
// bounded series of refreshes replaces that once reconcile has had a chance
// to finish. Delays are from first settlement, then we stop.
export const STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS = [2_000, 5_000, 10_000] as const;
export const CONNECTIONS_CLOUD_LINK_RETRY_INTERVAL_MS = 2_000;
export const CONNECTIONS_CLOUD_LINK_RETRY_BUDGET_MS = 15_000;

const scheduledStartupReconcileRefreshKeys = new Set<string>();
const pendingStartupReconcileRefreshTimers = new Map<
  string,
  Array<ReturnType<typeof setTimeout>>
>();

export function shouldContinueConnectionsCloudLinkRetry(
  elapsedMs: number,
  managedTunnelActive: boolean,
): boolean {
  return !managedTunnelActive && elapsedMs < CONNECTIONS_CLOUD_LINK_RETRY_BUDGET_MS;
}

export function scheduleStartupReconcileLinkStateRefresh(
  target: CloudLinkTarget | null,
  refresh: (target: CloudLinkTarget | null) => void = refreshPrimaryCloudLinkState,
): boolean {
  if (!target) {
    return false;
  }
  const key = targetKey(target);
  if (scheduledStartupReconcileRefreshKeys.has(key)) {
    return false;
  }
  scheduledStartupReconcileRefreshKeys.add(key);
  pendingStartupReconcileRefreshTimers.set(
    key,
    STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS.map((delayMs) =>
      setTimeout(() => {
        refresh(target);
      }, delayMs),
    ),
  );
  return true;
}

export function stopStartupReconcileLinkStateRefresh(target: CloudLinkTarget | null): void {
  if (!target) {
    return;
  }
  const key = targetKey(target);
  scheduledStartupReconcileRefreshKeys.add(key);
  const timers = pendingStartupReconcileRefreshTimers.get(key);
  if (!timers) {
    return;
  }
  for (const timer of timers) {
    clearTimeout(timer);
  }
  pendingStartupReconcileRefreshTimers.delete(key);
}

export function __resetStartupCloudLinkRefreshForTests(): void {
  for (const timers of pendingStartupReconcileRefreshTimers.values()) {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
  pendingStartupReconcileRefreshTimers.clear();
  scheduledStartupReconcileRefreshKeys.clear();
}

export function usePrimaryCloudLinkState() {
  const primary = usePrimaryEnvironment();
  const target = useMemo(
    () =>
      primary?.entry.target._tag === "PrimaryConnectionTarget"
        ? {
            environmentId: primary.environmentId,
            label: primary.label,
            httpBaseUrl: primary.entry.target.httpBaseUrl,
            wsBaseUrl: primary.entry.target.wsBaseUrl,
          }
        : null,
    [primary],
  );
  const atom = target
    ? primaryCloudLinkStateAtom(targetKey(target))
    : EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM;
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    refreshPrimaryCloudLinkState(target);
  }, [target]);
  const settled = result._tag === "Success" || result._tag === "Failure";
  const data = Option.getOrNull(AsyncResult.value(result));
  const managedTunnelActive = resolveManagedTunnelActive(data);
  useEffect(() => {
    if (!target) {
      return;
    }
    if (managedTunnelActive) {
      stopStartupReconcileLinkStateRefresh(target);
      return;
    }
    if (!settled) {
      return;
    }
    scheduleStartupReconcileLinkStateRefresh(target);
  }, [managedTunnelActive, settled, target]);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read T3 Connect link state.";
  }

  return {
    data,
    error,
    isPending: result.waiting,
    refresh,
    target,
  };
}
