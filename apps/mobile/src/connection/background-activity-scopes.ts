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
    } catch {
      // A failing observer must not corrupt retained-scope lifetime.
    }
  }
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
  const input = observation.input as { readonly cwd?: unknown };
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
