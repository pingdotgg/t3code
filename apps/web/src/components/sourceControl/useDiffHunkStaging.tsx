/**
 * Hunk staging inside the EXISTING diff view (§5.5).
 *
 * t3's diff stack is materially better than a second, panel-local viewer, so
 * selecting a file in the changes list opens it in the diff right-panel surface
 * and this hook adds the per-hunk actions there. Everything the surface needs
 * lives behind one hook so `DiffPanel.tsx` — upstream, and used well outside
 * this feature — keeps a handful of lines rather than a feature.
 *
 * Two invariants worth stating:
 *
 *  1. **The rendered patch is the patch we cut hunks from.** The diff comes from
 *     `workingCopy.diff` for exactly one file and one side of the index, so
 *     cluster index N is rendered hunk N. The panel's other scopes cannot be
 *     used for this: "Working tree" is `git diff HEAD`, which mixes the staged
 *     and unstaged sides, and a hunk cut from it would not apply `--cached`.
 *  2. **Nothing here re-lays-out the diff.** The action cluster rides an
 *     annotation whose id is derived from the file key and the hunk index, so
 *     busy state and results move through the React portal only.
 *
 * fork: f4 hunk staging
 */
import { useAtomValue } from "@effect/atom-react";
import { workingCopyRevisionAtom } from "@t3tools/client-runtime/state/working-copy";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isNewFileDiff } from "~/lib/sourceControl/diffPatch";
import { confirmDiscardHunk } from "~/lib/sourceControl/safetyLadder";
import {
  deriveHunkClusters,
  hunkActionsForSide,
  hunkApplyFlags,
  type HunkAction,
  type HunkCluster,
  type HunkSide,
} from "~/lib/sourceControl/hunkActions";
import { useEnvironmentQuery } from "~/state/query";
import { workingCopyEnvironment } from "~/state/workingCopy";

import { HunkActionCluster } from "./HunkActionCluster";
import { SourceControlConfirmDialog } from "./SourceControlConfirmDialog";
import { useSourceControlConfirm } from "./useSourceControlConfirm";
import { useWorkingCopyActions } from "./useWorkingCopy";

/**
 * fork: f4 - two file-scoped diff sources share this hook.
 *
 * `working-copy` is the stageable one (one file, one side of the index) and is
 * the only one that grows hunk clusters. `commit` is the History drawer's
 * per-file diff: same single-file surface, `workingCopy.commitFileDiff` as the
 * source, and NO actions - a landed commit has no index side to stage to.
 */
export type DiffHunkStagingSelection =
  | {
      readonly kind: "working-copy";
      readonly side: HunkSide;
      readonly filePath: string;
      readonly oldPath: string | null;
    }
  | {
      readonly kind: "commit";
      readonly hash: string;
      readonly shortHash: string;
      readonly filePath: string;
      readonly oldPath: string | null;
    };

export interface DiffHunkStagingView {
  /** True only when a working-copy file diff is the current selection. */
  readonly active: boolean;
  readonly patch: string | undefined;
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  /** Scope label for the panel header, e.g. `foo.ts · staged`. */
  readonly label: string;
  readonly sectionId: string;
  readonly clusters: ReadonlyArray<HunkCluster>;
  /**
   * fork: f4 F-19 — the in-flight state, as a string the caller can feed into
   * the annotation entry so the viewer's `version` hash actually changes.
   *
   * The clusters ride the annotation channel, whose items are memoised on a
   * hash of `id:rangeLabel:text`. For a hunk entry all three were constant by
   * construction, so the pending spinner and the disabled state could never
   * reach the DOM: the buttons looked completely dead for the whole action.
   */
  readonly pendingKey: string;
  /** Rendered into the diff view's annotation slot for one hunk. */
  readonly renderCluster: (fileKey: string, hunkIndex: number) => ReactNode;
  /** The safety ladder's dialog for `Discard hunk` — the one rung left here. */
  readonly confirmDialog: ReactNode;
}

const NO_CLUSTERS: ReadonlyArray<HunkCluster> = [];

export function useDiffHunkStaging(target: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly selection: DiffHunkStagingSelection | null;
  /**
   * Called once when the side the user is looking at runs out of hunks because
   * of an action they just took — the stage→side-flip reconciliation. Never
   * fires for a side that was already empty when it was opened, and never
   * fires twice for the same side, so it cannot ping-pong on a clean file.
   */
  readonly onSideExhausted?: (nextSide: HunkSide) => void;
}): DiffHunkStagingView {
  const { cwd, environmentId, selection } = target;
  const resolved = useMemo(
    () =>
      environmentId !== null && cwd !== null && selection !== null
        ? { environmentId, cwd, selection }
        : null,
    [cwd, environmentId, selection],
  );
  const active = resolved !== null;

  const scope = useMemo(
    () => (resolved === null ? null : { environmentId: resolved.environmentId, cwd: resolved.cwd }),
    [resolved],
  );
  const confirm = useSourceControlConfirm();
  const actions = useWorkingCopyActions(scope, confirm.confirm);

  const diffQuery = useEnvironmentQuery(
    resolved === null
      ? null
      : resolved.selection.kind === "commit"
        ? workingCopyEnvironment.commitFileDiff({
            environmentId: resolved.environmentId,
            input: {
              cwd: resolved.cwd,
              hash: resolved.selection.hash,
              path: resolved.selection.filePath,
              ...(resolved.selection.oldPath ? { oldPath: resolved.selection.oldPath } : {}),
            },
          })
        : workingCopyEnvironment.diff({
            environmentId: resolved.environmentId,
            input: {
              cwd: resolved.cwd,
              path: resolved.selection.filePath,
              staged: resolved.selection.side === "staged",
              ...(resolved.selection.oldPath ? { oldPath: resolved.selection.oldPath } : {}),
            },
          }),
  );
  const { refresh } = diffQuery;

  const [pending, setPending] = useState<{
    readonly index: number;
    readonly action: HunkAction;
    /** Held while the safety-ladder dialog is open, before the RPC starts. */
    readonly confirming: boolean;
  } | null>(null);

  /**
   * fork: f4 invalidation Gap A — the per-file diff is read straight from an
   * atom here, so staging done ANYWHERE else (a row's ⊕ in the changes list, a
   * terminal, an agent) left this surface rendering the old patch, with hunk
   * clusters that would now fail to apply. The revision atom exists for exactly
   * this; it is bumped by every `workingCopy.*` mutation's `onSettled`.
   */
  const revision = useAtomValue(
    resolved === null
      ? EMPTY_WORKING_COPY_REVISION_ATOM
      : workingCopyRevisionAtom({ environmentId: resolved.environmentId, cwd: resolved.cwd }),
  );
  const seenRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    if (resolved === null) {
      seenRevisionRef.current = null;
      return;
    }
    if (seenRevisionRef.current === null) {
      seenRevisionRef.current = revision;
      return;
    }
    if (seenRevisionRef.current === revision) return;
    seenRevisionRef.current = revision;
    refresh();
  }, [refresh, resolved, revision]);

  const patch = diffQuery.data?.patch;
  // A truncated patch can end mid-hunk, and `buildHunkPatch` recomputes the
  // `@@` counts from the body it was given — so the final hunk of a truncated
  // diff would apply a partial change silently. No clusters at all is the only
  // honest answer; the existing truncation banner already explains why.
  const truncated = diffQuery.data?.truncated === true;
  const resolvedSelection = resolved?.selection ?? null;
  const stageable = resolvedSelection !== null && resolvedSelection.kind === "working-copy";
  const side: HunkSide =
    resolvedSelection?.kind === "working-copy" ? resolvedSelection.side : "unstaged";
  const filePath = resolvedSelection?.filePath ?? "";
  const clusters = useMemo(() => {
    if (!stageable || !patch || !filePath || truncated) return NO_CLUSTERS;
    // An untracked file has no index entry, so `git apply --cached` for one of
    // its hunks can only fail. Whole-file Stage in the changes list is the
    // correct affordance there, so offer no hunk actions at all rather than
    // buttons that always error.
    if (side === "unstaged" && isNewFileDiff(patch)) return NO_CLUSTERS;
    return deriveHunkClusters(patch, filePath);
  }, [filePath, patch, side, stageable, truncated]);

  const availableActions = useMemo(() => hunkActionsForSide(side), [side]);

  // Side-flip reconciliation. `acted` is what keeps this from firing for a side
  // that was empty on arrival, and `flipped` is what keeps it from firing twice.
  const actedRef = useRef(false);
  const flippedRef = useRef<string | null>(null);
  const onSideExhausted = target.onSideExhausted;
  const selectionKey = `${stageable ? side : "commit"}:${filePath}`;
  useEffect(() => {
    actedRef.current = false;
  }, [selectionKey]);
  useEffect(() => {
    if (!stageable) return;
    if (!actedRef.current || diffQuery.isPending || patch === undefined) return;
    if (patch.trim().length > 0) return;
    if (flippedRef.current === selectionKey) return;
    flippedRef.current = selectionKey;
    actedRef.current = false;
    onSideExhausted?.(side === "staged" ? "unstaged" : "staged");
  }, [diffQuery.isPending, onSideExhausted, patch, selectionKey, side, stageable]);

  const runAction = useCallback(
    (action: HunkAction, cluster: HunkCluster) => {
      if (pending !== null) return;
      // fork: f4 F-20 — claim the cluster BEFORE the confirm. `setPending` used
      // to happen after the await, so every button stayed live for the whole
      // dialog and a second Discard press opened a second confirm that
      // cancelled the first — the first action then returned silently.
      setPending({ index: cluster.index, action, confirming: action === "discard" });
      void (async () => {
        try {
          // Discard is the only hunk rung below file granularity, so it cannot
          // be backed by the pathspec stash and is the only one that still asks.
          if (action === "discard") {
            const outcome = await confirm.confirm(confirmDiscardHunk(filePath));
            if (outcome !== "confirmed") return;
            setPending({ index: cluster.index, action, confirming: false });
          }
          const applied = await actions.applyPatch(cluster.patch, hunkApplyFlags(action));
          if (applied) actedRef.current = true;
          // `applyPatch` invalidates status and bumps the working-copy revision,
          // but the per-file diff atom is read straight here, so it re-reads
          // explicitly. Refreshing on failure too keeps a rejected patch from
          // leaving a stale view behind.
          refresh();
        } finally {
          setPending(null);
        }
      })();
    },
    [actions, confirm, filePath, pending, refresh],
  );

  const clustersByIndex = useMemo(() => {
    const byIndex = new Map<number, HunkCluster>();
    for (const cluster of clusters) byIndex.set(cluster.index, cluster);
    return byIndex;
  }, [clusters]);

  const renderCluster = useCallback(
    (_fileKey: string, hunkIndex: number): ReactNode => {
      const cluster = clustersByIndex.get(hunkIndex);
      if (!cluster) return null;
      return (
        <HunkActionCluster
          cluster={cluster}
          side={side}
          actions={availableActions}
          pendingAction={pending?.index === hunkIndex ? pending.action : null}
          disabled={pending !== null}
          onAction={runAction}
        />
      );
    },
    [availableActions, clustersByIndex, pending, runAction, side],
  );

  const confirmDialog = (
    <SourceControlConfirmDialog pending={confirm.pending} onResolve={confirm.resolve} />
  );

  return {
    active,
    patch,
    truncated,
    isPending: diffQuery.isPending,
    error: diffQuery.error,
    label: !active
      ? ""
      : resolvedSelection?.kind === "commit"
        ? `${fileName(filePath)} · ${resolvedSelection.shortHash}`
        : `${fileName(filePath)} · ${side === "staged" ? "staged" : "unstaged"}`,
    sectionId: !active
      ? "working-copy"
      : resolvedSelection?.kind === "commit"
        ? `commit:${resolvedSelection.hash}:${filePath}`
        : `working-copy:${side}:${filePath}`,
    clusters,
    // fork: f4 F-19 — feeds the annotation entry so the viewer's item version
    // changes when an action starts and again when it settles.
    pendingKey: pending === null ? "" : `${pending.index}:${pending.action}:${pending.confirming}`,
    renderCluster,
    confirmDialog,
  };
}

/**
 * A stable placeholder so the revision hook can be called unconditionally.
 * Never read for a real repository.
 */
const EMPTY_WORKING_COPY_REVISION_ATOM = workingCopyRevisionAtom({
  environmentId: "__none__" as never,
  cwd: "",
});

function fileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}
