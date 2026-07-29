import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ThreadId,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useMemo } from "react";

import {
  readEnvironmentThreadRefs,
  readThreadShell,
  useThreadShell,
  useThreadShells,
} from "./state/entities";

/** Threads without a worktree share the project's workspace-root checkout. */
const LOCAL_CHECKOUT_SEGMENT = "local";
const CANONICAL_OWNER_STORAGE_KEY = "t3code:worktree-canonical-owners:v1";

let canonicalOwnerThreadIdByScopeKey: Map<string, string> | null = null;

function normalizeWorktreePath(worktreePath: string | null | undefined): string | null {
  return worktreePath && worktreePath.length > 0 ? worktreePath : null;
}

function readCanonicalOwners(): Map<string, string> {
  if (canonicalOwnerThreadIdByScopeKey !== null) {
    return canonicalOwnerThreadIdByScopeKey;
  }
  const owners = new Map<string, string>();
  if (typeof window !== "undefined") {
    try {
      const serialized = window.localStorage.getItem(CANONICAL_OWNER_STORAGE_KEY);
      if (serialized !== null) {
        const parsed: unknown = JSON.parse(serialized);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [scopeKey, threadId] of Object.entries(parsed)) {
            if (typeof threadId === "string" && threadId.length > 0) {
              owners.set(scopeKey, threadId);
            }
          }
        }
      }
    } catch {
      // Corrupt or unavailable storage should only reset canonical ownership.
    }
  }
  canonicalOwnerThreadIdByScopeKey = owners;
  return owners;
}

function persistCanonicalOwners(owners: ReadonlyMap<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CANONICAL_OWNER_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(owners)),
    );
  } catch {
    // Resource ownership still remains stable for this renderer session.
  }
}

function rememberCanonicalOwner(scopeKey: string, threadId: string): string {
  const owners = readCanonicalOwners();
  const existing = owners.get(scopeKey);
  if (existing !== undefined) return existing;
  owners.set(scopeKey, threadId);
  persistCanonicalOwners(owners);
  return threadId;
}

/** Identity of the checkout a thread runs in. There is no server-side worktree
    entity, so this key is composed client-side: threads with the same key share
    a working directory (either a git worktree or the project workspace root). */
export function worktreeScopeKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  worktreePath: string | null | undefined,
): string {
  return `${environmentId}:${projectId}:${normalizeWorktreePath(worktreePath) ?? LOCAL_CHECKOUT_SEGMENT}`;
}

export function threadWorktreeScopeKey(
  shell: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "worktreePath">,
): string {
  return worktreeScopeKey(shell.environmentId, shell.projectId, shell.worktreePath);
}

/** Worktree scope key for a thread ref, falling back to the plain scoped thread
    key when the shell is unknown (drafts, shells not yet bootstrapped) so state
    degrades to thread-scoped instead of colliding. */
export function resolveWorktreeScopeKeyForThreadRef(ref: ScopedThreadRef): string {
  const shell = readThreadShell(ref);
  return shell === null ? scopedThreadKey(ref) : threadWorktreeScopeKey(shell);
}

export function worktreeStateKeysForThreadRef(ref: ScopedThreadRef): {
  primaryKey: string;
  fallbackKey: string;
} {
  return {
    primaryKey: resolveWorktreeScopeKeyForThreadRef(ref),
    fallbackKey: scopedThreadKey(ref),
  };
}

export function readWorktreeScopedRecordValue<T>(
  record: Readonly<Record<string, T>>,
  ref: ScopedThreadRef,
): T | undefined {
  const { primaryKey, fallbackKey } = worktreeStateKeysForThreadRef(ref);
  return record[primaryKey] ?? record[fallbackKey];
}

export function migrateWorktreeScopedRecord<T>(
  record: Record<string, T>,
  ref: ScopedThreadRef,
): { key: string; record: Record<string, T> } {
  const { primaryKey, fallbackKey } = worktreeStateKeysForThreadRef(ref);
  return migrateWorktreeScopedRecordKeys(record, primaryKey, fallbackKey);
}

export function migrateWorktreeScopedRecordKeys<T>(
  record: Record<string, T>,
  primaryKey: string,
  fallbackKey: string,
): { key: string; record: Record<string, T> } {
  if (primaryKey === fallbackKey || record[fallbackKey] === undefined) {
    return { key: primaryKey, record };
  }
  const fallbackValue = record[fallbackKey]!;
  const { [fallbackKey]: _fallback, ...remaining } = record;
  return {
    key: primaryKey,
    record: { ...remaining, [primaryKey]: fallbackValue },
  };
}

function compareCanonicalCandidates(
  left: Pick<EnvironmentThreadShell, "createdAt" | "id">,
  right: Pick<EnvironmentThreadShell, "createdAt" | "id">,
): number {
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)) {
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
  } else if (Number.isFinite(leftCreatedAt)) {
    return -1;
  } else if (Number.isFinite(rightCreatedAt)) {
    return 1;
  }
  return left.id.localeCompare(right.id);
}

export function selectStableCanonicalThreadId(
  candidates: ReadonlyArray<Pick<EnvironmentThreadShell, "createdAt" | "id">>,
  rememberedThreadId?: string,
): string | null {
  if (rememberedThreadId !== undefined) return rememberedThreadId;
  return candidates.toSorted(compareCanonicalCandidates)[0]?.id ?? null;
}

function selectCanonicalShell(
  ref: ScopedThreadRef,
  shell: EnvironmentThreadShell | null,
  candidates: Iterable<EnvironmentThreadShell | null>,
): ScopedThreadRef {
  if (shell === null) {
    return ref;
  }
  const scopeKey = threadWorktreeScopeKey(shell);
  const rememberedThreadId = readCanonicalOwners().get(scopeKey);
  if (rememberedThreadId !== undefined) {
    return scopeThreadRef(ref.environmentId, ThreadId.make(rememberedThreadId));
  }
  // Archived threads stay eligible on purpose: the canonical ref must not
  // shift (orphaning the worktree's terminal/preview sessions) just because
  // the oldest thread was archived while siblings remain.
  const matchingCandidates: EnvironmentThreadShell[] = [];
  for (const candidate of candidates) {
    if (candidate === null || candidate.environmentId !== ref.environmentId) {
      continue;
    }
    if (threadWorktreeScopeKey(candidate) !== scopeKey) {
      continue;
    }
    matchingCandidates.push(candidate);
  }
  const selectedThreadId = selectStableCanonicalThreadId(matchingCandidates) ?? shell.id;
  const ownerThreadId = rememberCanonicalOwner(scopeKey, selectedThreadId);
  return scopeThreadRef(shell.environmentId, ThreadId.make(ownerThreadId));
}

/** Stable thread ref used to scope wire calls (terminal/preview RPCs) for a
    worktree: the oldest thread that ever ran in the checkout. Server sessions
    stay keyed by threadId, so every thread in a worktree must agree on the
    thread id it uses for those calls. */
export function resolveWorktreeCanonicalThreadRef(ref: ScopedThreadRef): ScopedThreadRef {
  const shell = readThreadShell(ref);
  if (shell === null) {
    return ref;
  }
  return selectCanonicalShell(
    ref,
    shell,
    readEnvironmentThreadRefs(ref.environmentId).map((candidateRef) =>
      readThreadShell(candidateRef),
    ),
  );
}

/** Canonical wire-call thread ref for every worktree scope key present in
    `shells`. Bulk twin of resolveWorktreeCanonicalThreadRef for callers that
    need to resolve many scope keys reactively (e.g. mounted terminal
    drawers). */
export function worktreeCanonicalThreadRefsByScopeKey(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): Map<string, ScopedThreadRef> {
  const bestByKey = new Map<string, EnvironmentThreadShell>();
  for (const shell of shells) {
    const key = threadWorktreeScopeKey(shell);
    const existing = bestByKey.get(key);
    if (existing === undefined || compareCanonicalCandidates(shell, existing) < 0) {
      bestByKey.set(key, shell);
    }
  }
  return new Map(
    [...bestByKey].map(([key, shell]) => [
      key,
      scopeThreadRef(shell.environmentId, ThreadId.make(rememberCanonicalOwner(key, shell.id))),
    ]),
  );
}

export function forgetWorktreeCanonicalOwner(ref: ScopedThreadRef): void {
  const shell = readThreadShell(ref);
  if (shell === null) return;
  forgetWorktreeCanonicalOwnerByScopeKey(threadWorktreeScopeKey(shell));
}

export function forgetWorktreeCanonicalOwnerByScopeKey(scopeKey: string): void {
  const owners = readCanonicalOwners();
  if (!owners.delete(scopeKey)) return;
  persistCanonicalOwners(owners);
}

/** Reactive twin of resolveWorktreeScopeKeyForThreadRef. */
export function useWorktreeScopeKeyForThreadRef(ref: ScopedThreadRef | null): string | null {
  const shell = useThreadShell(ref);
  if (ref === null) {
    return null;
  }
  return shell === null ? scopedThreadKey(ref) : threadWorktreeScopeKey(shell);
}

/** Reactive twin of resolveWorktreeCanonicalThreadRef. */
export function useWorktreeCanonicalThreadRef(ref: ScopedThreadRef | null): ScopedThreadRef | null {
  const shell = useThreadShell(ref);
  const shells = useThreadShells();
  return useMemo(() => {
    if (ref === null) {
      return null;
    }
    return selectCanonicalShell(ref, shell, shells);
  }, [ref, shell, shells]);
}
