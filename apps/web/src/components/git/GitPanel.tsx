/**
 * Git right-panel surface.
 *
 * Shows one source folder at a time: its branch and upstream, the working tree
 * split into Staged and Changes with per-file stage/unstage, a commit box, and
 * recent history.
 *
 * The panel reads and writes the real git index — staging done here shows up in
 * a terminal and vice versa — so its commit button commits exactly what is
 * staged (`commitScope: "index"`) and never stages on the user's behalf. That
 * is deliberately different from the chat-header commit flow, which stages
 * everything the agent touched.
 */
import type { EnvironmentId, ScopedThreadRef, VcsWorkingTreeFile } from "@t3tools/contracts";
import {
  CloudUploadIcon,
  FolderGitIcon,
  GitCommitIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useEnvironmentQuery } from "~/state/query";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsStagingAction,
} from "~/state/sourceControlActions";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { GitCommitList } from "./GitCommitList";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";
import {
  fileStatusLetter,
  mergeCommitPages,
  partitionWorkingTree,
  renameLabel,
  resolveCommitState,
  summarizeSection,
} from "./GitPanel.logic";

const BUSY_ACTIONS = ["runStackedAction", "pull", "stagePaths", "unstagePaths"] as const;
const COMMITS_PAGE_LIMIT = 50;

export interface GitPanelFolder {
  readonly path: string;
  readonly label: string;
  readonly isPrimary: boolean;
}

function DiffStat({ insertions, deletions }: { insertions: number; deletions: number }) {
  if (insertions === 0 && deletions === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      {insertions > 0 ? <span className="text-success">+{insertions}</span> : null}
      {insertions > 0 && deletions > 0 ? " " : null}
      {deletions > 0 ? <span className="text-destructive">-{deletions}</span> : null}
    </span>
  );
}

function FileRow({
  file,
  section,
  disabled,
  onToggle,
  onOpen,
}: {
  file: VcsWorkingTreeFile;
  section: "staged" | "unstaged";
  disabled: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const letter = fileStatusLetter(file, section);
  const rename = renameLabel(file);
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const directory = file.path.slice(0, file.path.length - name.length);

  return (
    <div className="group flex items-center gap-1.5 rounded-sm px-2 py-1 hover:bg-sidebar-row-hover">
      <span
        aria-hidden
        className="w-3 shrink-0 text-center font-mono text-[10px] text-muted-foreground"
      >
        {letter}
      </span>
      <button
        type="button"
        onClick={() => {
          onOpen(file.path);
        }}
        className="flex min-w-0 flex-1 items-baseline gap-1 text-left"
        title={rename ?? file.path}
      >
        <span className="truncate text-xs">{name}</span>
        {directory.length > 0 ? (
          <span className="truncate text-[10px] text-muted-foreground">{directory}</span>
        ) : null}
      </button>
      <DiffStat insertions={file.insertions} deletions={file.deletions} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              disabled={disabled}
              onClick={() => {
                onToggle(file.path);
              }}
              aria-label={section === "staged" ? `Unstage ${file.path}` : `Stage ${file.path}`}
            >
              {section === "staged" ? (
                <MinusIcon className="size-3" />
              ) : (
                <PlusIcon className="size-3" />
              )}
            </Button>
          }
        />
        <TooltipPopup>{section === "staged" ? "Unstage" : "Stage"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function FileSection({
  title,
  files,
  section,
  disabled,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  title: string;
  files: ReadonlyArray<VcsWorkingTreeFile>;
  section: "staged" | "unstaged";
  disabled: boolean;
  onToggle: (path: string) => void;
  onToggleAll: (paths: ReadonlyArray<string>) => void;
  onOpen: (path: string) => void;
}) {
  if (files.length === 0) return null;
  const totals = summarizeSection(files);

  return (
    <section className="flex flex-col">
      <header className="flex items-center gap-2 px-2 py-1">
        <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <span className="text-[10px] text-muted-foreground tabular-nums">{files.length}</span>
        <DiffStat insertions={totals.insertions} deletions={totals.deletions} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10px]"
          disabled={disabled}
          onClick={() => {
            onToggleAll(files.map((file) => file.path));
          }}
        >
          {section === "staged" ? "Unstage all" : "Stage all"}
        </Button>
      </header>
      {files.map((file) => (
        <FileRow
          key={`${section}:${file.path}`}
          file={file}
          section={section}
          disabled={disabled}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}

export function GitPanel({
  environmentId,
  cwd,
  folders,
  threadRef,
  onSelectFolder,
  onOpenFile,
}: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  folders: ReadonlyArray<GitPanelFolder>;
  threadRef: ScopedThreadRef | null;
  onSelectFolder: (folderPath: string) => void;
  onOpenFile: (relativePath: string) => void;
}) {
  const [commitMessage, setCommitMessage] = useState("");
  const [commitsCursor, setCommitsCursor] = useState<number | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
  const statusQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd } })
      : null,
  );
  const status = statusQuery.data;

  // Two pages at most are held: the first, and whatever the user scrolled to.
  // Anything deeper is a history browser, which is not what this panel is.
  const firstPageQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? vcsEnvironment.listCommits({
          environmentId,
          input: { cwd, limit: COMMITS_PAGE_LIMIT },
        })
      : null,
  );
  const nextPageQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && commitsCursor !== null
      ? vcsEnvironment.listCommits({
          environmentId,
          input: { cwd, limit: COMMITS_PAGE_LIMIT, cursor: commitsCursor },
        })
      : null,
  );

  const commits = useMemo(
    () => mergeCommitPages([firstPageQuery.data?.commits ?? [], nextPageQuery.data?.commits ?? []]),
    [firstPageQuery.data, nextPageQuery.data],
  );
  const latestPage = nextPageQuery.data ?? firstPageQuery.data;

  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const stageAction = useVcsStagingAction(scope, "stage");
  const unstageAction = useVcsStagingAction(scope, "unstage");
  const commitAction = useGitStackedAction(scope);
  const isBusy = useSourceControlActionRunning(scope, BUSY_ACTIONS);

  const sections = useMemo(
    () => partitionWorkingTree(status?.workingTree.files ?? []),
    [status?.workingTree.files],
  );
  const commitState = resolveCommitState({
    sections,
    isBusy,
    isRepo: status?.isRepo ?? true,
  });

  const refreshAll = useCallback(() => {
    if (environmentId !== null && cwd !== null) {
      void refreshStatus({ environmentId, input: { cwd } });
    }
    firstPageQuery.refresh();
    setCommitsCursor(null);
  }, [cwd, environmentId, firstPageQuery, refreshStatus]);

  const stage = useCallback(
    (paths: ReadonlyArray<string>) => {
      void stageAction.run({ paths });
    },
    [stageAction],
  );
  const unstage = useCallback(
    (paths: ReadonlyArray<string>) => {
      void unstageAction.run({ paths });
    },
    [unstageAction],
  );

  const runCommit = useCallback(async () => {
    const message = commitMessage.trim();
    const result = await commitAction.run({
      actionId: `git-panel-commit:${Date.now()}`,
      action: "commit",
      // Commit the index verbatim. Without this the shared pipeline would
      // reset and re-add, silently swallowing the user's staging choices.
      commitScope: "index",
      ...(message ? { commitMessage: message } : {}),
    });
    if (result._tag === "Success") {
      setCommitMessage("");
      refreshAll();
    }
  }, [commitAction, commitMessage, refreshAll]);

  const runPush = useCallback(async () => {
    const result = await commitAction.run({
      actionId: `git-panel-push:${Date.now()}`,
      action: "push",
    });
    if (result._tag === "Success") refreshAll();
  }, [commitAction, refreshAll]);

  if (environmentId === null || cwd === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Open a project to see its Git status.
      </div>
    );
  }

  const activeFolder = folders.find((folder) => folder.path === cwd);
  const upstreamLabel = status?.hasUpstream
    ? `↑${status.aheadCount} ↓${status.behindCount}`
    : "No upstream";
  const canPublish = status?.isRepo === true && !status.hasPrimaryRemote;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          {folders.length > 1 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button variant="ghost" size="sm" className="h-6 min-w-0 gap-1.5 px-1.5">
                    <FolderGitIcon className="size-3.5 shrink-0" />
                    <span className="truncate text-xs">{activeFolder?.label ?? "Folder"}</span>
                  </Button>
                }
              />
              <MenuPopup align="start">
                {folders.map((folder) => (
                  <MenuItem
                    key={folder.path}
                    onClick={() => {
                      onSelectFolder(folder.path);
                      setCommitsCursor(null);
                    }}
                  >
                    <span className="truncate">{folder.label}</span>
                    {folder.isPrimary ? (
                      <span className="ml-auto text-[10px] text-muted-foreground">primary</span>
                    ) : null}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{activeFolder?.label ?? cwd}</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6"
            onClick={refreshAll}
            disabled={isBusy}
            aria-label="Refresh Git status"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate font-medium text-foreground">
            {status?.refName ?? "detached HEAD"}
          </span>
          <span className="shrink-0 tabular-nums">{upstreamLabel}</span>
        </div>
      </header>

      <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
        <Textarea
          value={commitMessage}
          onChange={(event) => {
            setCommitMessage(event.target.value);
          }}
          placeholder="Message (leave blank to generate one)"
          rows={2}
          className="min-h-14 resize-none text-xs"
        />
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  className="h-7 flex-1 gap-1.5 text-xs"
                  disabled={commitState.disabled}
                  onClick={() => {
                    void runCommit();
                  }}
                >
                  <GitCommitIcon className="size-3.5" />
                  {commitState.label}
                </Button>
              }
            />
            {commitState.disabledReason ? (
              <TooltipPopup>{commitState.disabledReason}</TooltipPopup>
            ) : null}
          </Tooltip>
          {canPublish ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => {
                setPublishOpen(true);
              }}
            >
              <CloudUploadIcon className="size-3.5" />
              Publish
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={isBusy || !(status?.aheadCount ?? 0)}
              onClick={() => {
                void runPush();
              }}
            >
              <CloudUploadIcon className="size-3.5" />
              Push
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 py-1">
          {sections.conflicted.length > 0 ? (
            <FileSection
              title="Conflicts"
              files={sections.conflicted}
              section="unstaged"
              disabled={isBusy}
              onToggle={(path) => {
                stage([path]);
              }}
              onToggleAll={stage}
              onOpen={onOpenFile}
            />
          ) : null}
          <FileSection
            title="Staged"
            files={sections.staged}
            section="staged"
            disabled={isBusy}
            onToggle={(path) => {
              unstage([path]);
            }}
            onToggleAll={unstage}
            onOpen={onOpenFile}
          />
          <FileSection
            title="Changes"
            files={sections.unstaged}
            section="unstaged"
            disabled={isBusy}
            onToggle={(path) => {
              stage([path]);
            }}
            onToggleAll={stage}
            onOpen={onOpenFile}
          />
          {status?.hasWorkingTreeChanges === false ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Working tree clean
            </p>
          ) : null}
        </div>
      </ScrollArea>

      <div className="flex min-h-0 flex-[1.2] flex-col border-t border-border">
        <header className="flex items-center gap-2 px-3 py-1.5">
          <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Recent commits
          </h3>
          <span className="text-[10px] text-muted-foreground tabular-nums">{commits.length}</span>
        </header>
        <GitCommitList
          commits={commits}
          hasMore={latestPage?.nextCursor != null}
          isLoadingMore={nextPageQuery.isPending}
          onLoadMore={() => {
            if (latestPage?.nextCursor != null) setCommitsCursor(latestPage.nextCursor);
          }}
        />
      </div>

      <PublishRepositoryDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        environmentId={threadRef?.environmentId ?? environmentId}
        gitCwd={cwd}
      />
    </div>
  );
}

export default GitPanel;
