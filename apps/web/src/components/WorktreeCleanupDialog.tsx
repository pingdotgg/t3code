import type { EnvironmentId, VcsManagedWorktree } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../environmentApi";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { invalidateSourceControlState } from "../lib/sourceControlActions";
import { selectThreadsForEnvironment, useStore } from "../store";
import {
  classifyManagedWorktrees,
  selectWorktreesForScope,
  type WorktreeThreadRef,
} from "../worktreeCleanup";
import {
  buildRemovalItems,
  type CleanupRowState,
  formatBytes,
  totalSelectedBytes,
} from "./WorktreeCleanupDialog.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface WorktreeCleanupDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  cwd: string;
  scope: "orphaned" | "orphaned-archived";
  onOpenChange: (open: boolean) => void;
}

type RowOverride = { selected?: boolean; force?: boolean };

const CLASSIFICATION_ORDER: Record<CleanupRowState["classification"], number> = {
  orphaned: 0,
  "archived-only": 1,
  active: 2,
};

export function WorktreeCleanupDialog({
  open,
  environmentId,
  cwd,
  scope,
  onOpenChange,
}: WorktreeCleanupDialogProps) {
  const [worktrees, setWorktrees] = useState<readonly VcsManagedWorktree[] | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [overrides, setOverrides] = useState<Record<string, RowOverride>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Assemble the full thread picture for this environment ourselves, so both
  // entry points (sidebar + archived panel) classify identically and archived
  // worktrees are never mistaken for orphaned ones.
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const liveThreads = useStore(
    useShallow((state) => selectThreadsForEnvironment(state, environmentId)),
  );
  const {
    snapshots: archivedSnapshots,
    isLoading: archivedLoading,
    error: archivedError,
  } = useArchivedThreadSnapshots(environmentIds);
  const threadRefs = useMemo<WorktreeThreadRef[]>(() => {
    const live = liveThreads.map((thread) => ({
      worktreePath: thread.worktreePath,
      isArchived: thread.archivedAt !== null,
    }));
    const archived = archivedSnapshots
      .filter((entry) => entry.environmentId === environmentId)
      .flatMap((entry) =>
        entry.snapshot.threads.map((thread) => ({
          worktreePath: thread.worktreePath,
          isArchived: true,
        })),
      );
    return [...live, ...archived];
  }, [liveThreads, archivedSnapshots, environmentId]);

  useEffect(() => {
    if (!open) {
      setWorktrees(null);
      setSizes({});
      setOverrides({});
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSizes({});
    setOverrides({});
    void (async () => {
      try {
        const api = ensureEnvironmentApi(environmentId);
        const result = await api.vcs.listManagedWorktrees({ cwd });
        if (cancelled) return;
        setWorktrees(result.worktrees);
        for (const worktree of result.worktrees) {
          void api.vcs
            .worktreeSize({ path: worktree.path })
            .then(({ sizeBytes }) => {
              if (cancelled) return;
              setSizes((current) => ({ ...current, [worktree.path]: sizeBytes }));
            })
            .catch(() => {
              /* leave size unknown => shown as "…", excluded from total */
            });
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load worktrees.";
        setLoadError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not load worktrees",
            description: message,
          }),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, environmentId, cwd]);

  // Derived rows: classify every managed worktree, default-select per scope, then
  // apply the user's manual overrides (preserved across thread-store updates).
  const rows = useMemo<CleanupRowState[]>(() => {
    if (!worktrees) return [];
    const classified = classifyManagedWorktrees(worktrees, threadRefs);
    const inScope = new Set(
      selectWorktreesForScope(classified, scope).map((entry) => entry.worktree.path),
    );
    return classified
      .map((entry) => {
        const path = entry.worktree.path;
        const isDirty = entry.worktree.isDirty;
        const defaultSelected =
          entry.classification !== "active" && inScope.has(path) && !isDirty;
        const override = overrides[path];
        return {
          path,
          refName: entry.worktree.refName,
          classification: entry.classification,
          isDirty,
          selected: override?.selected ?? defaultSelected,
          force: override?.force ?? false,
          sizeBytes: sizes[path] ?? null,
        } satisfies CleanupRowState;
      })
      .sort(
        (a, b) =>
          CLASSIFICATION_ORDER[a.classification] - CLASSIFICATION_ORDER[b.classification],
      );
  }, [worktrees, threadRefs, scope, sizes, overrides]);

  const setRow = useCallback((path: string, patch: RowOverride) => {
    setOverrides((current) => ({ ...current, [path]: { ...current[path], ...patch } }));
  }, []);

  const handleConfirm = useCallback(async () => {
    const items = buildRemovalItems(rows);
    if (items.length === 0) {
      onOpenChange(false);
      return;
    }
    setRemoving(true);
    try {
      const api = ensureEnvironmentApi(environmentId);
      const { results } = await api.vcs.removeWorktrees({ cwd, items });
      await invalidateSourceControlState({ environmentId });
      const removed = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      const freed = removed.reduce((sum, result) => {
        const row = rows.find((candidate) => candidate.path === result.path);
        return sum + (row?.sizeBytes ?? 0);
      }, 0);
      toastManager.add(
        stackedThreadToast({
          type: failed.length > 0 ? "warning" : "success",
          title:
            failed.length > 0
              ? `Removed ${removed.length}, ${failed.length} failed`
              : `Removed ${removed.length} worktree${removed.length === 1 ? "" : "s"}`,
          description: `Freed ${formatBytes(freed)}.${
            failed.length > 0 ? ` Failed: ${failed.map((failure) => failure.path).join(", ")}` : ""
          }`,
        }),
      );
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove worktrees.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Worktree cleanup failed",
          description: message,
        }),
      );
    } finally {
      setRemoving(false);
    }
  }, [rows, environmentId, cwd, onOpenChange]);

  const total = totalSelectedBytes(rows);
  const removableCount = buildRemovalItems(rows).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Clean up worktrees</DialogTitle>
          <DialogDescription>
            Remove t3code-managed worktrees for this repository. Worktrees of active threads are
            shown but protected; dirty worktrees require an explicit force toggle.
          </DialogDescription>
        </DialogHeader>

        {loading || archivedLoading ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">Scanning worktrees…</p>
        ) : loadError ? (
          <p className="px-1 py-4 text-sm text-destructive">
            Could not load worktrees: {loadError}
          </p>
        ) : archivedError ? (
          <p className="px-1 py-4 text-sm text-destructive">
            Could not load archived threads, so worktrees cannot be safely classified:{" "}
            {archivedError}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">Nothing to clean up.</p>
        ) : (
          <ul className="flex flex-col gap-2 py-2">
            {rows.map((row) => {
              const isActive = row.classification === "active";
              return (
                <li
                  key={row.path}
                  className={`flex items-center gap-3 rounded-md border p-2${isActive ? " opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={isActive}
                    onChange={(event) => setRow(row.path, { selected: event.target.checked })}
                    aria-label={`Select ${row.refName}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{row.refName}</span>
                    <span className="truncate text-xs text-muted-foreground">{row.path}</span>
                  </div>
                  {isActive ? (
                    <span className="text-xs text-muted-foreground">protected</span>
                  ) : row.isDirty ? (
                    <label className="flex items-center gap-1 text-xs text-amber-600">
                      <input
                        type="checkbox"
                        checked={row.force}
                        onChange={(event) => setRow(row.path, { force: event.target.checked })}
                        aria-label={`Force remove ${row.refName}`}
                      />
                      force (dirty)
                    </label>
                  ) : null}
                  <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                    {row.sizeBytes === null ? "…" : formatBytes(row.sizeBytes)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <span className="mr-auto text-sm text-muted-foreground">
            Reclaimable: {formatBytes(total)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={removing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={
              removing ||
              loading ||
              archivedLoading ||
              archivedError !== null ||
              removableCount === 0
            }
          >
            {removing ? "Removing…" : `Remove ${removableCount}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
