import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

export const SERVER_UPDATE_PENDING_EXPIRY_MS = 12 * 60_000;

export interface PendingServerUpdate {
  readonly attempt: number;
  readonly targetVersion: string;
}

const pendingServerUpdatesAtom = Atom.make<
  Readonly<Record<string, PendingServerUpdate | undefined>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("server-update:pending"));

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let nextAttempt = 0;

function clearExpiryTimer(environmentId: EnvironmentId): void {
  const timer = expiryTimers.get(environmentId);
  if (timer === undefined) return;
  clearTimeout(timer);
  expiryTimers.delete(environmentId);
}

function armExpiry(environmentId: EnvironmentId, attempt: number): void {
  clearExpiryTimer(environmentId);
  expiryTimers.set(
    environmentId,
    setTimeout(() => {
      clearPendingServerUpdate(environmentId, attempt);
    }, SERVER_UPDATE_PENDING_EXPIRY_MS),
  );
}

export function beginPendingServerUpdate(
  environmentId: EnvironmentId,
  targetVersion: string,
): number {
  const attempt = ++nextAttempt;
  appAtomRegistry.set(pendingServerUpdatesAtom, {
    ...appAtomRegistry.get(pendingServerUpdatesAtom),
    [environmentId]: { attempt, targetVersion },
  });
  armExpiry(environmentId, attempt);
  return attempt;
}

export function markPendingServerUpdateRestartAccepted(
  environmentId: EnvironmentId,
  attempt: number,
): void {
  if (appAtomRegistry.get(pendingServerUpdatesAtom)[environmentId]?.attempt !== attempt) return;
  armExpiry(environmentId, attempt);
}

export function clearPendingServerUpdate(environmentId: EnvironmentId, attempt: number): void {
  const updates = appAtomRegistry.get(pendingServerUpdatesAtom);
  if (updates[environmentId]?.attempt !== attempt) return;

  clearExpiryTimer(environmentId);
  const next = { ...updates };
  delete next[environmentId];
  appAtomRegistry.set(pendingServerUpdatesAtom, next);
}

export function usePendingServerUpdate(
  environmentId: EnvironmentId | null,
): PendingServerUpdate | null {
  const updates = useAtomValue(pendingServerUpdatesAtom);
  return environmentId === null ? null : (updates[environmentId] ?? null);
}

export function getPendingServerUpdateForTests(
  environmentId: EnvironmentId,
): PendingServerUpdate | null {
  return appAtomRegistry.get(pendingServerUpdatesAtom)[environmentId] ?? null;
}

export function resetPendingServerUpdatesForTests(): void {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
  nextAttempt = 0;
  appAtomRegistry.set(pendingServerUpdatesAtom, {});
}
