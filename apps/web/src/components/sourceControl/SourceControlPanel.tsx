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
import { commitMessageGenerationApply } from "@t3tools/client-runtime/state/working-copy-logic";
import { useAtomValue } from "@effect/atom-react";
import { AlertCircle, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  confirmReplaceCommitDraft,
  confirmResetHard,
  confirmRevertMerge,
} from "~/lib/sourceControl/safetyLadder";
import {
  busyPathsFromKeys,
  changesListActionPaths,
  isTextGenerationConfigured,
  workingCopyBusyKey,
} from "./sourceControlPanel.logic";
import type { ChangesStatusFilter } from "~/lib/sourceControl/changesRows";
import { DiffPanelShell, type DiffPanelMode } from "~/components/DiffPanelShell";
import { Input } from "~/components/ui/input";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
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
  GENERATE_COMMIT_MESSAGE_BUSY_KEY,
  reportSourceControlFailure,
  sourceControlInfoToast,
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
  //
  // fork: f4 F-10 — the stash list is mounted whenever the panel is, not only
  // while the section is open: the collapsed header renders the count, and a
  // collapsed section that permanently reads "STASHES 0" is a lying state. One
  // `git stash list` with a 5 s stale time and a 60 s idle TTL is cheap. The
  // *backup* list stays load-on-expand — nothing outside the section reads it.
  const stashQuery = useEnvironmentQuery(
    scope
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

  // fork: f4 AI commit message — read from THIS environment's config, not the
  // primary server's: a remote environment runs generation on its own host with
  // its own settings and its own providers.
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const textGenerationConfigured = useMemo(
    () => isTextGenerationConfigured(serverConfig),
    [serverConfig],
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

  // fork: f4 F-02 — "Fetch" is a status/upstream re-read behind a server-side
  // TTL, not a `git fetch`. It gets its own pending flag so the press is at
  // least visibly acknowledged; the label is corrected in `syncState`.
  const [refreshingRemote, setRefreshingRemote] = useState(false);

  const handleSync = useCallback(
    (kind: "publish" | "push" | "pull" | "sync" | "fetch") => {
      if (props.cwd === null) return;
      switch (kind) {
        case "pull":
          // fork: f4 F-01 — the result used to be dropped on the floor, so a
          // rejected pull produced no toast, no banner and no console line.
          void (async () => {
            const pulled = await pull.run();
            if (pulled._tag === "Failure") reportSourceControlFailure("Could not pull", pulled);
          })();
          return;
        case "push":
        case "publish":
          void (async () => {
            const pushed = await stacked.run({
              actionId: `source-control-${kind}`,
              action: "push",
            });
            if (pushed._tag === "Failure") {
              reportSourceControlFailure(
                kind === "publish" ? "Could not publish the branch" : "Could not push",
                pushed,
              );
            }
          })();
          return;
        case "sync":
          // Pull first, and push only if the pull landed — pushing over a
          // behind branch is what produces the "rejected, fetch first" wall.
          void (async () => {
            const pulled = await pull.run();
            if (pulled._tag === "Failure") {
              // Saying only "could not pull" here would leave the user waiting
              // for a push that was deliberately skipped.
              reportSourceControlFailure(
                "Sync stopped — the pull failed, so nothing was pushed",
                pulled,
              );
              return;
            }
            const pushed = await stacked.run({ actionId: "source-control-sync", action: "push" });
            if (pushed._tag === "Failure") {
              reportSourceControlFailure("Sync pulled, but the push failed", pushed);
            }
          })();
          return;
        case "fetch":
          setRefreshingRemote(true);
          void (async () => {
            try {
              const refreshed = await refreshVcsStatus({
                environmentId: props.environmentId,
                input: { cwd: props.cwd ?? "" },
              });
              if (refreshed._tag === "Failure") {
                reportSourceControlFailure("Could not refresh from the remote", refreshed);
              }
              status.refresh();
            } finally {
              setRefreshingRemote(false);
            }
          })();
          return;
      }
    },
    [props.cwd, props.environmentId, pull, refreshVcsStatus, stacked, status],
  );

  /**
   * fork: f4 F-12 — `navigator.clipboard` is undefined outside a secure context
   * (plain http on a LAN IP), so the old `void navigator.clipboard?.writeText`
   * was a no-op that reported nothing. The repo's hook handles the failure; the
   * toasts here are what makes it visible either way.
   */
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "commit details",
    onCopy: (label) => sourceControlInfoToast(`Copied ${label}`),
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy to the clipboard",
          description:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "The clipboard is unavailable in this window.",
          timeout: 8_000,
        }),
      );
    },
  });
  const copyText = useCallback(
    (text: string, label = "to the clipboard") => {
      if (text.length === 0) return;
      copyToClipboard(text, label);
    },
    [copyToClipboard],
  );

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

  /**
   * fork: f4 AI commit message.
   *
   * The result **fills the editable draft** — it never commits, and it never
   * silently overwrites text the user wrote. Three outcomes, decided purely by
   * `commitMessageGenerationApply`:
   *   - empty draft → filled,
   *   - draft edited while the model was thinking → result dropped on the floor,
   *   - non-empty and untouched → one confirm before replacing.
   */
  const handleGenerateMessage = useCallback(() => {
    if (props.cwd === null) return;
    const cwd = props.cwd;
    const draftAtPress = commitDraft;
    void (async () => {
      const generated = await actions.generateCommitMessage({ amend });
      if (generated === null) return;
      const draftNow = useSourceControlStore.getState().commitDraftByCwd[cwd] ?? "";
      const decision = commitMessageGenerationApply({ draftAtPress, draftNow });
      if (decision === "discard") return;
      if (decision === "confirm") {
        const outcome = await confirm.confirm(confirmReplaceCommitDraft({ generated }));
        if (outcome !== "confirmed") return;
      }
      setCommitDraft(cwd, generated);
    })();
  }, [actions, amend, commitDraft, confirm, props.cwd, setCommitDraft]);

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
          syncBusy={stacked.isPending || pull.isPending || refreshingRemote}
          dirtyCount={dirtyCount}
          undoBusy={actions.isBusy(workingCopyBusyKey.undoCommit())}
          discardAllBusy={actions.isBusy(workingCopyBusyKey.discardAll())}
          stashBusy={actions.isBusy(workingCopyBusyKey.stashPush())}
          refreshBusy={status.isPending}
          onSync={handleSync}
          onRefresh={status.refresh}
          onUndoLastCommit={() => void actions.undoLastCommit()}
          onDiscardAll={() => void actions.discard(null)}
          onOpenStashDialog={() => setStashDialogOpen(true)}
          // fork: f4 F-05 — `stashesOpen` is only rendered inside the Changes
          // branch, so setting it from the History tab used to change a
          // persisted flag nobody could see. Switch the tab too.
          onShowBackups={() =>
            setPrefs(props.scopeKey, { activeSection: "changes", stashesOpen: true })
          }
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
            onGenerateMessage={handleGenerateMessage}
            generating={actions.busy.has(GENERATE_COMMIT_MESSAGE_BUSY_KEY)}
            textGenerationConfigured={textGenerationConfigured}
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
              busyPaths={busyPaths}
              abortBusy={actions.isBusy(workingCopyBusyKey.abort())}
              hasMessage={commitDraft.trim().length > 0}
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
            // fork: f4 F-08 — the changes list can only ever act on an explicit
            // path set. `[]` is "nothing", never "everything": the group
            // header's Discard all used to map onto `discard(null)`, which
            // discards the whole working copy.
            onStage={(paths) => {
              const target = changesListActionPaths(paths);
              if (target !== null) void actions.stage(target);
            }}
            onUnstage={(paths) => {
              const target = changesListActionPaths(paths);
              if (target !== null) void actions.unstage(target);
            }}
            onDiscard={(paths) => {
              const target = changesListActionPaths(paths);
              if (target !== null) void actions.discard(target);
            }}
            onResolve={(path, side) => void actions.resolveConflict(path, side)}
            onOpenDiff={(file) => props.onOpenDiff?.(file)}
            onEmptyKeyboardTarget={(action) =>
              sourceControlInfoToast(
                action === "stage"
                  ? "Select a file to stage — click a row, or press j / k."
                  : action === "unstage"
                    ? "Select a staged file to unstage."
                    : "Select an unstaged file to discard.",
              )
            }
          />
          <StashesSection
            open={prefs.stashesOpen}
            onToggle={() => setPrefs(props.scopeKey, { stashesOpen: !prefs.stashesOpen })}
            stashes={stashQuery.data ?? EMPTY_STASHES}
            backups={backupQuery.data ?? EMPTY_STASHES}
            // fork: f4 — `isLoading` is now "we have nothing to show yet".
            // `Atom.swr` reports `waiting` during EVERY revalidation, so the old
            // predicate flashed "Loading…" over already-rendered rows after
            // each mutation.
            isLoading={
              (stashQuery.isPending && stashQuery.data === null) ||
              (backupQuery.isPending && backupQuery.data === null)
            }
            // fork: f4 F-09 — Pop resolved the latest stash from a list that is
            // `null` during the first load and during every post-mutation
            // re-read, then fell through an `if` with no else. Disable it while
            // the list has not arrived instead.
            listReady={stashQuery.data !== null}
            isBusy={actions.isBusy}
            dirty={dirtyCount > 0}
            onStash={() => setStashDialogOpen(true)}
            onPopLatest={() => {
              const latest = stashQuery.data?.find((entry) => !entry.isDiscardBackup);
              if (!latest) {
                sourceControlInfoToast("There is no stash to pop.");
                return;
              }
              void actions.stashPop(latest.ref);
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
          isBusy={actions.isBusy}
          // fork: f4 F-13 — was `window.prompt`, which the Electron renderer
          // does not implement, so this menu item did nothing in the desktop
          // app and reported nothing on cancel in the browser.
          onTag={(entry) => {
            void (async () => {
              const name = await confirm.promptText({
                title: `Tag ${entry.shortHash}`,
                consequence: `Creates a lightweight tag pointing at ${entry.shortHash} — "${entry.subject}".`,
                inputLabel: "Tag name",
                placeholder: "v1.2.3",
                confirmLabel: "Create tag",
              });
              if (name === null) return;
              const trimmed = name.trim();
              if (trimmed.length === 0) return;
              await actions.tagCommit(entry.hash, trimmed);
            })();
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
      {/* fork: f4 F-17 — mounted only while open, so the previous message and
          the "include untracked" choice cannot leak into the next stash. */}
      {stashDialogOpen ? (
        <StashDialog
          onClose={() => setStashDialogOpen(false)}
          onSubmit={(message, includeUntracked) => {
            setStashDialogOpen(false);
            void actions.stashPush(message, includeUntracked);
          }}
        />
      ) : null}
    </DiffPanelShell>
  );
}

const EMPTY_STASHES: ReadonlyArray<never> = [];

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
  onClose: () => void;
  onSubmit: (message: string, includeUntracked: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Stash changes"
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
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
