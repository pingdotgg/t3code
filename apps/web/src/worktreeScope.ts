import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import {
  parseWorktreeResourceThreadId,
  worktreeResourceThreadId,
} from "@t3tools/shared/worktreeResource";
import { useMemo } from "react";

import { useComposerDraftStore } from "./composerDraftStore";
import { readThreadShell, useThreadShell } from "./state/entities";

/** Threads without a worktree share the project's workspace-root checkout. */
const LOCAL_CHECKOUT_SEGMENT = "local";

function normalizeWorktreePath(worktreePath: string | null | undefined): string | null {
  return worktreePath && worktreePath.length > 0 ? worktreePath : null;
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
  // Synthetic worktree owner threads (wire-call canonical refs) have no shell
  // or draft; their checkout identity is encoded in the id itself. Parsing it
  // keeps state written via the canonical ref on the same key as state read
  // via sibling threads' shells.
  const resource = parseWorktreeResourceThreadId(ref.threadId);
  if (resource) {
    return worktreeScopeKey(ref.environmentId, resource.projectId, resource.worktreePath);
  }
  const shell = readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftThreadByRef(ref);
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
  const { [fallbackKey]: _fallback, ...remaining } = record;
  return {
    key: primaryKey,
    record:
      record[primaryKey] === undefined
        ? { ...remaining, [primaryKey]: record[fallbackKey]! }
        : remaining,
  };
}

function resolveCanonicalRef(
  ref: ScopedThreadRef,
  shell: Pick<EnvironmentThreadShell, "projectId" | "worktreePath"> | null,
): ScopedThreadRef {
  return shell === null
    ? ref
    : scopeThreadRef(
        ref.environmentId,
        worktreeResourceThreadId(shell.projectId, shell.worktreePath),
      );
}

/** Stable thread ref used to scope wire calls (terminal/preview RPCs) for a
    worktree. The synthetic owner is deterministic from project + checkout, so
    every client agrees even when conversations are archived or deleted. */
export function resolveWorktreeCanonicalThreadRef(ref: ScopedThreadRef): ScopedThreadRef {
  const shell = readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftThreadByRef(ref);
  return resolveCanonicalRef(ref, shell);
}

/** Canonical wire-call thread ref for every worktree scope key present in
    `shells`. Bulk twin of resolveWorktreeCanonicalThreadRef for callers that
    need to resolve many scope keys reactively (e.g. mounted terminal
    drawers). */
export function worktreeCanonicalThreadRefsByScopeKey(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): Map<string, ScopedThreadRef> {
  const refsByKey = new Map<string, ScopedThreadRef>();
  for (const shell of shells) {
    const key = threadWorktreeScopeKey(shell);
    if (!refsByKey.has(key)) {
      refsByKey.set(
        key,
        scopeThreadRef(
          shell.environmentId,
          worktreeResourceThreadId(shell.projectId, shell.worktreePath),
        ),
      );
    }
  }
  return refsByKey;
}

/**
 * Real thread refs used when mounted checkout-scoped UI still needs thread and
 * project metadata. Wire resources use the synthetic refs above, but those refs
 * intentionally have no matching thread shell.
 */
export function worktreeRepresentativeThreadRefsByScopeKey(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): Map<string, ScopedThreadRef> {
  const refsByKey = new Map<string, ScopedThreadRef>();
  for (const shell of shells) {
    const key = threadWorktreeScopeKey(shell);
    if (!refsByKey.has(key)) {
      refsByKey.set(key, scopeThreadRef(shell.environmentId, shell.id));
    }
  }
  return refsByKey;
}

/** Reactive twin of resolveWorktreeScopeKeyForThreadRef. */
export function useWorktreeScopeKeyForThreadRef(ref: ScopedThreadRef | null): string | null {
  const shell = useThreadShell(ref);
  const draft = useComposerDraftStore((state) =>
    ref === null ? null : state.getDraftThreadByRef(ref),
  );
  if (ref === null) {
    return null;
  }
  const resource = parseWorktreeResourceThreadId(ref.threadId);
  if (resource) {
    return worktreeScopeKey(ref.environmentId, resource.projectId, resource.worktreePath);
  }
  const scope = shell ?? draft;
  return scope === null ? scopedThreadKey(ref) : threadWorktreeScopeKey(scope);
}

/** Reactive twin of resolveWorktreeCanonicalThreadRef. */
export function useWorktreeCanonicalThreadRef(ref: ScopedThreadRef | null): ScopedThreadRef | null {
  const shell = useThreadShell(ref);
  const draft = useComposerDraftStore((state) =>
    ref === null ? null : state.getDraftThreadByRef(ref),
  );
  return useMemo(() => {
    if (ref === null) {
      return null;
    }
    return resolveCanonicalRef(ref, shell ?? draft);
  }, [draft, ref, shell]);
}
