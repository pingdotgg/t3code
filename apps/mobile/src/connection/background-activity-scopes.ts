import type { EnvironmentRpcSubscriptionObservation } from "@t3tools/client-runtime/rpc";
import { type BackgroundScope, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

interface RetainedScope {
  readonly environmentId: EnvironmentId;
  readonly scope: BackgroundScope;
  refCount: number;
}

const retainedScopes = new Map<string, RetainedScope>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

const usageLimitsViews = new Map<EnvironmentId, number>();

/** Counts a usage limits view of these environments as on screen until the release runs. */
export function retainUsageLimitsView(environmentIds: ReadonlyArray<EnvironmentId>): () => void {
  for (const environmentId of environmentIds) {
    usageLimitsViews.set(environmentId, (usageLimitsViews.get(environmentId) ?? 0) + 1);
  }
  if (environmentIds.length > 0) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const environmentId of environmentIds) {
      const count = (usageLimitsViews.get(environmentId) ?? 1) - 1;
      if (count > 0) usageLimitsViews.set(environmentId, count);
      else usageLimitsViews.delete(environmentId);
    }
    if (environmentIds.length > 0) notify();
  };
}

export function isUsageLimitsViewRetained(environmentId: EnvironmentId): boolean {
  return usageLimitsViews.has(environmentId);
}

function stableScopeKey(environmentId: EnvironmentId, scope: BackgroundScope): string {
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return JSON.stringify([environmentId, scope.type]);
    case "provider-status":
      return JSON.stringify([environmentId, scope.type, scope.instanceId ?? null]);
    case "vcs-status":
    case "git-refs":
      return JSON.stringify([environmentId, scope.type, scope.cwd]);
    case "thread":
      return JSON.stringify([environmentId, scope.type, scope.threadId]);
  }
}

function scopeForSubscription(
  observation: EnvironmentRpcSubscriptionObservation,
): BackgroundScope | null {
  if (observation.method === WS_METHODS.subscribeResourceTelemetry) {
    return { type: "diagnostics" };
  }
  if (observation.method !== WS_METHODS.subscribeVcsStatus) {
    return null;
  }
  const input = observation.input as { readonly cwd?: unknown; readonly includeRemote?: unknown };
  if (input.includeRemote === false) return null;
  return typeof input.cwd === "string" ? { type: "vcs-status", cwd: input.cwd } : null;
}

export function retainedMobileBackgroundScopes(
  environmentId: EnvironmentId,
): ReadonlyArray<BackgroundScope> {
  return Array.from(retainedScopes.values(), (entry) =>
    entry.environmentId === environmentId ? entry.scope : null,
  ).filter((scope): scope is BackgroundScope => scope !== null);
}

export function observeMobileBackgroundActivitySubscription(
  observation: EnvironmentRpcSubscriptionObservation,
): Effect.Effect<Effect.Effect<void>> {
  const scope = scopeForSubscription(observation);
  if (scope === null) return Effect.succeed(Effect.void);
  return Effect.sync(() => {
    const environmentId = observation.environmentId as EnvironmentId;
    const key = stableScopeKey(environmentId, scope);
    const current = retainedScopes.get(key);
    if (current) {
      current.refCount += 1;
    } else {
      retainedScopes.set(key, { environmentId, scope, refCount: 1 });
      notify();
    }
    return Effect.sync(() => {
      const retained = retainedScopes.get(key);
      if (!retained) return;
      retained.refCount -= 1;
      if (retained.refCount <= 0) {
        retainedScopes.delete(key);
        notify();
      }
    });
  });
}

export function onRetainedMobileBackgroundScopesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
