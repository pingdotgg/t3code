import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorktreeCleanupOutcome } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  HardDriveIcon,
  LoaderIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWorktreeStoragePreviews } from "../../lib/worktreeStorageState";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { vcsEnvironment } from "../../state/vcs";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  flattenWorktreeStoragePreviews,
  formatStorageByteCount,
  type ScopedWorktreeStorageEntry,
  sumWorktreeStorageBytes,
  worktreeStorageActivityRevision,
  worktreeStorageSelectionKey,
} from "./WorktreeStorageSettings.logic";

const WORKTREE_ACTIVITY_REFRESH_DELAY_MS = 150;

const STATUS_PRESENTATION = {
  active: { label: "Active", variant: "info" },
  clean: { label: "Clean", variant: "success" },
  dirty: { label: "Uncommitted changes", variant: "warning" },
} as const;

interface WorktreeProjectGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly faviconPath: string | null;
  readonly worktrees: ReadonlyArray<ScopedWorktreeStorageEntry>;
}

function groupWorktreesByProject(
  worktrees: ReadonlyArray<ScopedWorktreeStorageEntry>,
): ReadonlyArray<WorktreeProjectGroup> {
  const groups = new Map<string, WorktreeProjectGroup>();
  for (const worktree of worktrees) {
    const key = JSON.stringify([worktree.environmentId, worktree.projectId]);
    const current = groups.get(key);
    if (current) {
      groups.set(key, { ...current, worktrees: [...current.worktrees, worktree] });
      continue;
    }
    groups.set(key, {
      key,
      environmentId: worktree.environmentId,
      title: worktree.projectTitle,
      workspaceRoot: worktree.workspaceRoot,
      faviconPath: worktree.faviconPath,
      worktrees: [worktree],
    });
  }
  return [...groups.values()];
}

export function WorktreeStorageSettings({
  environmentIds,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const { previews, error, isLoading, refresh } = useWorktreeStoragePreviews(environmentIds);
  const threadShells = useThreadShells();
  const cleanupWorktrees = useAtomCommand(vcsEnvironment.cleanupWorktrees, {
    reportFailure: false,
  });
  const worktrees = useMemo(() => flattenWorktreeStoragePreviews(previews), [previews]);
  const groups = useMemo(() => groupWorktreesByProject(worktrees), [worktrees]);
  const cleanWorktrees = useMemo(
    () => worktrees.filter((worktree) => worktree.status === "clean"),
    [worktrees],
  );
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dirtyRemovalConfirmed, setDirtyRemovalConfirmed] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const activityRevision = useMemo(
    () => worktreeStorageActivityRevision(threadShells, environmentIds),
    [environmentIds, threadShells],
  );
  const previousActivityRevision = useRef(activityRevision);

  useEffect(() => {
    if (previousActivityRevision.current === activityRevision) return;
    previousActivityRevision.current = activityRevision;
    const refreshTimer = setTimeout(refresh, WORKTREE_ACTIVITY_REFRESH_DELAY_MS);
    return () => clearTimeout(refreshTimer);
  }, [activityRevision, refresh]);

  const selectedWorktrees = useMemo(
    () =>
      worktrees.filter(
        (worktree) =>
          worktree.status !== "active" && selectedKeys.has(worktreeStorageSelectionKey(worktree)),
      ),
    [selectedKeys, worktrees],
  );
  const selectedDirtyWorktrees = useMemo(
    () => selectedWorktrees.filter((worktree) => worktree.status === "dirty"),
    [selectedWorktrees],
  );
  const selectedSizeBytes = sumWorktreeStorageBytes(selectedWorktrees);
  const totalSizeBytes = previews.reduce((total, entry) => total + entry.preview.totalSizeBytes, 0);
  const safeSizeBytes = sumWorktreeStorageBytes(cleanWorktrees);

  useEffect(() => {
    const availableKeys = new Set(
      worktrees.filter((worktree) => worktree.status !== "active").map(worktreeStorageSelectionKey),
    );
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => availableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [worktrees]);

  const setWorktreeSelected = useCallback(
    (worktree: ScopedWorktreeStorageEntry, selected: boolean) => {
      const key = worktreeStorageSelectionKey(worktree);
      setSelectedKeys((current) => {
        const next = new Set(current);
        if (selected) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [],
  );

  const openCleanupPreview = useCallback((selection: ReadonlySet<string>) => {
    setSelectedKeys(selection);
    setDirtyRemovalConfirmed(false);
    setDialogOpen(true);
  }, []);

  const handleCleanup = useCallback(() => {
    if (
      selectedWorktrees.length === 0 ||
      (selectedDirtyWorktrees.length > 0 && !dirtyRemovalConfirmed)
    ) {
      return;
    }
    setIsRemoving(true);
    void (async () => {
      const groupedByEnvironment = new Map<EnvironmentId, ScopedWorktreeStorageEntry[]>();
      for (const worktree of selectedWorktrees) {
        const group = groupedByEnvironment.get(worktree.environmentId) ?? [];
        group.push(worktree);
        groupedByEnvironment.set(worktree.environmentId, group);
      }

      const outcomes: WorktreeCleanupOutcome[] = [];
      const failures: unknown[] = [];
      for (const [environmentId, environmentWorktrees] of groupedByEnvironment) {
        const result = await cleanupWorktrees({
          environmentId,
          input: {
            targets: environmentWorktrees.map(({ projectId, path }) => ({ projectId, path })),
            confirmedDirtyPaths: environmentWorktrees
              .filter((worktree) => worktree.status === "dirty")
              .map((worktree) => worktree.path),
          },
        });
        if (result._tag === "Success") {
          outcomes.push(...result.value.outcomes);
        } else if (!isAtomCommandInterrupted(result)) {
          failures.push(squashAtomCommandFailure(result));
        }
      }

      refresh();
      setSelectedKeys(new Set());
      setDialogOpen(false);
      setDirtyRemovalConfirmed(false);
      setIsRemoving(false);

      const removedCount = outcomes.filter((outcome) => outcome.status === "removed").length;
      const skippedCount = outcomes.length - removedCount;
      if (failures.length > 0 || outcomes.some((outcome) => outcome.status === "failed")) {
        const firstFailure = failures[0];
        toastManager.add({
          type: "error",
          title: "Worktree cleanup incomplete",
          description:
            firstFailure instanceof Error
              ? firstFailure.message
              : `${removedCount} removed; some worktrees could not be removed.`,
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: removedCount === 1 ? "Worktree removed" : `${removedCount} worktrees removed`,
        description:
          skippedCount === 0
            ? `Recovered about ${formatStorageByteCount(selectedSizeBytes)}. Branches and commits were preserved.`
            : `${skippedCount} changed since preview and were preserved.`,
      });
    })();
  }, [
    cleanupWorktrees,
    dirtyRemovalConfirmed,
    refresh,
    selectedDirtyWorktrees.length,
    selectedSizeBytes,
    selectedWorktrees,
  ]);

  return (
    <>
      <SettingsSection
        {...searchableSetting("worktree-storage")}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh worktree storage"
            disabled={isLoading}
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3.5", isLoading && "animate-spin")} />
          </Button>
        }
      >
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {isLoading && previews.length === 0 ? (
                <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              ) : (
                <HardDriveIcon className="size-3.5 text-muted-foreground" />
              )}
              {formatStorageByteCount(totalSizeBytes)} across {worktrees.length}{" "}
              {worktrees.length === 1 ? "worktree" : "worktrees"}
            </span>
          }
          description={
            error ??
            (worktrees.length === 0 && !isLoading
              ? "T3-managed worktrees will appear here. Nothing is removed automatically."
              : `${formatStorageByteCount(safeSizeBytes)} can be safely recovered from clean, inactive worktrees.`)
          }
          control={
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={selectedWorktrees.length === 0}
                onClick={() => openCleanupPreview(selectedKeys)}
              >
                Review selected ({selectedWorktrees.length})
              </Button>
              <Button
                size="sm"
                disabled={cleanWorktrees.length === 0}
                onClick={() =>
                  openCleanupPreview(new Set(cleanWorktrees.map(worktreeStorageSelectionKey)))
                }
              >
                <Trash2Icon className="size-3.5" />
                Clean all safe
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {groups.map((group) => (
        <SettingsSection
          key={group.key}
          title={group.title}
          icon={
            <ProjectFavicon
              environmentId={group.environmentId}
              cwd={group.workspaceRoot}
              faviconPath={group.faviconPath}
            />
          }
        >
          {group.worktrees.map((worktree) => {
            const status = STATUS_PRESENTATION[worktree.status];
            const selectionKey = worktreeStorageSelectionKey(worktree);
            const isActive = worktree.status === "active";
            return (
              <SettingsRow
                key={selectionKey}
                title={worktree.refName}
                description={worktree.path}
                control={
                  <div className="flex w-full items-center justify-between gap-3 sm:justify-end">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatStorageByteCount(worktree.sizeBytes)}
                    </span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <Checkbox
                      aria-label={`Select ${worktree.refName} for cleanup`}
                      checked={selectedKeys.has(selectionKey)}
                      disabled={isActive}
                      onCheckedChange={(checked) => setWorktreeSelected(worktree, checked === true)}
                    />
                  </div>
                }
              />
            );
          })}
        </SettingsSection>
      ))}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (isRemoving) return;
          setDialogOpen(open);
          if (!open) setDirtyRemovalConfirmed(false);
        }}
      >
        <DialogPopup className="max-w-xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Preview worktree cleanup</DialogTitle>
            <DialogDescription>
              Remove {selectedWorktrees.length}{" "}
              {selectedWorktrees.length === 1 ? "worktree" : "worktrees"} and recover about{" "}
              {formatStorageByteCount(selectedSizeBytes)}. Branches and commits remain untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="divide-y divide-border/60 rounded-xl border border-input">
              {selectedWorktrees.map((worktree) => (
                <div
                  key={worktreeStorageSelectionKey(worktree)}
                  className="flex items-start justify-between gap-4 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{worktree.refName}</div>
                    <div className="truncate text-xs text-muted-foreground">{worktree.path}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={STATUS_PRESENTATION[worktree.status].variant}>
                      {STATUS_PRESENTATION[worktree.status].label}
                    </Badge>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatStorageByteCount(worktree.sizeBytes)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {selectedDirtyWorktrees.length > 0 ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warning/30 bg-warning/8 p-3">
                <Checkbox
                  className="mt-0.5"
                  checked={dirtyRemovalConfirmed}
                  disabled={isRemoving}
                  onCheckedChange={(checked) => setDirtyRemovalConfirmed(checked === true)}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-warning-foreground">
                    <AlertTriangleIcon className="size-3.5" />
                    Delete uncommitted changes
                  </span>
                  <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                    I understand that {selectedDirtyWorktrees.length}{" "}
                    {selectedDirtyWorktrees.length === 1
                      ? "worktree contains"
                      : "worktrees contain"}{" "}
                    local changes that will be permanently deleted.
                  </span>
                </span>
              </label>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={isRemoving} onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                isRemoving ||
                selectedWorktrees.length === 0 ||
                (selectedDirtyWorktrees.length > 0 && !dirtyRemovalConfirmed)
              }
              onClick={handleCleanup}
            >
              {isRemoving ? <LoaderIcon className="animate-spin" /> : <Trash2Icon />}
              {isRemoving ? "Removing…" : "Remove worktrees"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
