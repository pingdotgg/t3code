/**
 * The source-control right-panel surface.
 *
 * Layout: compact VS Code-style source control, top to bottom —
 *
 *   A  repository toolbar — repo, branch, filter, graph, refresh, sync, more
 *   B  commit composer — message, options, full-width primary action
 *   C  optional filter row — hidden until requested or filtering is active
 *   D  one status slot — read error or operation in progress
 *   E  staged / conflicts / changes groups using all remaining height
 *
 * The panel used to stack six different left insets down its own height, put a
 * spread "something is wrong" across two places. The panel now keeps its
 * repository chrome stable while reads refresh in the background.
 *
 * Scoping: visibility is global, while the mounted panel receives the active
 * chat's environment and worktree. Switching chats keeps the panel open and
 * rebinds every query to the new project. Preferences and commit drafts are
 * repository-scoped so one project's state never leaks into another.
 *
 * Refresh: server push + post-mutation re-read + a slow visible-only poll. No
 * timer runs while the panel is hidden, and nothing here animates continuously.
 *
 * fork: f4 source-control panel
 */
import type { EnvironmentId, WorkingCopyFile, WorkingCopyLogEntry } from "@t3tools/contracts";
import type { HistoryFilter } from "@t3tools/client-runtime/state/working-copy-logic";
import {
  commitMessageGenerationApply,
  historyAuthorFacets,
} from "@t3tools/client-runtime/state/working-copy-logic";
import { useAtomValue } from "@effect/atom-react";
import { GitBranch, FolderGit2, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  confirmReplaceCommitDraft,
  confirmResetHard,
  confirmRevertMerge,
} from "~/lib/sourceControl/safetyLadder";
import {
  busyPathsFromKeys,
  changesListActionPaths,
  isTextGenerationConfigured,
  operationGuidance,
  sourceControlPrimarySlot,
  sourceControlPrimaryVariant,
  workingCopyBusyKey,
} from "./sourceControlPanel.logic";
import type { ChangesStatusFilter } from "~/lib/sourceControl/changesRows";
import { DiffPanelShell, type DiffPanelMode } from "~/components/DiffPanelShell";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
import { HistoryList } from "./HistoryList";
import { SourceControlConfirmDialog } from "./SourceControlConfirmDialog";
import { SourceControlHeader } from "./SourceControlHeader";
import { SourceControlStatusBand } from "./SourceControlStatusBand";
import { SourceControlViewMenu } from "./SourceControlViewMenu";
import { StashesPanel } from "./StashesSection";
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

const CHANGES_FILTER_LABEL: Record<ChangesStatusFilter, string> = {
  all: "All files",
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
};

export interface SourceControlPanelProps {
  readonly mode: DiffPanelMode;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  /** Environment + repository cwd — the persistence scope for view preferences. */
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

  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const [pathQuery, setPathQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [amend, setAmend] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>(EMPTY_FILTER);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  const files = status.status?.files ?? [];
  const stagedCount = files.filter((file) => file.area === "staged").length;
  const dirtyCount = files.length;
  const conflictedCount = files.filter((file) => file.area === "conflicted").length;
  const operation = status.status?.operationInProgress ?? null;
  const onChanges = prefs.activeSection === "changes";

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
  const authors = useMemo(() => historyAuthorFacets(history.page.entries), [history.page.entries]);
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

  /**
   * fork: f4 redesign — the panel's ONE primary action. `Publish` and `Commit`
   * used to be two full-strength primaries side by side; `Continue` could make
   * a third. Everything else steps down, and nothing disappears.
   */
  const primarySlot = sourceControlPrimarySlot({
    section: prefs.activeSection,
    operationInProgress: operation !== null,
    canContinueInPanel: operation !== null && operationGuidance(operation).canContinueInPanel,
    // The composer owns the same enablement rule; asking it here would need the
    // whole `commitPrimaryAction` ladder, so the cheap superset — "there is
    // something to commit and a message to commit it with" — is what decides
    // emphasis. The button's own `disabled` is still the authority on pressing.
    commitEnabled: commitDraft.trim().length > 0 && (dirtyCount > 0 || amend),
    syncEmphasis: (status.status?.ahead ?? 0) > 0 || (status.status?.behind ?? 0) > 0,
  });

  const filterActive = onChanges
    ? pathQuery.trim().length > 0 || prefs.filter !== "all"
    : history.filterActive;
  const showFilterRow = filterOpen || filterActive;

  const clearActiveFilter = useCallback(() => {
    if (onChanges) {
      setPathQuery("");
      setPrefs(props.scopeKey, { filter: "all" });
    } else {
      setHistoryFilter(EMPTY_FILTER);
    }
  }, [onChanges, props.scopeKey, setPrefs]);

  const handleToggleFilter = useCallback(() => {
    if (showFilterRow) {
      clearActiveFilter();
      setFilterOpen(false);
      return;
    }
    setFilterOpen(true);
  }, [clearActiveFilter, showFilterRow]);

  useEffect(() => {
    if (!filterOpen) return;
    const input = filterInputRef.current;
    input?.focus();
    input?.select();
  }, [filterOpen, onChanges]);

  /** `/` focuses the one filter box, from anywhere in the panel body. */
  const handleBodyKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!showFilterRow) {
        setFilterOpen(true);
        return;
      }
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    },
    [showFilterRow],
  );

  const sourceControlHeader = (
    <SourceControlHeader
      status={status.status}
      repoLabel={props.repoLabel}
      activeSection={prefs.activeSection}
      searchActive={showFilterRow}
      syncBusy={stacked.isPending || pull.isPending || refreshingRemote}
      dirtyCount={dirtyCount}
      undoBusy={actions.isBusy(workingCopyBusyKey.undoCommit())}
      discardAllBusy={actions.isBusy(workingCopyBusyKey.discardAll())}
      stashBusy={actions.isBusy(workingCopyBusyKey.stashPush())}
      refreshBusy={status.isPending}
      viewActions={
        <SourceControlViewMenu
          prefs={prefs}
          historyFilter={historyFilter}
          authors={authors}
          onPrefsChange={(patch) => setPrefs(props.scopeKey, patch)}
          onHistoryFilterChange={setHistoryFilter}
        />
      }
      onSelectSection={(activeSection) => {
        setPrefs(props.scopeKey, { activeSection });
        setFilterOpen(false);
      }}
      onToggleSearch={handleToggleFilter}
      onSync={handleSync}
      onRefresh={status.refresh}
      onUndoLastCommit={() => void actions.undoLastCommit()}
      onDiscardAll={() => void actions.discard(null)}
      onOpenStashDialog={() => setStashDialogOpen(true)}
      onOpenStashes={() => setPrefs(props.scopeKey, { stashesOpen: true })}
    />
  );

  const commitComposer = onChanges ? (
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
      primaryVariant={
        sourceControlPrimaryVariant(primarySlot, "commit") === "default" ? "default" : "secondary"
      }
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
  ) : null;

  if (props.cwd === null) {
    return (
      <DiffPanelShell mode={props.mode} header={<span className="text-sm">Source control</span>}>
        <Empty className="min-h-0 flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle className="text-base">No project open</EmptyTitle>
            <EmptyDescription className="text-xs">
              Open a project to stage, commit and browse its history.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </DiffPanelShell>
    );
  }

  if (status.status !== null && !status.status.isRepo) {
    return (
      <DiffPanelShell mode={props.mode} header={<span className="text-sm">Source control</span>}>
        <Empty className="min-h-0 flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranch />
            </EmptyMedia>
            <EmptyTitle className="text-base">Not a git repository</EmptyTitle>
            <EmptyDescription className="text-xs">
              This folder is not tracked by git, so there is nothing to show here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </DiffPanelShell>
    );
  }

  if (status.status === null && !status.showErrorBanner) {
    return (
      <DiffPanelShell mode={props.mode} header={sourceControlHeader}>
        <SourceControlInitialLoading />
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode={props.mode} header={sourceControlHeader}>
      {/* fork: f4 focus model — the panel owns its keys (`/` here, `j/k/s/u/x`
          in the lists below), so the chat composer's type-to-focus must not
          swallow them before they are dispatched. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={handleBodyKeyDown}
        data-keys-owned=""
        data-source-control-refreshing={status.isRefreshing ? "true" : "false"}
        aria-busy={status.isRefreshing}
      >
        {commitComposer}

        {/* ── C ── one filter row, full width, shared by both tabs ────────── */}
        {showFilterRow ? (
          <div className="flex flex-none items-center gap-2 border-border/60 border-b px-3 py-1.5">
            <InputGroup>
              <InputGroupAddon>
                <Search className="text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                ref={filterInputRef}
                size="sm"
                value={onChanges ? pathQuery : historyFilter.query}
                onChange={(event) =>
                  onChanges
                    ? setPathQuery(event.target.value)
                    : setHistoryFilter({ ...historyFilter, query: event.target.value })
                }
                placeholder={onChanges ? "Filter files ( / )" : "Search commits ( / )"}
                aria-label={onChanges ? "Filter changed files" : "Search commits"}
              />
              {(onChanges ? pathQuery : historyFilter.query).length > 0 ? (
                <InputGroupAddon align="inline-end">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Clear the filter"
                    onClick={() =>
                      onChanges
                        ? setPathQuery("")
                        : setHistoryFilter({ ...historyFilter, query: "" })
                    }
                  >
                    <X />
                  </Button>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            {!onChanges && historyFilter.author.length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="outline"
                      className="max-w-32 shrink-0"
                      onClick={() => setHistoryFilter({ ...historyFilter, author: "" })}
                    />
                  }
                >
                  <span className="min-w-0 truncate">{historyFilter.author}</span>
                  <X />
                </TooltipTrigger>
                <TooltipPopup>Clear the author filter</TooltipPopup>
              </Tooltip>
            ) : null}
            {onChanges && prefs.filter !== "all" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="outline"
                      className="max-w-32 shrink-0"
                      onClick={() => setPrefs(props.scopeKey, { filter: "all" })}
                    />
                  }
                >
                  <span className="min-w-0 truncate">{CHANGES_FILTER_LABEL[prefs.filter]}</span>
                  <X />
                </TooltipTrigger>
                <TooltipPopup>Clear the status filter</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}

        {/* ── D ── one status slot ───────────────────────────────────────── */}
        <SourceControlStatusBand
          error={
            status.showErrorBanner
              ? (status.errorMessage ?? "The working copy could not be read.")
              : null
          }
          onDismissError={status.dismissErrorBanner}
          // Shown on BOTH tabs: a blocked merge is a property of the working
          // copy, not of the tab you happen to be looking at.
          operation={operation}
          conflictCount={conflictedCount}
          busy={actions.busy.size > 0}
          abortBusy={actions.isBusy(workingCopyBusyKey.abort())}
          hasMessage={commitDraft.trim().length > 0}
          primaryVariant={
            sourceControlPrimaryVariant(primarySlot, "continue") === "default"
              ? "default"
              : "secondary"
          }
          onAbort={() => operation !== null && void actions.abortOperation(operation)}
          // "Commit merge" is a plain commit of what git already staged while
          // resolving; it must never re-stage, or a deliberately unstaged
          // resolution would be swept in.
          onContinue={() => void handleCommit({ stageAllFirst: false })}
        />

        {/* ── E ── the list gets all remaining height ────────────────────── */}
        {onChanges ? (
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
            onClearFilters={() => {
              setPathQuery("");
              setPrefs(props.scopeKey, { filter: "all" });
            }}
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
      </div>

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

      {/* fork: f4 redesign — the stash list is a dialog now, not a permanent
          32px strip stealing the bottom edge from the composer. */}
      <Dialog
        open={prefs.stashesOpen}
        onOpenChange={(open) => setPrefs(props.scopeKey, { stashesOpen: open })}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Stashes &amp; backups</DialogTitle>
            <DialogDescription>
              Parked work, and the automatic backups the panel takes before a discard.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-96 min-h-0">
            <StashesPanel
              stashes={stashQuery.data ?? EMPTY_STASHES}
              backups={backupQuery.data ?? EMPTY_STASHES}
              // fork: f4 — `isLoading` is now "we have nothing to show yet".
              // `Atom.swr` reports `waiting` during EVERY revalidation, so the
              // old predicate flashed "Loading…" over already-rendered rows
              // after each mutation.
              isLoading={
                (stashQuery.isPending && stashQuery.data === null) ||
                (backupQuery.isPending && backupQuery.data === null)
              }
              // fork: f4 F-09 — Pop resolved the latest stash from a list that
              // is `null` during the first load and during every post-mutation
              // re-read, then fell through an `if` with no else. Disable it
              // while the list has not arrived instead.
              listReady={stashQuery.data !== null}
              isBusy={actions.isBusy}
              dirty={dirtyCount > 0}
              onStash={() => {
                setPrefs(props.scopeKey, { stashesOpen: false });
                setStashDialogOpen(true);
              }}
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
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </DiffPanelShell>
  );
}

function SourceControlInitialLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      role="status"
      aria-live="polite"
      aria-label="Reading the working copy"
      data-source-control-initial-loading
    >
      <div className="space-y-1.5 border-border/60 border-b px-2 py-2">
        <div className="h-12 rounded-md bg-muted/60" />
        <div className="h-7 rounded-md bg-muted/45" />
      </div>
      <div className="flex h-7 items-center gap-2 border-border/60 border-b px-3">
        <div className="h-2.5 w-20 rounded-full bg-muted/60" />
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="h-2.5 w-3/5 rounded-full bg-muted/45" />
        <div className="h-2.5 w-4/5 rounded-full bg-muted/45" />
        <div className="h-2.5 w-1/2 rounded-full bg-muted/45" />
      </div>
      <span className="sr-only">Reading the working copy…</span>
    </div>
  );
}

const EMPTY_STASHES: ReadonlyArray<never> = [];

/**
 * "Include untracked" defaults ON, contrary to git: a stash that silently
 * leaves new files behind is the single most surprising thing `git stash` does.
 *
 * fork: f4 redesign (audit §8 / C3) — this was a hand-rolled `absolute inset-0`
 * overlay with no portal, no focus trap, no Escape handler, no restore-focus,
 * a raw OS checkbox and two sub-Button-sized buttons — inside a panel whose
 * root is not `relative`, so the overlay resolved against whatever ancestor
 * happened to be positioned. It is the repo's `Dialog` now, like the confirm
 * dialog that already shipped in the same feature.
 */
function StashDialog(props: {
  onClose: () => void;
  onSubmit: (message: string, includeUntracked: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stash changes</DialogTitle>
          <DialogDescription>
            Parks every change in the working copy so you can come back to a clean tree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Input
            autoFocus
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Optional message"
            aria-label="Stash message"
          />
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
            <Checkbox
              checked={includeUntracked}
              onCheckedChange={(checked) => setIncludeUntracked(checked === true)}
            />
            Include untracked files
          </label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={() => props.onSubmit(message, includeUntracked)}>Stash</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export { DEFAULT_SOURCE_CONTROL_PREFS };
