import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentSession } from "./remote-runtime-types";

const environmentSessions = new Map<EnvironmentId, EnvironmentSession>();
const environmentConnectionListeners = new Set<() => void>();

export function getEnvironmentSession(environmentId: EnvironmentId): EnvironmentSession | null {
  return environmentSessions.get(environmentId) ?? null;
}

export function getEnvironmentClient(environmentId: EnvironmentId) {
  return getEnvironmentSession(environmentId)?.client ?? null;
}

export function setEnvironmentSession(
  environmentId: EnvironmentId,
  session: EnvironmentSession,
): void {
  environmentSessions.set(environmentId, session);
}

export function removeEnvironmentSession(environmentId: EnvironmentId): EnvironmentSession | null {
  const session = getEnvironmentSession(environmentId);
  environmentSessions.delete(environmentId);
  return session;
}

export function drainEnvironmentSessions(): ReadonlyArray<EnvironmentSession> {
  const sessions = [...environmentSessions.values()];
  environmentSessions.clear();
  return sessions;
}

export function notifyEnvironmentConnectionListeners() {
  for (const listener of environmentConnectionListeners) listener();
}

/**
 * Subscribe to environment-connection changes (connect / disconnect / reconnect).
 * Returns an unsubscribe function.
 */
export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}
