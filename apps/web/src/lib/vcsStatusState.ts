import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { VcsStatusTarget } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { vcsEnvironment } from "../state/vcs";
import { buildRepoRootLabels } from "./repoRootLabels";

/* ─── Types ─────────────────────────────────────────────────────────── */

/**
 * Per-cwd VCS status as surfaced to the multi-repo UI. A thin wrapper over
 * main's `vcsEnvironment.status` subscription atom (an
 * `AsyncResult<VcsStatusResult>`), reshaped into the flat record the
 * multi-repo git control and chat view consume.
 */
export interface VcsStatusState {
  readonly targetKey: string | null;
  readonly data: VcsStatusResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * A workspace-level target: a set of repo roots (absolute paths) under one
 * environment. Used to fan VCS status out over the roots of a multi-repo
 * `.code-workspace` project and group the results per repo.
 */
interface VcsStatusGroupTarget {
  readonly environmentId: EnvironmentId | null;
  readonly repoRoots: ReadonlyArray<string> | null;
}

/** One repo root's status within a grouped (multi-repo) result. */
interface VcsStatusGroupEntry {
  readonly repoRoot: string;
  /** Display label for the root (its basename). */
  readonly displayName: string;
  readonly state: VcsStatusState;
}

/* ─── Constants ─────────────────────────────────────────────────────── */

const EMPTY_VCS_STATUS_STATE: VcsStatusState = Object.freeze({
  targetKey: null,
  data: null,
  error: null,
  isPending: false,
});

const EMPTY_VCS_STATUS_GROUP: ReadonlyArray<VcsStatusGroupEntry> = Object.freeze([]);

/* ─── Helpers ───────────────────────────────────────────────────────── */

const REPO_ROOT_KEY_SEPARATOR = "\0";

export function serializeVcsStatusRoots(roots: ReadonlyArray<string> | null): string {
  return roots?.join(REPO_ROOT_KEY_SEPARATOR) ?? "";
}

export function deserializeVcsStatusRoots(key: string): string[] {
  return key === "" ? [] : key.split(REPO_ROOT_KEY_SEPARATOR);
}

/** Reshape an `AsyncResult<VcsStatusResult>` into a flat {@link VcsStatusState}. */
function toVcsStatusState(
  targetKey: string,
  result: AsyncResult.AsyncResult<VcsStatusResult, unknown>,
): VcsStatusState {
  const data = Option.getOrNull(AsyncResult.value(result));
  const error =
    result._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(result.cause);
          return cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : "Failed to load git status.";
        })()
      : null;
  return { targetKey, data, error, isPending: result.waiting };
}

/* ─── Refresh (imperative) ──────────────────────────────────────────── */

/**
 * Trigger a one-shot `refreshStatus` RPC for a single target. The server-side
 * refresh pushes a new event onto the existing status subscription, so any
 * mounted {@link useVcsStatusGroups} subscriber picks it up automatically.
 */
export function refreshVcsStatus(target: VcsStatusTarget): void {
  if (target.environmentId === null || target.cwd === null) {
    return;
  }
  void runAtomCommand(
    appAtomRegistry,
    vcsEnvironment.refreshStatus,
    { environmentId: target.environmentId, input: { cwd: target.cwd } },
    { reportFailure: false },
  ).catch(() => undefined);
}

/** Trigger a one-shot refresh for every repo root in a group. */
export function refreshVcsStatusGroup(target: VcsStatusGroupTarget): void {
  if (target.environmentId === null || target.repoRoots === null) {
    return;
  }
  for (const cwd of target.repoRoots) {
    refreshVcsStatus({ environmentId: target.environmentId, cwd });
  }
}

/* ─── Reactive group hook ───────────────────────────────────────────── */

/**
 * Watch VCS status for every repo root of a (multi-repo) workspace and return
 * one grouped entry per root, in order. Each root subscribes via main's
 * per-cwd `vcsEnvironment.status` atom, so single-root behaviour is identical
 * to watching that cwd directly. The per-root atoms are combined into one
 * derived atom so a status change in any root re-renders the group.
 */
export function useVcsStatusGroups(
  target: VcsStatusGroupTarget,
): ReadonlyArray<VcsStatusGroupEntry> {
  const environmentId = target.environmentId;
  // Stable dependency for the roots: NUL cannot occur in filesystem paths.
  const rootsKey = serializeVcsStatusRoots(target.repoRoots);

  const roots = useMemo(
    () => (environmentId !== null ? deserializeVcsStatusRoots(rootsKey) : []),
    [environmentId, rootsKey],
  );
  const rootLabels = useMemo(() => buildRepoRootLabels(roots), [roots]);

  const statusAtoms = useMemo(
    () =>
      environmentId === null
        ? []
        : roots.map((cwd) => vcsEnvironment.status({ environmentId, input: { cwd } })),
    [environmentId, roots],
  );

  const groupAtom = useMemo(
    () =>
      Atom.make((get) => statusAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:vcs-status-group:${environmentId ?? "null"}:${rootsKey}`),
      ),
    [statusAtoms, environmentId, rootsKey],
  );

  const results = useAtomValue(groupAtom);

  return useMemo(() => {
    if (environmentId === null || roots.length === 0) {
      return EMPTY_VCS_STATUS_GROUP;
    }
    return roots.map((repoRoot, index) => {
      const result = results[index];
      const targetKey = `${environmentId}:${repoRoot}`;
      const state =
        result === undefined ? EMPTY_VCS_STATUS_STATE : toVcsStatusState(targetKey, result);
      return { repoRoot, displayName: rootLabels.get(repoRoot) ?? repoRoot, state };
    });
    // `results` identity drives recomputation; roots/environmentId stable per key.
  }, [environmentId, rootLabels, roots, results]);
}
