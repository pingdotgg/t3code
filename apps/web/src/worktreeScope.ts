import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  readEnvironmentThreadRefs,
  readThreadShell,
  useThreadShell,
  useThreadShells,
} from "./state/entities";

/** Threads without a worktree share the project's workspace-root checkout. */
const LOCAL_CHECKOUT_SEGMENT = "local";

function normalizeWorktreePath(worktreePath: string | null | undefined): string | null {
  const trimmed = worktreePath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
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

function compareCanonicalCandidates(
  left: EnvironmentThreadShell,
  right: EnvironmentThreadShell,
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

function selectCanonicalShell(
  ref: ScopedThreadRef,
  shell: EnvironmentThreadShell | null,
  candidates: Iterable<EnvironmentThreadShell | null>,
): ScopedThreadRef {
  if (shell === null) {
    return ref;
  }
  const scopeKey = threadWorktreeScopeKey(shell);
  // Archived threads stay eligible on purpose: the canonical ref must not
  // shift (orphaning the worktree's terminal/preview sessions) just because
  // the oldest thread was archived while siblings remain.
  let canonical: EnvironmentThreadShell | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate.environmentId !== ref.environmentId) {
      continue;
    }
    if (threadWorktreeScopeKey(candidate) !== scopeKey) {
      continue;
    }
    if (canonical === null || compareCanonicalCandidates(candidate, canonical) < 0) {
      canonical = candidate;
    }
  }
  return canonical === null ? ref : scopeThreadRef(canonical.environmentId, canonical.id);
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
    [...bestByKey].map(([key, shell]) => [key, scopeThreadRef(shell.environmentId, shell.id)]),
  );
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
