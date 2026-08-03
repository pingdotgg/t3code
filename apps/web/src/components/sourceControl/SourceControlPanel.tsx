/**
 * The source-control right-panel surface.
 *
 * Scoping: thread-scoped like every other surface, so the panel automatically
 * follows the thread's worktree (`gitCwd` is already derived per thread). The
 * ONE exception is the commit draft, which `sourceControlStore` keys by cwd —
 * see the note there; it is not an oversight.
 *
 * Refresh: server push + post-mutation re-read + a slow visible-only poll. No
 * timer runs while the panel is hidden, and nothing here animates continuously.
 *
 * fork: f4 source-control panel
 */
import type { EnvironmentId, WorkingCopyFile, WorkingCopyLogEntry } from "@t3tools/contracts";
import type { HistoryFilter } from "@t3tools/client-runtime/state/working-copy-logic";
import { AlertCircle, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { confirmResetHard, confirmRevertMerge } from "~/lib/sourceControl/safetyLadder";
import { busyPathsFromKeys } from "./sourceControlPanel.logic";
import type { ChangesStatusFilter } from "~/lib/sourceControl/changesRows";
import { DiffPanelShell, type DiffPanelMode } from "~/components/DiffPanelShell";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useGitStackedAction, useVcsPullAction } from "~/state/sourceControlActions";
import { vcsEnvironment } from "~/state/vcs";
import { workingCopyEnvironment } from "~/state/workingCopy";
import {
  DEFAULT_SOURCE_CONTROL_PREFS,
  selectSourceControlPrefs,
  useSourceControlStore,
} from "~/sourceControlStore";

import { ChangesList } from "./ChangesList";
import { CommitComposer } from "./CommitComposer";
import { ConflictsSection } from "./ConflictsSection";
import { HistoryList } from "./HistoryList";
import { SourceControlConfirmDialog } from "./SourceControlConfirmDialog";
import { SourceControlHeader } from "./SourceControlHeader";
import { StashesSection } from "./StashesSection";
import { useSourceControlConfirm } from "./useSourceControlConfirm";
import {
  useWorkingCopyActions,
  useWorkingCopyStatus,
  type SourceControlScope,
} from "./useWorkingCopy";
import { useWorkingCopyHistory } from "./useWorkingCopyHistory";

const EMPTY_FILTER: HistoryFilter = { query: "", author: "" };

export interface SourceControlPanelProps {
  readonly mode: DiffPanelMode;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  /** `scopedThreadKey(ref)` — the persistence scope for view preferences. */
  readonly scopeKey: string;
  readonly repoLabel: string;
  readonly visible: boolean;
  readonly onOpenDiff?: (file: WorkingCopyFile) => void;
  /**
   * fork: f4 — a file inside an expanded History commit. Same diff surface as
   * `onOpenDiff`, read-only side (`workingCopy.commitFileDiff`).
   */
  readonly onOpenCommitFile?: (file: {
    readonly hash: string;
    readonly shortHash: string;
    readonly path: string;
    readonly oldPath?: string | undefined;
  }) => void;
}

export function SourceControlPanel(props: SourceControlPanelProps) {
  const scope: SourceControlScope | null = useMemo(
    () => (props.cwd === null ? null : { environmentId: props.environmentId, cwd: props.cwd }),
    [props.cwd, props.environmentId],
  );

  const prefs = useSourceControlStore((state) =>
    selectSourceControlPrefs(state.prefsByScope, props.scopeKey),
  );
  const setPrefs = useSourceControlStore((state) => state.setPrefs);
  const toggleCollapsedGroup = useSourceControlStore((state) => state.toggleCollapsedGroup);
  const toggleCollapsedFolder = useSourceControlStore((state) => state.toggleCollapsedFolder);
  const setCollapsedFolders = useSourceControlStore((state) => state.setCollapsedFolders);
  const commitDraft = useSourceControlStore((state) =>
    props.cwd === null ? "" : (state.commitDraftByCwd[props.cwd] ?? ""),
  );
  const setCommitDraft = useSourceControlStore((state) => state.setCommitDraft);
  const clearCommitDraft = useSourceControlStore((state) => state.clearCommitDraft);

  const confirm = useSourceControlConfirm();
  const actions = useWorkingCopyActions(scope, confirm.confirm);
  const status = useWorkingCopyStatus(scope, {
    visible: props.visible,
    busy: actions.busy.size > 0,
  });

  const [pathQuery, setPathQuery] = useState("");
  const [amend, setAmend] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>(EMPTY_FILTER);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  const files = status.status?.files ?? [];
  const stagedCount = files.filter((file) => file.area === "staged").length;
  const dirtyCount = files.length;
  const conflicted = files.filter((file) => file.area === "conflicted");
  const operation = status.status?.operationInProgress ?? null;

  // Stashes and backups load on expand and are never polled.
  const stashQuery = useEnvironmentQuery(
    scope && prefs.stashesOpen
      ? workingCopyEnvironment.stashList({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const backupQuery = useEnvironmentQuery(
    scope && prefs.stashesOpen
      ? workingCopyEnvironment.discardBackups({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const lastCommitQuery = useEnvironmentQuery(
    scope
      ? workingCopyEnvironment.lastCommitMessage({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );

  const history = useWorkingCopyHistory(scope, historyFilter, {
    enabled: props.visible && prefs.activeSection === "history",
  });
  const commitDetailQuery = useEnvironmentQuery(
    scope && expandedHash
      ? workingCopyEnvironment.commitDetail({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd, hash: expandedHash },
        })
      : null,
  );

  // Sync reuses the EXISTING remote machinery — hook progress stream,
  // default-branch guard and PR wiring included. No new remote RPCs.
  const stacked = useGitStackedAction({ environmentId: props.environmentId, cwd: props.cwd });
  const pull = useVcsPullAction({ environmentId: props.environmentId, cwd: props.cwd });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus);

  const handleSync = useCallback(
    (kind: "publish" | "push" | "pull" | "sync" | "fetch") => {
      if (props.cwd === null) return;
      switch (kind) {
        case "pull":
          void pull.run();
          return;
        case "push":
        case "publish":
          void stacked.run({ actionId: `source-control-${kind}`, action: "push" });
          return;
        case "sync":
          // Pull first, and push only if the pull landed — pushing over a
          // behind branch is what produces the "rejected, fetch first" wall.
          void (async () => {
            const pulled = await pull.run();
            if (pulled._tag !== "Failure") {
              await stacked.run({ actionId: "source-control-sync", action: "push" });
            }
          })();
          return;
        case "fetch":
          void refreshVcsStatus({
            environmentId: props.environmentId,
            input: { cwd: props.cwd },
          });
          status.refresh();
          return;
      }
    },
    [props.cwd, props.environmentId, pull, refreshVcsStatus, stacked, status],
  );

  const copyText = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  const handleCommit = useCallback(
    async (options: { stageAllFirst: boolean }) => {
      const committed = await actions.commit(commitDraft, options);
      if (committed && props.cwd !== null) {
        clearCommitDraft(props.cwd);
        setAmend(false);
      }
      return committed;
    },
    [actions, clearCommitDraft, commitDraft, props.cwd],
  );

  const handleReset = useCallback(
    async (entry: WorkingCopyLogEntry, resetMode: "soft" | "mixed" | "hard") => {
      if (resetMode === "hard") {
        const outcome = await confirm.confirm(confirmResetHard(entry.hash, dirtyCount > 0));
        if (outcome !== "confirmed") return;
      }
      await actions.resetToCommit(entry.hash, resetMode);
    },
    [actions, confirm, dirtyCount],
  );

  const handleRevert = useCallback(
    async (entry: WorkingCopyLogEntry) => {
      if (entry.parents.length > 1) {
        const outcome = await confirm.confirm(confirmRevertMerge(entry.hash));
        if (outcome !== "confirmed") return;
        await actions.revertCommit(entry.hash, 1);
        return;
      }
      await actions.revertCommit(entry.hash);
    },
    [actions, confirm],
  );

  const [stashDialogOpen, setStashDialogOpen] = useState(false);

  // fork: f4 — per-row spinners were plumbed all the way into `ChangeRow` but
  // fed a module-level empty set, so a slow stage showed no row feedback at all.
  const busyPaths = useMemo(() => busyPathsFromKeys(actions.busy), [actions.busy]);

  if (props.cwd === null) {
    return (
      <DiffPanelShell mode={props.mode} header={<span className="text-sm">Source control</span>}>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
          Open a project to use source control.
        </div>
      </DiffPanelShell>
    );
  }

  if (status.status !== null && !status.status.isRepo) {
    return (
      <DiffPanelShell mode={props.mode} header={<span className="text-sm">Source control</span>}>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
          This folder is not a git repository.
        </div>
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell
      mode={props.mode}
      header={
        <SourceControlHeader
          status={status.status}
          repoLabel={props.repoLabel}
          syncBusy={stacked.isPending || pull.isPending}
          dirtyCount={dirtyCount}
          onSync={handleSync}
          onRefresh={status.refresh}
          onUndoLastCommit={() => void actions.undoLastCommit()}
          onDiscardAll={() => void actions.discard(null)}
          onOpenStashDialog={() => setStashDialogOpen(true)}
          onShowBackups={() => setPrefs(props.scopeKey, { stashesOpen: true })}
        />
      }
    >
      {status.showErrorBanner ? (
        <div className="flex flex-none items-start gap-2 border-border/60 border-b bg-destructive/8 px-2 py-1.5 text-xs">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground" />
          <span className="min-w-0 flex-1 break-words">
            {status.errorMessage ?? "The working copy could not be read."}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded-sm p-0.5 hover:bg-muted"
            onClick={status.dismissErrorBanner}
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      <div className="flex flex-none items-center gap-1 border-border/60 border-b px-2 py-1">
        <TabButton
          active={prefs.activeSection === "changes"}
          onClick={() => setPrefs(props.scopeKey, { activeSection: "changes" })}
        >
          Changes
          {dirtyCount > 0 ? (
            <span className="ml-1 rounded-sm bg-muted px-1 text-[10px]">{dirtyCount}</span>
          ) : null}
        </TabButton>
        <TabButton
          active={prefs.activeSection === "history"}
          onClick={() => setPrefs(props.scopeKey, { activeSection: "history" })}
        >
          History
        </TabButton>
        {prefs.activeSection === "changes" ? (
          <div className="ml-auto flex items-center gap-1">
            <Input
              value={pathQuery}
              onChange={(event) => setPathQuery(event.target.value)}
              placeholder="Filter files"
              aria-label="Filter changed files"
              className="h-6 w-28 text-xs"
            />
            <select
              aria-label="Status filter"
              className="h-6 rounded-md border border-input bg-transparent px-1 text-xs"
              value={prefs.filter}
              onChange={(event) =>
                setPrefs(props.scopeKey, {
                  filter: event.target.value as ChangesStatusFilter,
                })
              }
            >
              <option value="all">All</option>
              <option value="modified">Modified</option>
              <option value="added">Added</option>
              <option value="deleted">Deleted</option>
              <option value="renamed">Renamed</option>
              <option value="untracked">Untracked</option>
            </select>
            <button
              type="button"
              className="h-6 rounded-md px-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
              onClick={() =>
                setPrefs(props.scopeKey, {
                  viewMode: prefs.viewMode === "flat" ? "tree" : "flat",
                })
              }
            >
              {prefs.viewMode === "flat" ? "Tree" : "Flat"}
            </button>
          </div>
        ) : null}
      </div>

      {prefs.activeSection === "changes" ? (
        <>
          <CommitComposer
            message={commitDraft}
            onMessageChange={(message) => setCommitDraft(props.cwd ?? "", message)}
            amend={amend}
            onAmendChange={setAmend}
            lastCommitMessage={lastCommitQuery.data?.message ?? null}
            stagedCount={stagedCount}
            dirtyCount={dirtyCount}
            ahead={status.status?.ahead ?? 0}
            operationInProgress={operation !== null}
            busy={actions.busy.has("commit")}
            onCommit={(options) => void handleCommit(options)}
            onAmend={() => {
              void (async () => {
                const ok = await actions.amend(commitDraft);
                if (ok && props.cwd !== null) {
                  clearCommitDraft(props.cwd);
                  setAmend(false);
                }
              })();
            }}
            onPush={() => handleSync("push")}
            onCommitAndPush={(options) => {
              void (async () => {
                if (await handleCommit(options)) handleSync("push");
              })();
            }}
          />
          {operation !== null ? (
            <ConflictsSection
              operation={operation}
              files={conflicted}
              busy={actions.busy.size > 0}
              onResolve={(path, side) => void actions.resolveConflict(path, side)}
              onOpen={(file) => props.onOpenDiff?.(file)}
              onAbort={() => void actions.abortOperation(operation)}
              // "Commit merge" is a plain commit of what git already staged
              // while resolving; it must never re-stage, or a deliberately
              // unstaged resolution would be swept in.
              onContinue={() => void handleCommit({ stageAllFirst: false })}
            />
          ) : null}
          <ChangesList
            files={files}
            viewMode={prefs.viewMode}
            filter={prefs.filter}
            query={pathQuery}
            collapsedGroups={prefs.collapsedGroups}
            collapsedFolders={prefs.collapsedFolders}
            busyPaths={busyPaths}
            onToggleGroup={(group) => toggleCollapsedGroup(props.scopeKey, group)}
            onToggleFolder={(folderKey) => toggleCollapsedFolder(props.scopeKey, folderKey)}
            onSetCollapsedFolders={(keys) => setCollapsedFolders(props.scopeKey, keys)}
            onStage={(paths) => void actions.stage(paths.length > 0 ? paths : allPaths(files))}
            onUnstage={(paths) =>
              void actions.unstage(paths.length > 0 ? paths : stagedPaths(files))
            }
            onDiscard={(paths) => void actions.discard(paths.length > 0 ? paths : null)}
            onResolve={(path, side) => void actions.resolveConflict(path, side)}
            onOpenDiff={(file) => props.onOpenDiff?.(file)}
          />
          <StashesSection
            open={prefs.stashesOpen}
            onToggle={() => setPrefs(props.scopeKey, { stashesOpen: !prefs.stashesOpen })}
            stashes={stashQuery.data ?? EMPTY_STASHES}
            backups={backupQuery.data ?? EMPTY_STASHES}
            isLoading={stashQuery.isPending || backupQuery.isPending}
            dirty={dirtyCount > 0}
            onStash={() => setStashDialogOpen(true)}
            onPopLatest={() => {
              const latest = stashQuery.data?.find((entry) => !entry.isDiscardBackup);
              if (latest) void actions.stashPop(latest.ref);
            }}
            onApply={(ref) => void actions.stashApply(ref)}
            onDrop={(ref, label) => void actions.stashDrop(ref, label)}
            onRestoreBackup={(ref) => void actions.restoreBackup(ref)}
          />
        </>
      ) : (
        <HistoryList
          history={history}
          filter={historyFilter}
          onFilterChange={setHistoryFilter}
          grouped={prefs.historyGrouped}
          onGroupedChange={(grouped) => setPrefs(props.scopeKey, { historyGrouped: grouped })}
          sort={prefs.historySort}
          onSortChange={(sort) => setPrefs(props.scopeKey, { historySort: sort })}
          density={prefs.historyDensity}
          onDensityChange={(density) => setPrefs(props.scopeKey, { historyDensity: density })}
          detached={status.status?.detached ?? false}
          dirty={dirtyCount > 0}
          commitDetail={commitDetailQuery.data}
          commitDetailLoading={commitDetailQuery.isPending}
          expandedHash={expandedHash}
          onExpandedHashChange={setExpandedHash}
          onCopy={copyText}
          onTag={(entry) => {
            const name = window.prompt(`Tag name for ${entry.shortHash}`);
            if (name && name.trim().length > 0) void actions.tagCommit(entry.hash, name.trim());
          }}
          onCherryPick={(entry) => void actions.cherryPick(entry.hash)}
          onCheckout={(entry) => void actions.checkoutCommit(entry.hash)}
          onReset={(entry, resetMode) => void handleReset(entry, resetMode)}
          onRevert={(entry) => void handleRevert(entry)}
          onOpenCommitFile={(hash, path, oldPath) => {
            const detail = commitDetailQuery.data;
            if (!hash) return;
            props.onOpenCommitFile?.({
              hash,
              shortHash: detail?.hash === hash ? detail.shortHash : hash.slice(0, 7),
              path,
              oldPath,
            });
          }}
        />
      )}

      <SourceControlConfirmDialog pending={confirm.pending} onResolve={confirm.resolve} />
      <StashDialog
        open={stashDialogOpen}
        onClose={() => setStashDialogOpen(false)}
        onSubmit={(message, includeUntracked) => {
          setStashDialogOpen(false);
          void actions.stashPush(message, includeUntracked);
        }}
      />
    </DiffPanelShell>
  );
}

const EMPTY_STASHES: ReadonlyArray<never> = [];

function allPaths(files: ReadonlyArray<WorkingCopyFile>): ReadonlyArray<string> {
  return [...new Set(files.filter((file) => file.area !== "staged").map((file) => file.path))];
}

function stagedPaths(files: ReadonlyArray<WorkingCopyFile>): ReadonlyArray<string> {
  return [...new Set(files.filter((file) => file.area === "staged").map((file) => file.path))];
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "flex h-6 items-center rounded-md px-2 text-xs",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * "Include untracked" defaults ON, contrary to git: a stash that silently
 * leaves new files behind is the single most surprising thing `git stash` does.
 */
function StashDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (message: string, includeUntracked: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  if (!props.open) return null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-3 shadow-lg">
        <h3 className="mb-2 font-medium text-sm">Stash changes</h3>
        <Input
          autoFocus
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Optional message"
          aria-label="Stash message"
        />
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(event) => setIncludeUntracked(event.target.checked)}
          />
          Include untracked files
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-2 py-1 text-primary-foreground text-xs"
            onClick={() => props.onSubmit(message, includeUntracked)}
          >
            Stash
          </button>
        </div>
      </div>
    </div>
  );
}

export { DEFAULT_SOURCE_CONTROL_PREFS };
