import type {
  ContextMenuItem,
  EnvironmentId,
  VcsPanelBranchCommitsInput,
  ThreadId,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelCommitSummary,
  VcsPanelFileDiffInput,
  VcsPanelFileChange,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { LegendList } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import {
  Archive,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  GitBranch,
  GitBranchPlus,
  GitCommit,
  GitCompare,
  GitMerge,
  GitPullRequestArrow,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Tag,
  Target,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useTheme } from "~/hooks/useTheme";
import { readLocalApi } from "~/localApi";
import { getRenderablePatch, resolveDiffThemeName } from "~/lib/diffRendering";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { cn, newCommandId } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  resolveSourceControlPanelPresentationState,
  useSourceControlPanelApi,
} from "~/state/sourceControlPanel";
import { vcsEnvironment } from "~/state/vcs";
import { resolvePathLinkTarget } from "~/terminal-links";

import { shouldIncludeBranchPickerItem } from "../BranchToolbar.logic";
import { VisualStudioCode } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type AttentionKind,
  type BranchSyncState,
  branchAttention,
  branchHasUpstream,
  branchSyncCounts,
  branchSyncState,
  formatRelativeDate,
  mergeChangeGroups,
  type PanelChangedFile,
} from "./SourceControlPanel.logic";

interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly onThreadRefChange?: (input: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) => Promise<void> | void;
}

type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;
type BranchCommitListKind = NonNullable<VcsPanelBranchCommitsInput["kind"]>;

type FileDiffLoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly patch: string }
  | { readonly status: "error"; readonly message: string };

type SectionKey = "work" | "remotes";

const SECTION_ORDER: readonly SectionKey[] = ["work", "remotes"];

const SECTION_TITLES: Record<SectionKey, string> = {
  work: "Actionable",
  remotes: "Remotes",
};

const DEFAULT_SECTION_WEIGHTS: Record<SectionKey, number> = {
  work: 3,
  remotes: 1.4,
};

const COLLAPSED_SECTION_HEIGHT = 32;
const MIN_SECTION_WEIGHT = 0.35;
const COMMIT_PAGE_SIZE = 10;
const WORKING_FILE_ROW_ESTIMATED_HEIGHT = 28;
const WORKING_FILE_DRAW_DISTANCE = 600;
const commitDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Source control action failed.";
}

function applyWorkingTreeFileEnrichment(
  groups: readonly VcsPanelChangeGroup[],
  enrichedFilesByPath: ReadonlyMap<string, VcsPanelFileChange>,
  hiddenPaths: ReadonlySet<string>,
): VcsPanelChangeGroup[] {
  if (enrichedFilesByPath.size === 0 && hiddenPaths.size === 0) {
    return groups.map((group) => ({ ...group, files: [...group.files] }));
  }
  return groups.map((group) => {
    if (group.kind !== "unstaged") return { ...group, files: [...group.files] };
    const seenPaths = new Set<string>();
    const files = group.files.flatMap((file) => {
      if (hiddenPaths.has(file.path)) return [];
      const enrichedFile = enrichedFilesByPath.get(file.path) ?? file;
      seenPaths.add(enrichedFile.path);
      return [enrichedFile];
    });
    for (const enrichedFile of enrichedFilesByPath.values()) {
      if (seenPaths.has(enrichedFile.path) || hiddenPaths.has(enrichedFile.path)) continue;
      files.push(enrichedFile);
    }
    return {
      ...group,
      files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  });
}

function shouldEnrichWorkingTreeFile(file: PanelChangedFile): boolean {
  return file.hasUnstagedChanges && (file.status === "untracked" || file.status === "deleted");
}

function isActionForced(event: ReactMouseEvent): boolean {
  return event.shiftKey;
}

function shouldFetchBeforePull(event: ReactMouseEvent): boolean {
  return event.altKey;
}

function commitUndoActionKey(branchName: string, sha?: string): string {
  return sha ? `commit-undo:${branchName}:${sha}` : `branch-undo-latest:${branchName}`;
}

function treeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function formatReadableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return commitDateFormatter.format(new Date(time));
}

function mapBranchDetails(
  details: readonly VcsPanelBranchDetails[],
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const map = new Map<string, VcsPanelBranchDetails>();
  for (const detail of details) {
    map.set(detail.fullRefName, detail);
    map.set(detail.name, detail);
  }
  return map;
}

function remoteBranchRef(
  remote: VcsPanelRemote,
  branch: VcsPanelRemote["branches"][number],
): VcsRef {
  return {
    name: branch.fullRefName,
    isRemote: true,
    remoteName: remote.name,
    current: false,
    isDefault: branch.isDefaultRemoteHead,
    worktreePath: null,
    lastActivityAt: branch.lastActivityAt,
    upstreamName: null,
  };
}

function localBranchForRemoteBranch(
  snapshot: VcsPanelSnapshotResult,
  remote: VcsPanelRemote,
  branch: VcsPanelRemote["branches"][number],
): VcsRef | null {
  return (
    snapshot.localBranches.find((localBranch) => localBranch.upstreamName === branch.fullRefName) ??
    snapshot.localBranches.find(
      (localBranch) =>
        localBranch.name === branch.name &&
        localBranch.upstreamName === `${remote.name}/${branch.name}`,
    ) ??
    null
  );
}

function localOnlyBranches(snapshot: VcsPanelSnapshotResult): VcsRef[] {
  return snapshot.localBranches
    .filter((branch) => !branchHasUpstream(branch, snapshot))
    .toSorted((left, right) => branchActivityTimestamp(right) - branchActivityTimestamp(left));
}

function compareBaseRefNames(snapshot: VcsPanelSnapshotResult | null): string[] {
  if (!snapshot) return [];
  const refs = new Set<string>();
  if (snapshot.defaultCompareRef) refs.add(snapshot.defaultCompareRef);
  for (const branch of snapshot.localBranches) {
    refs.add(branch.name);
    if (branch.upstreamName) refs.add(branch.upstreamName);
  }
  for (const remote of snapshot.remotes) {
    for (const branch of remote.branches) {
      refs.add(branch.fullRefName);
    }
  }
  return [...refs].toSorted((left, right) => left.localeCompare(right));
}

type ExpandedBranchRequest = {
  readonly branch: VcsRef;
  readonly detailsKey: string;
  readonly compareBaseRef?: string;
};

function expandedBranchesForSnapshot(
  snapshot: VcsPanelSnapshotResult,
  expanded: ReadonlySet<string>,
): ExpandedBranchRequest[] {
  const localBranches = snapshot.localBranches
    .filter((branch) => expanded.has(treeKey("branch", branch.name)))
    .map((branch) => ({ branch, detailsKey: branch.name }));
  const expandedLocalBranches = localOnlyBranches(snapshot)
    .filter((branch) => expanded.has(treeKey("remote-branch", `local:${branch.name}`)))
    .map((branch) => ({ branch, detailsKey: branch.name }));
  const remoteBranches = snapshot.remotes.flatMap((remote) =>
    remote.branches
      .map((branch) => ({
        displayName: branch.name,
        ref:
          localBranchForRemoteBranch(snapshot, remote, branch) ?? remoteBranchRef(remote, branch),
      }))
      .filter((branch) =>
        expanded.has(
          treeKey("remote-branch", `${branch.ref.remoteName ?? "local"}:${branch.displayName}`),
        ),
      )
      .map((branch) => ({ branch: branch.ref, detailsKey: branch.ref.name })),
  );
  const forkBranches = snapshot.actionableForkBranches.flatMap((fork) => {
    const branch = snapshot.localBranches.find(
      (localBranch) => localBranch.name === fork.localBranchName,
    );
    if (!branch) return [];
    const detailsKey = treeKey("fork-details", `${fork.localBranchName}:${fork.remoteRefName}`);
    return expanded.has(treeKey("fork-branch", `${fork.localBranchName}:${fork.remoteRefName}`))
      ? [{ branch, detailsKey, compareBaseRef: fork.remoteRefName }]
      : [];
  });
  return [...localBranches, ...expandedLocalBranches, ...remoteBranches, ...forkBranches];
}

function StatLabels({
  insertions,
  deletions,
}: {
  readonly insertions: number;
  readonly deletions: number;
}) {
  if (insertions === 0 && deletions === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
      {insertions > 0 ? <span className="text-success-foreground">+{insertions}</span> : null}
      {deletions > 0 ? <span className="text-destructive-foreground">-{deletions}</span> : null}
    </span>
  );
}

function BranchSyncLabels({
  aheadCount,
  behindCount,
}: {
  readonly aheadCount: number;
  readonly behindCount: number;
}) {
  if (aheadCount === 0 && behindCount === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] tabular-nums">
      {aheadCount > 0 ? <span className="text-success-foreground">↑{aheadCount}</span> : null}
      {behindCount > 0 ? <span className="text-warning-foreground">↓{behindCount}</span> : null}
    </span>
  );
}

function branchSyncActionLabel(state: BranchSyncState): string {
  switch (state) {
    case "publish":
      return "Publish";
    case "pull":
      return "Pull. Shift: reset. Option: fetch.";
    case "push":
      return "Push";
    case "diverged":
      return "Sync diverged";
    case "fetch":
      return "Fetch";
  }
}

function BranchSyncActionIcon({ state }: { readonly state: BranchSyncState }) {
  switch (state) {
    case "publish":
      return <Upload className="size-3.5" />;
    case "pull":
      return <Download className="size-3.5" />;
    case "push":
      return <Upload className="size-3.5" />;
    case "diverged":
      return <GitCompare className="size-3.5" />;
    case "fetch":
      return <RefreshCw className="size-3.5" />;
  }
}

const ATTENTION_RANK: Record<AttentionKind, number> = {
  conflicts: 0,
  diverged: 1,
  behind: 2,
  unpushed: 3,
  dirty: 4,
  stale: 5,
};

function branchActivityTimestamp(branch: {
  readonly lastActivityAt?: string | null | undefined;
}): number {
  if (!branch.lastActivityAt) return 0;
  const time = Date.parse(branch.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
}

function stashActivityTimestamp(stash: VcsPanelStash): number {
  if (!stash.createdAt) return 0;
  const time = Date.parse(stash.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function AttentionIcon({ kind }: { readonly kind: AttentionKind }) {
  switch (kind) {
    case "conflicts":
    case "diverged":
      return <AlertTriangle className="size-3.5 shrink-0 text-destructive-foreground" />;
    case "behind":
      return <Download className="size-3.5 shrink-0 text-warning-foreground" />;
    case "unpushed":
      return <Upload className="size-3.5 shrink-0 text-success-foreground" />;
    case "dirty":
      return <GitCommit className="size-3.5 shrink-0 text-warning-foreground" />;
    case "stale":
      return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function AuthorAvatar({
  commit,
  className,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const fallbackText =
    commit.authorName
      ?.trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ||
    commit.authorEmail?.trim()[0]?.toUpperCase() ||
    "?";
  const avatarClassName = cn(
    "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground object-cover",
    className,
  );
  if (!commit.authorAvatarUrl || failed) {
    return (
      <span className={avatarClassName} aria-label={commit.authorName ?? "Unknown author"}>
        {fallbackText}
      </span>
    );
  }
  return (
    <img
      alt={commit.authorName ? `${commit.authorName} avatar` : "Author avatar"}
      className={avatarClassName}
      referrerPolicy="no-referrer"
      src={commit.authorAvatarUrl}
      onError={(event) => {
        event.currentTarget.hidden = true;
        setFailed(true);
      }}
    />
  );
}

type DisplayHeadRef =
  | { readonly kind: "local"; readonly name: string; readonly synced: boolean }
  | { readonly kind: "remote"; readonly name: string };

function displayHeadRefs(headRefs: readonly string[]): DisplayHeadRef[] {
  const localRefs = new Set(headRefs.filter((ref) => !ref.includes("/")));
  const remoteByBranch = new Map<string, string>();
  for (const ref of headRefs) {
    const slashIndex = ref.indexOf("/");
    if (slashIndex <= 0) continue;
    const branchName = ref.slice(slashIndex + 1);
    if (branchName.length === 0 || branchName === "HEAD") continue;
    remoteByBranch.set(branchName, ref);
  }

  const refs: DisplayHeadRef[] = [...localRefs]
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => ({
      kind: "local" as const,
      name,
      synced: remoteByBranch.has(name),
    }));

  for (const branchName of [...remoteByBranch.keys()].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (localRefs.has(branchName)) continue;
    refs.push({ kind: "remote", name: branchName });
  }

  return refs;
}

function SyncedIcon({ className }: { readonly className?: string }) {
  return <Target className={cn("size-3 shrink-0", className)} aria-label="Synced upstream" />;
}

function RefLabels({ commit }: { readonly commit: VcsPanelCommitSummary }) {
  const headRefs = displayHeadRefs(commit.headRefs);
  if (headRefs.length === 0 && commit.tags.length === 0) return null;
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
      {headRefs.map((ref) => (
        <CompactBadge key={`head:${ref.kind}:${ref.name}`}>
          <span className="inline-flex items-center gap-0.5">
            {ref.kind === "remote" || (ref.kind === "local" && ref.synced) ? <SyncedIcon /> : null}
            <span>{ref.name}</span>
          </span>
        </CompactBadge>
      ))}
      {commit.tags.map((tag) => (
        <CompactBadge key={`tag:${tag}`}>
          <span className="inline-flex items-center gap-0.5">
            <Tag className="size-3 shrink-0" />
            <span>{tag}</span>
          </span>
        </CompactBadge>
      ))}
    </span>
  );
}

function CommitTooltip({ commit }: { readonly commit: VcsPanelCommitSummary }) {
  const relativeDate = formatRelativeDate(commit.authoredAt);
  const readableDate = formatReadableDate(commit.authoredAt);
  return (
    <div className="w-72 space-y-2 py-1 text-left">
      <div className="flex min-w-0 items-center gap-2">
        <AuthorAvatar commit={commit} className="size-6" />
        <div className="min-w-0">
          <div className="truncate font-medium">{commit.authorName ?? "Unknown author"}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {commit.shortSha}
          </div>
        </div>
      </div>
      {relativeDate || readableDate ? (
        <div className="text-muted-foreground">
          {relativeDate ?? "Unknown time"}
          {readableDate ? ` (${readableDate})` : null}
        </div>
      ) : null}
      <div className="line-clamp-3">{commit.message}</div>
      <StatLabels
        insertions={sumFiles(commit.files).insertions}
        deletions={sumFiles(commit.files).deletions}
      />
      <RefLabels commit={commit} />
    </div>
  );
}

function IconButton({
  label,
  children,
  disabled,
  destructive,
  loading,
  onClick,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly loading?: boolean;
  readonly onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            disabled={disabled || loading}
            className={cn(
              "size-6",
              destructive && "text-destructive-foreground hover:text-destructive-foreground",
            )}
            onClick={onClick}
          >
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RowActions({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded bg-background/95 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

function CompactBadge({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-4 items-center rounded border border-border/70 px-1 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

function fileStatusLetter(status: VcsPanelFileChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "conflicted":
      return "U";
    case "modified":
      return "M";
  }
}

function fileStatusColor(status: VcsPanelFileChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-success-foreground";
    case "deleted":
    case "conflicted":
      return "text-destructive-foreground";
    default:
      return "text-muted-foreground";
  }
}

function CollapsibleSection({
  sectionKey,
  title,
  collapsed,
  weight,
  onToggle,
  onResizeStart,
  children,
  action,
}: {
  readonly sectionKey: SectionKey;
  readonly title: string;
  readonly collapsed: boolean;
  readonly weight: number;
  readonly onToggle: () => void;
  readonly onResizeStart: (key: SectionKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section
      data-source-control-section={sectionKey}
      className="flex min-h-0 flex-col overflow-hidden border-b border-border/70"
      style={
        collapsed
          ? { flex: `0 0 ${COLLAPSED_SECTION_HEIGHT}px` }
          : { flex: `${weight} 1 0`, minHeight: 0 }
      }
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-normal text-muted-foreground hover:text-foreground"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span className="truncate">{title}</span>
        </button>
        {action}
      </div>
      {!collapsed ? (
        <div data-source-control-section-content className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {children}
        </div>
      ) : null}
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${title}`}
          className="h-1 shrink-0 cursor-row-resize hover:bg-border"
          onMouseDown={(event) => onResizeStart(sectionKey, event)}
        />
      ) : null}
    </section>
  );
}

function BranchBadge({ snapshot }: { readonly snapshot: VcsPanelSnapshotResult }) {
  const status = snapshot.status;
  if (!status.hasUpstream) {
    return (
      <Badge variant="warning" size="sm">
        No upstream
      </Badge>
    );
  }
  if (status.aheadCount === 0 && status.behindCount === 0) {
    return (
      <Badge variant="success" size="sm">
        Synced
      </Badge>
    );
  }
  return <BranchSyncLabels aheadCount={status.aheadCount} behindCount={status.behindCount} />;
}

function sumFiles(files: readonly VcsPanelFileChange[]) {
  return files.reduce(
    (total, file) => ({
      insertions: total.insertions + file.insertions,
      deletions: total.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}

function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part) return part;
  }
  return path;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function operationPathsForFile(file: Pick<VcsPanelFileChange, "path" | "originalPath">): string[] {
  return uniquePaths(file.originalPath ? [file.path, file.originalPath] : [file.path]);
}

function commitCountLabel(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

function stashBranchName(stash: VcsPanelStash): string | null {
  return /^(?:WIP\s+)?on\s+([^:]+):/i.exec(stash.message)?.[1]?.trim() ?? null;
}

function contextMenuSeparator<T extends string>(id: T): ContextMenuItem<T> {
  return { id, label: "", separator: true };
}

function FileChangeSummary({ files }: { readonly files: readonly VcsPanelFileChange[] }) {
  const stats = sumFiles(files);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span>{files.length === 1 ? "1 file" : `${files.length} files`}</span>
      <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
    </span>
  );
}

function FileChangeList({
  files,
  emptyLabel,
  onFileContextMenu,
  getFileKey,
  isFileExpanded,
  onFileToggle,
  renderExpandedFile,
  onOpenFile,
  onOpenInVsCode,
}: {
  readonly files: readonly VcsPanelFileChange[];
  readonly emptyLabel: string;
  readonly onFileContextMenu?: (
    event: ReactMouseEvent<HTMLDivElement>,
    file: VcsPanelFileChange,
  ) => void;
  readonly getFileKey?: (file: VcsPanelFileChange) => string;
  readonly isFileExpanded?: (file: VcsPanelFileChange) => boolean;
  readonly onFileToggle?: (file: VcsPanelFileChange) => void;
  readonly renderExpandedFile?: (file: VcsPanelFileChange) => ReactNode;
  readonly onOpenFile?: (file: VcsPanelFileChange) => void;
  readonly onOpenInVsCode?: (file: VcsPanelFileChange) => void;
}) {
  if (files.length === 0) {
    return <div className="px-3 py-1 text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-0.5">
      {files.map((file) => {
        const fileKey = getFileKey?.(file) ?? `${file.path}:${file.status}`;
        const expanded = isFileExpanded?.(file) ?? false;
        return (
          <div key={fileKey} className="space-y-0.5">
            <div
              role={onFileToggle ? "button" : undefined}
              tabIndex={onFileToggle ? 0 : undefined}
              className="group relative flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
              onClick={onFileToggle ? () => onFileToggle(file) : undefined}
              onKeyDown={
                onFileToggle
                  ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onFileToggle(file);
                    }
                  : undefined
              }
              onContextMenu={
                onFileContextMenu ? (event) => onFileContextMenu(event, file) : undefined
              }
            >
              {onFileToggle ? (
                expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )
              ) : null}
              <span
                className={cn(
                  "w-3 shrink-0 text-center text-[10px] font-semibold uppercase",
                  fileStatusColor(file.status),
                )}
              >
                {fileStatusLetter(file.status)}
              </span>
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <StatLabels insertions={file.insertions} deletions={file.deletions} />
              {onOpenFile || onOpenInVsCode ? (
                <RowActions>
                  {onOpenFile ? (
                    <IconButton label="Open file" onClick={() => onOpenFile(file)}>
                      <FileText className="size-3.5" />
                    </IconButton>
                  ) : null}
                  {onOpenInVsCode ? (
                    <IconButton label="Open in VS Code" onClick={() => onOpenInVsCode(file)}>
                      <VisualStudioCode className="size-3.5" />
                    </IconButton>
                  ) : null}
                </RowActions>
              ) : null}
            </div>
            {expanded && renderExpandedFile ? (
              <div className="ml-4 border-l border-border/60 pl-1">{renderExpandedFile(file)}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function LoadMoreCommitsButton({
  remaining,
  loading,
  onClick,
}: {
  readonly remaining: number;
  readonly loading: boolean;
  readonly onClick: () => void;
}) {
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      className="flex h-7 w-full items-center rounded px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      disabled={loading}
      onClick={onClick}
    >
      Load {Math.min(COMMIT_PAGE_SIZE, remaining)} more of {remaining} remaining
    </button>
  );
}

function WorkingFileVirtualRow({
  file,
  onRendered,
  renderFile,
}: {
  readonly file: PanelChangedFile;
  readonly onRendered: (file: PanelChangedFile) => void;
  readonly renderFile: (file: PanelChangedFile) => ReactNode;
}) {
  useEffect(() => {
    onRendered(file);
  }, [file, onRendered]);
  return <>{renderFile(file)}</>;
}

function InlineFileDiff({
  patch,
  resolvedTheme,
}: {
  readonly patch: string;
  readonly resolvedTheme: "light" | "dark";
}) {
  const renderablePatch = useMemo(
    () => getRenderablePatch(patch, `vcs-panel-file:${resolvedTheme}`),
    [patch, resolvedTheme],
  );
  if (!renderablePatch) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">No diff.</div>;
  }
  if (renderablePatch.kind === "raw") {
    return (
      <pre className="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-xs">
        {renderablePatch.text}
      </pre>
    );
  }
  return (
    <div className="max-h-96 overflow-auto rounded border border-border/60 bg-background/60">
      {renderablePatch.files.map((fileDiff) => (
        <FileDiff
          key={fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name ?? "none"}`}
          fileDiff={fileDiff}
          options={{
            collapsed: false,
            diffStyle: "unified",
            theme: resolveDiffThemeName(resolvedTheme),
          }}
        />
      ))}
    </div>
  );
}

export function SourceControlPanel({
  cwd,
  environmentId,
  onThreadRefChange,
  threadId,
  worktreePath,
}: SourceControlPanelProps) {
  const { resolvedTheme } = useTheme();
  const gitActionScope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const gitAction = useGitStackedAction(gitActionScope);
  const api = useSourceControlPanelApi(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const vcsStatus = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd },
    }),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const expandedTreeRef = useRef<ReadonlySet<string>>(new Set());
  const lastFocusRefreshAtRef = useRef(0);
  const lastVcsStatusFingerprintRef = useRef<string | null>(null);
  const previousChangedPathsRef = useRef<ReadonlySet<string>>(new Set());
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const enrichedWorkingTreeFilesRef = useRef<ReadonlyMap<string, VcsPanelFileChange>>(new Map());
  const hiddenWorkingTreePathsRef = useRef<ReadonlySet<string>>(new Set());
  const pendingWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  const inFlightWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  const workingTreeEnrichmentTimerRef = useRef<number | null>(null);
  const workingTreeEnrichmentGenerationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<VcsPanelSnapshotResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningActions, setRunningActions] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(() => new Set(["remotes"]));
  const [sectionWeights, setSectionWeights] = useState(DEFAULT_SECTION_WEIGHTS);
  const [expandedTree, setExpandedTree] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedDefaultTree, setCollapsedDefaultTree] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [branchDetailsByRef, setBranchDetailsByRef] = useState<
    ReadonlyMap<string, VcsPanelBranchDetails>
  >(() => new Map());
  const [compareBaseOverrides, setCompareBaseOverrides] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [loadingBranchDetails, setLoadingBranchDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stashDetailsByRef, setStashDetailsByRef] = useState<
    ReadonlyMap<string, VcsPanelStashDetails>
  >(() => new Map());
  const [loadingStashDetails, setLoadingStashDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedFileDiffs, setExpandedFileDiffs] = useState<ReadonlySet<string>>(() => new Set());
  const [fileDiffsByKey, setFileDiffsByKey] = useState<ReadonlyMap<string, FileDiffLoadState>>(
    () => new Map(),
  );
  const [enrichedWorkingTreeFilesByPath, setEnrichedWorkingTreeFilesByPath] = useState<
    ReadonlyMap<string, VcsPanelFileChange>
  >(() => new Map());
  const [hiddenWorkingTreePaths, setHiddenWorkingTreePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [divergedSyncBranch, setDivergedSyncBranch] = useState<VcsRef | null>(null);
  const [publishRemoteTarget, setPublishRemoteTarget] = useState<{
    readonly branch: VcsRef;
    readonly force: boolean;
  } | null>(null);
  const [compareBaseDialogTarget, setCompareBaseDialogTarget] = useState<{
    readonly branch: VcsRef;
    readonly detailsKey: string;
  } | null>(null);
  const [compareBaseQuery, setCompareBaseQuery] = useState("");
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [stashDialogTarget, setStashDialogTarget] = useState<{
    readonly label: string;
    readonly paths: readonly string[];
  } | null>(null);
  const [dialogStashMessage, setDialogStashMessage] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [selectedChangePaths, setSelectedChangePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const displayedChangeGroups = useMemo(
    () =>
      applyWorkingTreeFileEnrichment(
        snapshot?.changeGroups ?? [],
        enrichedWorkingTreeFilesByPath,
        hiddenWorkingTreePaths,
      ),
    [enrichedWorkingTreeFilesByPath, hiddenWorkingTreePaths, snapshot?.changeGroups],
  );
  const changedFiles = useMemo(
    () => mergeChangeGroups(displayedChangeGroups),
    [displayedChangeGroups],
  );
  const compareBaseRefs = useMemo(() => compareBaseRefNames(snapshot), [snapshot]);
  const deferredCompareBaseQuery = useDeferredValue(compareBaseQuery);
  const normalizedCompareBaseQuery = deferredCompareBaseQuery.trim().toLowerCase();
  const filteredCompareBaseRefs = useMemo(
    () =>
      compareBaseRefs.filter((itemValue) =>
        shouldIncludeBranchPickerItem({
          itemValue,
          normalizedQuery: normalizedCompareBaseQuery,
          createBranchItemValue: null,
          checkoutPullRequestItemValue: null,
        }),
      ),
    [compareBaseRefs, normalizedCompareBaseQuery],
  );
  const changedPaths = useMemo(() => changedFiles.map((file) => file.path), [changedFiles]);
  const selectedChangedFiles = useMemo(
    () => changedFiles.filter((file) => selectedChangePaths.has(file.path)),
    [changedFiles, selectedChangePaths],
  );
  const selectedChangePathList = useMemo(
    () => uniquePaths(selectedChangedFiles.flatMap((file) => operationPathsForFile(file))),
    [selectedChangedFiles],
  );
  const selectedChangeStats = useMemo(() => sumFiles(selectedChangedFiles), [selectedChangedFiles]);
  const workingFileListExtraData = useMemo(
    () => ({
      expandedFileDiffs,
      fileDiffsByKey,
      runningActions,
      selectedChangePaths,
    }),
    [expandedFileDiffs, fileDiffsByKey, runningActions, selectedChangePaths],
  );
  const allChangedFilesSelected =
    changedFiles.length > 0 && selectedChangedFiles.length === changedFiles.length;
  const noChangedFilesSelected = selectedChangedFiles.length === 0;
  const partialChangedFilesSelected =
    changedFiles.length > 0 && !allChangedFilesSelected && !noChangedFilesSelected;
  const toggleAllChangedFilesSelection = useCallback(() => {
    setSelectedChangePaths(allChangedFilesSelected ? new Set() : new Set(changedPaths));
  }, [allChangedFilesSelected, changedPaths]);
  const vcsStatusFingerprint = useMemo(() => {
    const status = vcsStatus.data;
    if (!status) return null;
    return JSON.stringify({
      refName: status.refName,
      hasUpstream: status.hasUpstream,
      aheadCount: status.aheadCount,
      behindCount: status.behindCount,
      workingTree: status.workingTree,
    });
  }, [vcsStatus.data]);
  const presentationState = useMemo(
    () =>
      resolveSourceControlPanelPresentationState({
        snapshot,
        loading,
        error,
        statusPending: vcsStatus.isPending,
        statusError: vcsStatus.error,
      }),
    [error, loading, snapshot, vcsStatus.error, vcsStatus.isPending],
  );
  const isActionRunning = useCallback(
    (actionKey: string) => runningActions.has(actionKey),
    [runningActions],
  );

  const resetWorkingTreeFileEnrichment = useCallback(() => {
    workingTreeEnrichmentGenerationRef.current += 1;
    if (workingTreeEnrichmentTimerRef.current !== null) {
      window.clearTimeout(workingTreeEnrichmentTimerRef.current);
      workingTreeEnrichmentTimerRef.current = null;
    }
    pendingWorkingTreeEnrichmentPathsRef.current.clear();
    inFlightWorkingTreeEnrichmentPathsRef.current.clear();
    enrichedWorkingTreeFilesRef.current = new Map();
    hiddenWorkingTreePathsRef.current = new Set();
    setEnrichedWorkingTreeFilesByPath(new Map());
    setHiddenWorkingTreePaths(new Set());
  }, []);

  const applyWorkingTreeFileEnrichmentResult = useCallback(
    (result: VcsPanelWorkingTreeFileEnrichmentResult) => {
      setEnrichedWorkingTreeFilesByPath((current) => {
        const next = new Map(current);
        for (const hiddenPath of result.hiddenPaths) {
          next.delete(hiddenPath);
        }
        for (const file of result.files) {
          next.set(file.path, file);
        }
        enrichedWorkingTreeFilesRef.current = next;
        return next;
      });
      setHiddenWorkingTreePaths((current) => {
        const next = new Set(current);
        for (const hiddenPath of result.hiddenPaths) {
          next.add(hiddenPath);
        }
        hiddenWorkingTreePathsRef.current = next;
        return next;
      });
    },
    [],
  );

  const flushWorkingTreeFileEnrichmentQueue = useCallback(() => {
    workingTreeEnrichmentTimerRef.current = null;
    if (!api) return;
    const paths = [...pendingWorkingTreeEnrichmentPathsRef.current].filter(
      (path) =>
        !enrichedWorkingTreeFilesRef.current.has(path) &&
        !hiddenWorkingTreePathsRef.current.has(path) &&
        !inFlightWorkingTreeEnrichmentPathsRef.current.has(path),
    );
    pendingWorkingTreeEnrichmentPathsRef.current.clear();
    if (paths.length === 0) return;

    for (const path of paths) {
      inFlightWorkingTreeEnrichmentPathsRef.current.add(path);
    }
    const generation = workingTreeEnrichmentGenerationRef.current;
    void api.vcs
      .enrichWorkingTreeFiles({ cwd, paths })
      .then((result) => {
        if (workingTreeEnrichmentGenerationRef.current !== generation) return;
        applyWorkingTreeFileEnrichmentResult(result);
      })
      .catch((nextError: unknown) => {
        if (workingTreeEnrichmentGenerationRef.current === generation) {
          setError(errorMessage(nextError));
        }
      })
      .finally(() => {
        for (const path of paths) {
          inFlightWorkingTreeEnrichmentPathsRef.current.delete(path);
        }
      });
  }, [api, applyWorkingTreeFileEnrichmentResult, cwd]);

  const queueWorkingTreeFileEnrichment = useCallback(
    (file: PanelChangedFile) => {
      if (!api || !shouldEnrichWorkingTreeFile(file)) return;
      const path = file.path;
      if (
        enrichedWorkingTreeFilesRef.current.has(path) ||
        hiddenWorkingTreePathsRef.current.has(path) ||
        inFlightWorkingTreeEnrichmentPathsRef.current.has(path)
      ) {
        return;
      }
      pendingWorkingTreeEnrichmentPathsRef.current.add(path);
      if (workingTreeEnrichmentTimerRef.current !== null) return;
      workingTreeEnrichmentTimerRef.current = window.setTimeout(
        flushWorkingTreeFileEnrichmentQueue,
        50,
      );
    },
    [api, flushWorkingTreeFileEnrichmentQueue],
  );

  useEffect(
    () => () => {
      if (workingTreeEnrichmentTimerRef.current !== null) {
        window.clearTimeout(workingTreeEnrichmentTimerRef.current);
      }
    },
    [],
  );

  const syncChangedPathSelection = useCallback((groups: readonly VcsPanelChangeGroup[]) => {
    const nextChangedPaths = mergeChangeGroups(groups).map((file) => file.path);
    const currentPaths = new Set(nextChangedPaths);
    const previousPaths = previousChangedPathsRef.current;
    setSelectedChangePaths((current) => {
      const next = new Set([...current].filter((path) => currentPaths.has(path)));
      for (const path of nextChangedPaths) {
        if (!previousPaths.has(path)) {
          next.add(path);
        }
      }
      return next;
    });
    previousChangedPathsRef.current = currentPaths;
  }, []);

  const refresh = useCallback(async () => {
    if (!api) {
      setError("Version Control panel is unavailable for this connection runtime.");
      setLoading(false);
      return;
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    setLoading(true);
    try {
      do {
        refreshQueuedRef.current = false;
        setError(null);
        const nextSnapshot = await api.vcs.panelSnapshot({ cwd });
        resetWorkingTreeFileEnrichment();
        syncChangedPathSelection(nextSnapshot.changeGroups);
        setSnapshot(nextSnapshot);
        const expandedBranches = expandedBranchesForSnapshot(nextSnapshot, expandedTreeRef.current);
        const nextDetails = new Map(mapBranchDetails(nextSnapshot.branchDetails));
        setLoadingBranchDetails(new Set());
        if (expandedBranches.length > 0) {
          setLoadingBranchDetails(new Set(expandedBranches.map((request) => request.detailsKey)));
          const details = await Promise.all(
            expandedBranches.map((request) =>
              api.vcs.branchDetails({
                cwd,
                branch: request.branch,
                defaultCompareRef: nextSnapshot.defaultCompareRef,
                compareBaseRef:
                  request.compareBaseRef ??
                  compareBaseOverrides.get(request.detailsKey) ??
                  compareBaseOverrides.get(request.branch.name),
              }),
            ),
          );
          for (const [index, detail] of details.entries()) {
            const request = expandedBranches[index];
            if (!request) continue;
            nextDetails.set(request.detailsKey, detail);
            if (request.detailsKey === request.branch.name) {
              nextDetails.set(detail.fullRefName, detail);
              nextDetails.set(detail.name, detail);
            }
          }
        }
        setBranchDetailsByRef(nextDetails);
      } while (refreshQueuedRef.current);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      refreshInFlightRef.current = false;
      setLoadingBranchDetails(new Set());
      setLoading(false);
    }
  }, [api, compareBaseOverrides, cwd, resetWorkingTreeFileEnrichment, syncChangedPathSelection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (vcsStatusFingerprint === null) return;
    if (lastVcsStatusFingerprintRef.current === vcsStatusFingerprint) return;
    lastVcsStatusFingerprintRef.current = vcsStatusFingerprint;
    void refresh();
  }, [refresh, vcsStatusFingerprint]);

  useEffect(() => {
    expandedTreeRef.current = expandedTree;
  }, [expandedTree]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < 1_000) return;
      lastFocusRefreshAtRef.current = now;
      void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (actionKey: string, action: () => Promise<void>) => {
      setRunningActions((current) => new Set(current).add(actionKey));
      setError(null);
      try {
        await action();
        vcsStatus.refresh();
        await refresh();
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setRunningActions((current) => {
          const next = new Set(current);
          next.delete(actionKey);
          return next;
        });
      }
    },
    [refresh, vcsStatus.refresh],
  );

  const openFilePanel = useCallback(
    (path: string) => {
      useRightPanelStore.getState().openFile(threadRef, path);
    },
    [threadRef],
  );

  const openInVsCode = useCallback(
    async (path: string) => {
      const result = await openInPreferredEditor(resolvePathLinkTarget(path, cwd));
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const nextError = squashAtomCommandFailure(result);
      setError(nextError instanceof Error ? nextError.message : "Unable to open file.");
    },
    [cwd, openInPreferredEditor],
  );

  const confirm = useCallback(async (message: string) => {
    return (await readLocalApi()?.dialogs.confirm(message)) ?? window.confirm(message);
  }, []);

  const copyText = useCallback((value: string, missingMessage = "Nothing to copy.") => {
    if (!value) {
      setError(missingMessage);
      return;
    }
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      setError("Clipboard API unavailable.");
      return;
    }
    setError(null);
    void navigator.clipboard
      .writeText(value)
      .catch((nextError) => setError(errorMessage(nextError)));
  }, []);

  const openContextMenu = useCallback(
    <T extends string>(
      event: ReactMouseEvent,
      items: readonly ContextMenuItem<T>[],
      handlers: Partial<Record<T, () => Promise<void> | void>>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const localApi = readLocalApi();
        if (!localApi) return;
        const clicked = await localApi.contextMenu.show(items, {
          x: event.clientX,
          y: event.clientY,
        });
        if (!clicked) return;
        await handlers[clicked]?.();
      })();
    },
    [],
  );

  const openFileChangeContextMenu = useCallback(
    (event: ReactMouseEvent, file: VcsPanelFileChange) => {
      openContextMenu(
        event,
        [
          { id: "open-file", label: "Open file" },
          { id: "open-vscode", label: "Open in VS Code" },
          contextMenuSeparator("copy-separator"),
          { id: "copy-filename", label: "Copy filename", icon: "copy" },
          { id: "copy-full-path", label: "Copy full path to file", icon: "copy" },
        ],
        {
          "open-file": () => openFilePanel(file.path),
          "open-vscode": () => openInVsCode(file.path),
          "copy-filename": () => copyText(fileBasename(file.path)),
          "copy-full-path": () => copyText(resolvePathLinkTarget(file.path, cwd)),
        },
      );
    },
    [copyText, cwd, openContextMenu, openFilePanel, openInVsCode],
  );

  const fileDiffSourceKey = useCallback((source: FileDiffSource) => {
    switch (source.kind) {
      case "working-tree":
        return `working:${source.staged ? "staged" : "unstaged"}`;
      case "commit":
        return `commit:${source.sha}`;
      case "compare":
        return `compare:${source.baseRef}:${source.refName}`;
      case "stash":
        return `stash:${source.stashRef}`;
    }
  }, []);

  const fileDiffKey = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource) =>
      `${fileDiffSourceKey(source)}:${file.path}:${file.originalPath ?? ""}:${file.status}`,
    [fileDiffSourceKey],
  );

  const toggleFileDiff = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource) => {
      const key = fileDiffKey(file, source);
      const expanding = !expandedFileDiffs.has(key);
      setExpandedFileDiffs((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
          return next;
        }
        next.add(key);
        return next;
      });
      if (!api || !expanding) return;
      const existingState = fileDiffsByKey.get(key);
      if (existingState?.status === "loaded") return;
      setFileDiffsByKey((current) => {
        const next = new Map(current);
        next.set(key, { status: "loading" });
        return next;
      });
      void api.vcs
        .readFileDiff({
          cwd,
          path: file.path,
          staged: source.kind === "working-tree" ? source.staged : false,
          source,
        })
        .then((result) => {
          setFileDiffsByKey((current) => {
            const next = new Map(current);
            next.set(key, { status: "loaded", patch: result.patch });
            return next;
          });
        })
        .catch((nextError: unknown) => {
          setFileDiffsByKey((current) => {
            const next = new Map(current);
            next.set(key, { status: "error", message: errorMessage(nextError) });
            return next;
          });
        });
    },
    [api, cwd, expandedFileDiffs, fileDiffKey, fileDiffsByKey],
  );

  const renderFileDiff = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource) => {
      const state = fileDiffsByKey.get(fileDiffKey(file, source));
      if (!state || state.status === "loading") {
        return <div className="px-2 py-1 text-xs text-muted-foreground">Loading diff...</div>;
      }
      if (state.status === "error") {
        return <div className="px-2 py-1 text-xs text-destructive-foreground">{state.message}</div>;
      }
      return <InlineFileDiff patch={state.patch} resolvedTheme={resolvedTheme} />;
    },
    [fileDiffKey, fileDiffsByKey, resolvedTheme],
  );

  const fileDiffListProps = useCallback(
    (sourceForFile: (file: VcsPanelFileChange) => FileDiffSource) => ({
      getFileKey: (file: VcsPanelFileChange) => fileDiffKey(file, sourceForFile(file)),
      isFileExpanded: (file: VcsPanelFileChange) =>
        expandedFileDiffs.has(fileDiffKey(file, sourceForFile(file))),
      onFileToggle: (file: VcsPanelFileChange) => toggleFileDiff(file, sourceForFile(file)),
      renderExpandedFile: (file: VcsPanelFileChange) => renderFileDiff(file, sourceForFile(file)),
      onOpenFile: (file: VcsPanelFileChange) => openFilePanel(file.path),
      onOpenInVsCode: (file: VcsPanelFileChange) => void openInVsCode(file.path),
    }),
    [expandedFileDiffs, fileDiffKey, openFilePanel, openInVsCode, renderFileDiff, toggleFileDiff],
  );

  const switchRef = useCallback(
    (refName: string) =>
      runAction(`branch-switch:${refName}`, async () => {
        if (!api) return;
        const result = await api.vcs.switchRef({ cwd, refName });
        await onThreadRefChange?.({ branch: result.refName, worktreePath });
      }),
    [api, cwd, onThreadRefChange, runAction, worktreePath],
  );

  const deleteBranch = useCallback(
    (branch: VcsRef, force: boolean) =>
      void (async () => {
        const branchLabel = branch.isRemote
          ? `remote branch ${branch.name}`
          : `branch ${branch.name}`;
        if (!(await confirm(`Delete ${branchLabel}?`))) return;
        await runAction(
          `branch-delete:${branch.name}`,
          () => api?.vcs.deleteBranch({ cwd, branch, force }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const undoCommit = useCallback(
    (branchName: string, commit?: VcsPanelCommitSummary) =>
      void (async () => {
        const actionKey = commitUndoActionKey(branchName, commit?.sha);
        const confirmed = commit
          ? await confirm(
              `Undo ${commit.shortSha} and any newer commits on ${branchName}?${
                snapshot?.localBranches.find((branch) => branch.name === branchName)?.current
                  ? " Changes stay in the working tree."
                  : " This moves the branch back to that commit's parent."
              }`,
            )
          : await confirm(`Undo latest commit on ${branchName}?`);
        if (!confirmed) return;
        await runAction(
          actionKey,
          () =>
            api?.vcs.undoLatestCommit({
              cwd,
              branchName,
              ...(commit ? { sha: commit.sha } : {}),
            }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction, snapshot?.localBranches],
  );

  const mergeBranchIntoCurrent = useCallback(
    (branchName: string) =>
      void (async () => {
        if (!(await confirm(`Merge ${branchName} into the current branch?`))) return;
        await runAction(
          `branch-merge:${branchName}`,
          () => api?.vcs.mergeBranchIntoCurrent({ cwd, refName: branchName }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const rebaseCurrentOnto = useCallback(
    (refName: string) =>
      void (async () => {
        if (!(await confirm(`Rebase the current branch onto ${refName}?`))) return;
        await runAction(
          `rebase-current:${refName}`,
          () => api?.vcs.rebaseCurrentOnto({ cwd, refName }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const revertCommit = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        if (!(await confirm(`Revert commit ${commit.shortSha}?`))) return;
        await runAction(
          `commit-revert:${commit.sha}`,
          () => api?.vcs.revertCommit({ cwd, sha: commit.sha }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const checkoutCommitDetached = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        if (!(await confirm(`Checkout ${commit.shortSha} as detached HEAD?`))) return;
        await runAction(`commit-checkout:${commit.sha}`, async () => {
          if (!api) return;
          const result = await api.vcs.checkoutCommit({ cwd, sha: commit.sha });
          await onThreadRefChange?.({ branch: result.refName, worktreePath });
        });
      })(),
    [api, confirm, cwd, onThreadRefChange, runAction, worktreePath],
  );

  const createBranchFromCommit = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        const branchName = window.prompt(`Create branch from ${commit.shortSha}`, "");
        const trimmed = branchName?.trim();
        if (!trimmed) return;
        await runAction(`commit-create-branch:${commit.sha}`, async () => {
          await api?.vcs.createBranchFromCommit({
            cwd,
            sha: commit.sha,
            branchName: trimmed,
          });
        });
      })(),
    [api, cwd, runAction],
  );

  const publishBranch = useCallback(
    (branch: VcsRef, remoteName?: string, force = false) =>
      runAction(`branch-sync:${branch.name}`, async () => {
        await api?.vcs.pushBranch({ cwd, branchName: branch.name, remoteName, force });
      }),
    [api, cwd, runAction],
  );

  const publishBranchWithRemoteChoice = useCallback(
    (branch: VcsRef, force = false) => {
      if (!snapshot || branchHasUpstream(branch, snapshot)) {
        void publishBranch(branch, undefined, force);
        return;
      }
      if (snapshot.remotes.length > 1) {
        setPublishRemoteTarget({ branch, force });
        return;
      }
      void publishBranch(branch, snapshot.remotes[0]?.name, force);
    },
    [publishBranch, snapshot],
  );

  const runBranchSync = useCallback(
    (
      branch: VcsRef,
      {
        fetchFirst = false,
        force = false,
      }: {
        readonly fetchFirst?: boolean;
        readonly force?: boolean;
      } = {},
    ) => {
      if (!snapshot) return;
      const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
      const state = branchSyncState(branch, snapshot);
      if (state === "diverged") {
        setDivergedSyncBranch(branch);
        return;
      }
      if (state === "publish") {
        publishBranchWithRemoteChoice(branch, force);
        return;
      }
      if (!branch.current) {
        const actionKey =
          state === "fetch" ? `branch-fetch:${branch.name}` : `branch-sync:${branch.name}`;
        void runAction(actionKey, async () => {
          if (!api) return;
          if (state === "push") {
            await api.vcs.pushBranch({ cwd, branchName: branch.name, force });
            return;
          }
          if (state === "pull") {
            await api.vcs.pullBranch({
              cwd,
              branchName: branch.name,
              force,
            });
            return;
          }
          await api.vcs.fetchBranch({ cwd, branchName: branch.name });
        });
        return;
      }
      void runAction(`branch-sync:${branch.name}`, async () => {
        if (!api) return;
        if (fetchFirst) {
          await api.vcs.fetchBranch({ cwd, branchName: branch.name });
        }
        if (aheadCount > 0) {
          await api.vcs.pushBranch({ cwd, branchName: branch.name });
          return;
        }
        if (behindCount > 0) {
          await api.vcs.pullBranch({
            cwd,
            branchName: branch.name,
            force,
          });
          return;
        }
        await api.vcs.fetchBranch({ cwd, branchName: branch.name });
      });
    },
    [api, cwd, publishBranchWithRemoteChoice, runAction, snapshot],
  );

  const syncBranch = useCallback(
    (branch: VcsRef, event: ReactMouseEvent<HTMLButtonElement>) =>
      runBranchSync(branch, {
        fetchFirst: shouldFetchBeforePull(event),
        force: isActionForced(event),
      }),
    [runBranchSync],
  );

  const runDivergedSync = useCallback(
    (mode: "force-pull" | "merge" | "force-push") => {
      const branch = divergedSyncBranch;
      setDivergedSyncBranch(null);
      if (!branch) return;
      void runAction(`branch-sync:${branch.name}`, async () => {
        if (!api) return;
        if (mode === "force-push") {
          await api.vcs.pushBranch({ cwd, branchName: branch.name, force: true });
          return;
        }
        if (mode === "force-pull") {
          await api.vcs.pullBranch({ cwd, branchName: branch.name, force: true });
          return;
        }
        if (!branch.current) {
          console.warn("Ignored diverged merge sync for a non-current branch", {
            branchName: branch.name,
          });
          return;
        }
        await api.vcs.pullBranch({ cwd, branchName: branch.name, merge: true });
        await api.vcs.pushBranch({ cwd, branchName: branch.name });
      });
    },
    [api, cwd, divergedSyncBranch, runAction],
  );

  const fetchActionableBranches = useCallback(
    () => runAction("work-fetch", () => api?.vcs.fetchAllRemotes({ cwd }) ?? Promise.resolve()),
    [api, cwd, runAction],
  );

  useEffect(() => {
    if (!api) return;
    const interval = window.setInterval(
      () => {
        if (runningActions.has("work-fetch")) return;
        void fetchActionableBranches();
      },
      5 * 60 * 1_000,
    );
    return () => window.clearInterval(interval);
  }, [api, fetchActionableBranches, runningActions]);

  const runPanelCommit = useCallback(
    (message: string) => {
      const commitMessage = message.trim();
      return runAction("changes-commit", async () => {
        setCommitDialogOpen(false);
        setDialogCommitMessage("");
        await gitAction.run({
          actionId: newCommandId(),
          action: "commit",
          ...(commitMessage ? { commitMessage } : {}),
          filePaths: [...selectedChangePathList],
        });
      });
    },
    [gitAction, runAction, selectedChangePathList],
  );

  const runGeneratedPanelCommit = useCallback(() => {
    return runPanelCommit("");
  }, [runPanelCommit]);

  const openCommitDialog = useCallback(() => {
    setDialogCommitMessage("");
    setCommitDialogOpen(true);
  }, []);

  const createStash = useCallback(
    (paths: readonly string[], message?: string) => {
      const stashMessage = message?.trim();
      return runAction("changes-stash", async () => {
        if (!api) return;
        await api.vcs.createStash({
          cwd,
          mode: "all",
          includeUntracked: true,
          paths: [...paths],
          ...(stashMessage ? { message: stashMessage } : {}),
        });
      });
    },
    [api, cwd, runAction],
  );

  const runGeneratedPanelStash = useCallback(() => {
    return createStash(selectedChangePathList);
  }, [createStash, selectedChangePathList]);

  const openStashDialog = useCallback((label: string, paths: readonly string[]) => {
    setStashDialogTarget({ label, paths });
    setDialogStashMessage("");
  }, []);

  const runPanelStash = useCallback(() => {
    if (!stashDialogTarget) return;
    const paths = stashDialogTarget.paths;
    const message = dialogStashMessage.trim();
    setStashDialogTarget(null);
    setDialogStashMessage("");
    void createStash(paths, message);
  }, [createStash, dialogStashMessage, stashDialogTarget]);

  const discardSelectedChanges = useCallback(
    () =>
      void (async () => {
        if (selectedChangedFiles.length === 0) return;
        const countLabel =
          selectedChangedFiles.length === 1
            ? "the selected change"
            : `${selectedChangedFiles.length} selected changes`;
        if (!(await confirm(`Discard ${countLabel}?`))) return;
        const stagedPaths = uniquePaths(
          selectedChangedFiles
            .filter((file) => file.hasStagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        const unstagedPaths = uniquePaths(
          selectedChangedFiles
            .filter((file) => file.hasUnstagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        await runAction("changes-discard-selected", async () => {
          if (!api) return;
          if (unstagedPaths.length > 0) {
            await api.vcs.discardFiles({ cwd, paths: unstagedPaths, staged: false });
          }
          if (stagedPaths.length > 0) {
            await api.vcs.discardFiles({ cwd, paths: stagedPaths, staged: true });
          }
        });
      })(),
    [api, confirm, cwd, runAction, selectedChangedFiles],
  );

  const toggleSection = useCallback((key: SectionKey) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isTreeExpanded = useCallback(
    (key: string, defaultExpanded = false) =>
      defaultExpanded ? !collapsedDefaultTree.has(key) : expandedTree.has(key),
    [collapsedDefaultTree, expandedTree],
  );

  const toggleTree = useCallback((key: string, defaultExpanded = false) => {
    if (defaultExpanded) {
      setCollapsedDefaultTree((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    setExpandedTree((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadBranchDetails = useCallback(
    async (branch: VcsRef, compareBaseRef?: string, detailsKey = branch.name) => {
      if (!api || !snapshot) return;
      if (!compareBaseRef && branchDetailsByRef.has(detailsKey)) return;
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const details = await api.vcs.branchDetails({
          cwd,
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          compareBaseRef:
            compareBaseRef ??
            compareBaseOverrides.get(detailsKey) ??
            compareBaseOverrides.get(branch.name),
        });
        setBranchDetailsByRef((current) => {
          const next = new Map(current);
          next.set(detailsKey, details);
          if (detailsKey === branch.name) {
            next.set(details.fullRefName, details);
            next.set(details.name, details);
          }
          return next;
        });
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setLoadingBranchDetails((current) => {
          const next = new Set(current);
          next.delete(detailsKey);
          return next;
        });
      }
    },
    [api, branchDetailsByRef, compareBaseOverrides, cwd, snapshot],
  );

  const chooseCompareBase = useCallback(
    (baseRef: string) => {
      const target = compareBaseDialogTarget;
      setCompareBaseDialogTarget(null);
      setCompareBaseQuery("");
      if (!target) return;
      setCompareBaseOverrides((current) => {
        const next = new Map(current);
        next.set(target.detailsKey, baseRef);
        return next;
      });
      void loadBranchDetails(target.branch, baseRef, target.detailsKey);
    },
    [compareBaseDialogTarget, loadBranchDetails],
  );

  const toggleBranchTree = useCallback(
    (key: string, branch: VcsRef, compareBaseRef?: string, detailsKey = branch.name) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadBranchDetails(branch, compareBaseRef, detailsKey);
    },
    [expandedTree, loadBranchDetails, toggleTree],
  );

  const toggleBranchTreeFromKeyboard = useCallback(
    (
      key: string,
      branch: VcsRef,
      event: ReactKeyboardEvent<HTMLDivElement>,
      compareBaseRef?: string,
      detailsKey = branch.name,
    ) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleBranchTree(key, branch, compareBaseRef, detailsKey);
    },
    [toggleBranchTree],
  );

  const loadMoreBranchCommits = useCallback(
    async (branch: VcsRef, details: VcsPanelBranchDetails, kind: BranchCommitListKind) => {
      const loadedCount =
        kind === "ahead"
          ? details.aheadCommits.length
          : kind === "behind"
            ? details.behindCommits.length
            : kind === "compare-history"
              ? details.compareCommits.length
              : details.commits.length;
      const remaining =
        kind === "ahead"
          ? details.aheadCommitsRemaining
          : kind === "behind"
            ? details.behindCommitsRemaining
            : kind === "compare-history"
              ? details.compareCommitsRemaining
              : details.commitsRemaining;
      if (!api || remaining <= 0) return;
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(branch.name);
        return next;
      });
      try {
        const result = await api.vcs.branchCommits({
          cwd,
          branch,
          baseRef: details.baseRef,
          kind,
          skip: loadedCount,
          limit: COMMIT_PAGE_SIZE,
        });
        setBranchDetailsByRef((current) => {
          const nextDetails = current.get(details.fullRefName) ?? details;
          const merged =
            kind === "ahead"
              ? {
                  ...nextDetails,
                  aheadCommits: [...nextDetails.aheadCommits, ...result.commits],
                  aheadCommitsRemaining: result.remaining,
                }
              : kind === "behind"
                ? {
                    ...nextDetails,
                    behindCommits: [...nextDetails.behindCommits, ...result.commits],
                    behindCommitsRemaining: result.remaining,
                  }
                : kind === "compare-history"
                  ? {
                      ...nextDetails,
                      compareCommits: [...nextDetails.compareCommits, ...result.commits],
                      compareCommitsRemaining: result.remaining,
                    }
                  : {
                      ...nextDetails,
                      commits: [...nextDetails.commits, ...result.commits],
                      commitsRemaining: result.remaining,
                    };
          const next = new Map(current);
          next.set(merged.fullRefName, merged);
          next.set(merged.name, merged);
          return next;
        });
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setLoadingBranchDetails((current) => {
          const next = new Set(current);
          next.delete(branch.name);
          return next;
        });
      }
    },
    [api, cwd],
  );

  const loadStashDetails = useCallback(
    async (stashRef: string) => {
      if (!api || stashDetailsByRef.has(stashRef)) return;
      setLoadingStashDetails((current) => {
        const next = new Set(current);
        next.add(stashRef);
        return next;
      });
      try {
        const details = await api.vcs.stashDetails({ cwd, stashRef });
        setStashDetailsByRef((current) => {
          const next = new Map(current);
          next.set(details.refName, details);
          return next;
        });
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setLoadingStashDetails((current) => {
          const next = new Set(current);
          next.delete(stashRef);
          return next;
        });
      }
    },
    [api, cwd, stashDetailsByRef],
  );

  const toggleStashTree = useCallback(
    (key: string, stashRef: string) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadStashDetails(stashRef);
    },
    [expandedTree, loadStashDetails, toggleTree],
  );

  const toggleTreeFromKeyboard = useCallback(
    (key: string, event: ReactKeyboardEvent<HTMLDivElement>, defaultExpanded = false) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleTree(key, defaultExpanded);
    },
    [toggleTree],
  );

  const startSectionResize = useCallback(
    (key: SectionKey, event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const openKeys = SECTION_ORDER.filter((sectionKey) => !collapsed.has(sectionKey));
      const index = openKeys.indexOf(key);
      if (index < 0 || openKeys.length < 2) return;
      const adjacentKey = openKeys[index + 1] ?? openKeys[index - 1];
      if (!adjacentKey) return;
      const direction = openKeys[index + 1] ? 1 : -1;
      const startY = event.clientY;
      const startCurrent = sectionWeights[key];
      const startAdjacent = sectionWeights[adjacentKey];
      const total = startCurrent + startAdjacent;
      const containerHeight = Math.max(containerRef.current?.clientHeight ?? 1, 1);
      const onMove = (moveEvent: MouseEvent) => {
        const deltaWeight = ((moveEvent.clientY - startY) / containerHeight) * total * direction;
        const nextCurrent = Math.min(
          total - MIN_SECTION_WEIGHT,
          Math.max(MIN_SECTION_WEIGHT, startCurrent + deltaWeight),
        );
        setSectionWeights((current) => ({
          ...current,
          [key]: nextCurrent,
          [adjacentKey]: total - nextCurrent,
        }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapsed, sectionWeights],
  );

  const section = (key: SectionKey, children: ReactNode, action?: ReactNode) => (
    <CollapsibleSection
      key={key}
      sectionKey={key}
      title={SECTION_TITLES[key]}
      collapsed={collapsed.has(key)}
      weight={sectionWeights[key]}
      onToggle={() => toggleSection(key)}
      onResizeStart={startSectionResize}
      action={action}
    >
      {children}
    </CollapsibleSection>
  );

  if (presentationState.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {presentationState.message}
      </div>
    );
  }

  if (presentationState.status === "unavailable") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="relative rounded border border-destructive/35 bg-destructive/10 py-2 pl-2 pr-9 text-xs text-destructive-foreground">
          <div className="max-h-20 overflow-auto whitespace-pre-wrap break-words">
            {presentationState.message}
          </div>
          <div className="absolute right-1 top-1">
            <IconButton
              label="Copy error"
              disabled={!presentationState.canCopyError}
              onClick={() => copyText(error ?? "", "No error to copy.")}
            >
              <Copy className="size-3.5" />
            </IconButton>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
    );
  }

  if (!snapshot) {
    return null;
  }

  const toggleChangedFileSelection = (path: string, checked: boolean) => {
    setSelectedChangePaths((current) => {
      const next = new Set(current);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const renderWorkingFile = (file: PanelChangedFile) => {
    const selected = selectedChangePaths.has(file.path);
    const discardKey = `file-discard:${file.path}`;
    const diffSource = {
      kind: "working-tree",
      staged: file.hasStagedChanges,
    } satisfies FileDiffSource;
    const diffExpanded = expandedFileDiffs.has(fileDiffKey(file, diffSource));
    const discardFile = () =>
      void (async () => {
        if (!(await confirm(`Discard changes in ${file.path}?`))) return;
        await runAction(discardKey, async () => {
          if (!api) return;
          const paths = operationPathsForFile(file);
          if (file.hasUnstagedChanges) {
            await api.vcs.discardFiles({ cwd, paths, staged: false });
          }
          if (file.hasStagedChanges) {
            await api.vcs.discardFiles({ cwd, paths, staged: true });
          }
        });
      })();
    return (
      <div key={file.path} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
          onClick={() => toggleFileDiff(file, diffSource)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleFileDiff(file, diffSource);
          }}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                { id: "open-file", label: "Open file" },
                { id: "open-vscode", label: "Open in VS Code" },
                contextMenuSeparator("discard-separator"),
                {
                  id: "discard",
                  label: "Discard change",
                  destructive: true,
                  disabled: isActionRunning(discardKey),
                  icon: "trash",
                },
                contextMenuSeparator("copy-separator"),
                { id: "copy-filename", label: "Copy filename", icon: "copy" },
                { id: "copy-full-path", label: "Copy full path to file", icon: "copy" },
              ],
              {
                discard: discardFile,
                "open-file": () => openFilePanel(file.path),
                "open-vscode": () => openInVsCode(file.path),
                "copy-filename": () => copyText(fileBasename(file.path)),
                "copy-full-path": () => copyText(resolvePathLinkTarget(file.path, cwd)),
              },
            )
          }
        >
          {diffExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span onClick={(event) => event.stopPropagation()}>
            <Checkbox
              checked={selected}
              disabled={isActionRunning(discardKey)}
              aria-label={selected ? `Deselect ${file.path}` : `Select ${file.path}`}
              onCheckedChange={(checked) => toggleChangedFileSelection(file.path, checked === true)}
            />
          </span>
          <span
            className={cn(
              "w-3 shrink-0 text-center text-[10px] font-semibold uppercase",
              fileStatusColor(file.status),
            )}
          >
            {fileStatusLetter(file.status)}
          </span>
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          <StatLabels insertions={file.insertions} deletions={file.deletions} />
          <RowActions>
            <IconButton
              label="Discard changes"
              destructive
              disabled={isActionRunning(discardKey)}
              loading={isActionRunning(discardKey)}
              onClick={discardFile}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            <IconButton label="Open file" onClick={() => openFilePanel(file.path)}>
              <FileText className="size-3.5" />
            </IconButton>
            <IconButton label="Open in VS Code" onClick={() => void openInVsCode(file.path)}>
              <VisualStudioCode className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {diffExpanded ? (
          <div className="ml-4 border-l border-border/60 pl-1">
            {renderFileDiff(file, diffSource)}
          </div>
        ) : null}
      </div>
    );
  };

  const renderWorkingFileItem = ({ item }: { item: PanelChangedFile }) => (
    <WorkingFileVirtualRow
      file={item}
      onRendered={queueWorkingTreeFileEnrichment}
      renderFile={renderWorkingFile}
    />
  );

  const renderCommit = (
    commit: VcsPanelCommitSummary,
    options: { readonly undoBranchName?: string } = {},
  ) => {
    const key = treeKey("commit", commit.sha);
    const expanded = expandedTree.has(key);
    const stats = sumFiles(commit.files);
    const relativeDate = formatRelativeDate(commit.authoredAt);
    const undoKey = options.undoBranchName
      ? commitUndoActionKey(options.undoBranchName, commit.sha)
      : null;
    const revertKey = `commit-revert:${commit.sha}`;
    const rebaseKey = `rebase-current:${commit.sha}`;
    const checkoutKey = `commit-checkout:${commit.sha}`;
    const createBranchKey = `commit-create-branch:${commit.sha}`;
    const canUndoCommit = options.undoBranchName !== undefined;
    return (
      <div key={commit.sha} className="space-y-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
                onClick={() => toggleTree(key)}
                onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      ...(canUndoCommit
                        ? [
                            {
                              id: "undo",
                              label: "Undo",
                              disabled: undoKey ? isActionRunning(undoKey) : false,
                            },
                          ]
                        : []),
                      { id: "revert", label: "Revert commit" },
                      { id: "rebase", label: "Rebase current branch onto commit" },
                      { id: "checkout", label: "Checkout as detached HEAD" },
                      { id: "create-branch", label: "Create branch from commit" },
                      contextMenuSeparator("copy-separator"),
                      { id: "copy-sha", label: "Copy SHA", icon: "copy" },
                      { id: "copy-message", label: "Copy message", icon: "copy" },
                    ],
                    {
                      undo: () => {
                        if (options.undoBranchName) undoCommit(options.undoBranchName, commit);
                      },
                      revert: () => revertCommit(commit),
                      rebase: () => rebaseCurrentOnto(commit.sha),
                      checkout: () => checkoutCommitDetached(commit),
                      "create-branch": () => createBranchFromCommit(commit),
                      "copy-sha": () => copyText(commit.sha),
                      "copy-message": () => copyText(commit.message),
                    },
                  )
                }
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <AuthorAvatar commit={commit} />
                <span className="min-w-0 flex-1 truncate">{commit.message}</span>
                <RefLabels commit={commit} />
                <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
                {relativeDate ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
                ) : null}
                <RowActions>
                  {canUndoCommit && options.undoBranchName ? (
                    <IconButton
                      label="Undo"
                      disabled={undoKey ? isActionRunning(undoKey) : false}
                      loading={undoKey ? isActionRunning(undoKey) : false}
                      onClick={() => {
                        if (options.undoBranchName) undoCommit(options.undoBranchName, commit);
                      }}
                    >
                      <Undo2 className="size-3.5" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label="Revert commit"
                    disabled={isActionRunning(revertKey)}
                    loading={isActionRunning(revertKey)}
                    onClick={() => revertCommit(commit)}
                  >
                    <RotateCcw className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Rebase current branch onto commit"
                    disabled={isActionRunning(rebaseKey)}
                    loading={isActionRunning(rebaseKey)}
                    onClick={() => rebaseCurrentOnto(commit.sha)}
                  >
                    <GitMerge className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Checkout as detached HEAD"
                    disabled={isActionRunning(checkoutKey)}
                    loading={isActionRunning(checkoutKey)}
                    onClick={() => checkoutCommitDetached(commit)}
                  >
                    <GitCommit className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Create branch from commit"
                    disabled={isActionRunning(createBranchKey)}
                    loading={isActionRunning(createBranchKey)}
                    onClick={() => createBranchFromCommit(commit)}
                  >
                    <GitBranchPlus className="size-3.5" />
                  </IconButton>
                </RowActions>
              </div>
            }
          />
          <TooltipPopup side="top" className="max-w-80">
            <CommitTooltip commit={commit} />
          </TooltipPopup>
        </Tooltip>
        {expanded ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            <FileChangeList
              files={commit.files}
              emptyLabel="No file changes."
              onFileContextMenu={openFileChangeContextMenu}
              {...fileDiffListProps(() => ({ kind: "commit", sha: commit.sha }))}
            />
          </div>
        ) : null}
      </div>
    );
  };

  const renderBranchSubsection = ({
    details,
    id,
    title,
    count,
    children,
    icon,
    action,
    defaultExpanded,
  }: {
    readonly details: VcsPanelBranchDetails;
    readonly id: string;
    readonly title: ReactNode;
    readonly count: ReactNode | null;
    readonly children: ReactNode;
    readonly icon?: ReactNode;
    readonly action?: ReactNode;
    readonly defaultExpanded?: boolean;
  }) => {
    const key = treeKey("branch-subsection", `${details.fullRefName}:${id}`);
    const expanded = isTreeExpanded(key, defaultExpanded);
    return (
      <div className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key, defaultExpanded)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event, defaultExpanded)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {icon}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {action}
          {count !== null ? <span className="shrink-0 text-muted-foreground">{count}</span> : null}
        </div>
        {expanded ? <div className="ml-2 border-l border-border/60 pl-1">{children}</div> : null}
      </div>
    );
  };

  const renderBranchTree = (branch: VcsRef, details: VcsPanelBranchDetails, detailsKey: string) => {
    const unsyncedCommitShas = new Set(details.unsyncedCommitShas);
    const loadingDetails = loadingBranchDetails.has(branch.name);
    const aheadTotal = details.aheadCommits.length + details.aheadCommitsRemaining;
    const behindTotal = details.behindCommits.length + details.behindCommitsRemaining;
    const historyTotal = details.commits.length + details.commitsRemaining;
    const openCompareBaseDialog = () => {
      setCompareBaseDialogTarget({ branch, detailsKey });
      setCompareBaseQuery("");
    };
    const renderBranchCommit = (commit: VcsPanelCommitSummary) =>
      renderCommit(
        commit,
        unsyncedCommitShas.has(commit.sha) ? { undoBranchName: branch.name } : undefined,
      );
    return (
      <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
        <button
          type="button"
          className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={openCompareBaseDialog}
        >
          <span className="min-w-0 flex-1 truncate">vs. {details.baseRef ?? "choose base"}</span>
        </button>
        {aheadTotal > 0
          ? renderBranchSubsection({
              details,
              id: "ahead",
              title: `${aheadTotal} Ahead`,
              count: null,
              icon: <Upload className="size-3.5 shrink-0 text-success-foreground" />,
              children: (
                <div className="space-y-0.5">
                  {details.aheadCommits.map(renderBranchCommit)}
                  <LoadMoreCommitsButton
                    remaining={details.aheadCommitsRemaining}
                    loading={loadingDetails}
                    onClick={() => void loadMoreBranchCommits(branch, details, "ahead")}
                  />
                </div>
              ),
            })
          : null}
        {behindTotal > 0
          ? renderBranchSubsection({
              details,
              id: "behind",
              title: `${behindTotal} Behind`,
              count: null,
              icon: <Download className="size-3.5 shrink-0 text-warning-foreground" />,
              children: (
                <div className="space-y-0.5">
                  {details.behindCommits.map(renderBranchCommit)}
                  <LoadMoreCommitsButton
                    remaining={details.behindCommitsRemaining}
                    loading={loadingDetails}
                    onClick={() => void loadMoreBranchCommits(branch, details, "behind")}
                  />
                </div>
              ),
            })
          : null}
        {renderBranchSubsection({
          details,
          id: "commits",
          title: "History",
          count: commitCountLabel(historyTotal),
          children: (
            <div className="space-y-0.5">
              {details.commits.length === 0 ? (
                <div className="px-3 py-1 text-xs text-muted-foreground">No commits.</div>
              ) : (
                details.commits.map(renderBranchCommit)
              )}
              <LoadMoreCommitsButton
                remaining={details.commitsRemaining}
                loading={loadingDetails}
                onClick={() => void loadMoreBranchCommits(branch, details, "history")}
              />
            </div>
          ),
        })}
        {details.baseRef
          ? renderBranchSubsection({
              details,
              id: "compare-changes",
              title: "Changes",
              count: null,
              action: <FileChangeSummary files={details.compareFiles} />,
              children: (
                <FileChangeList
                  files={details.compareFiles}
                  emptyLabel="No changes."
                  onFileContextMenu={openFileChangeContextMenu}
                  {...fileDiffListProps(() => ({
                    kind: "compare",
                    baseRef: details.baseRef!,
                    refName: details.name,
                  }))}
                />
              ),
            })
          : null}
      </div>
    );
  };

  const branchRow = (
    branch: VcsRef,
    options: {
      readonly key?: string;
      readonly detailsKey?: string;
      readonly compareBaseRef?: string;
      readonly syncCounts?: { readonly aheadCount: number; readonly behindCount: number };
      readonly attention?: AttentionKind;
      readonly syncLabel?: string;
      readonly syncState?: BranchSyncState;
      readonly syncActionKey?: string;
      readonly fetchActionKey?: string;
      readonly onSync?: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
      readonly secondaryBadge?: ReactNode;
    } = {},
  ) => {
    const detailsKey = options.detailsKey ?? branch.name;
    const details = branchDetailsByRef.get(detailsKey);
    const key = options.key ?? treeKey("branch", branch.name);
    const expanded = expandedTree.has(key);
    const loadingDetails = loadingBranchDetails.has(detailsKey);
    const current = branch.current;
    const { aheadCount, behindCount } = options.syncCounts ?? branchSyncCounts(branch, snapshot);
    const hasUpstream = branchHasUpstream(branch, snapshot);
    const attention = options.attention ?? branchAttention(branch, snapshot);
    const syncState = options.syncState ?? branchSyncState(branch, snapshot);
    const switchKey = `branch-switch:${branch.name}`;
    const syncKey = options.syncActionKey ?? `branch-sync:${branch.name}`;
    const fetchKey = options.fetchActionKey ?? `branch-fetch:${branch.name}`;
    const deleteKey = `branch-delete:${branch.name}`;
    const undoKey = `branch-undo-latest:${branch.name}`;
    const mergeKey = `branch-merge:${branch.name}`;
    const rebaseKey = `rebase-current:${branch.name}`;
    const syncLabel = options.syncLabel ?? branchSyncActionLabel(syncState);
    const relativeDate = formatRelativeDate(branch.lastActivityAt);
    const switchDisabled = current || isActionRunning(switchKey);
    const syncDisabled = isActionRunning(syncKey) || isActionRunning(fetchKey);
    const deleteDisabled = current || isActionRunning(deleteKey);
    const runSync = (event?: ReactMouseEvent<HTMLButtonElement>) =>
      options.onSync
        ? options.onSync(event)
        : event
          ? syncBranch(branch, event)
          : runBranchSync(branch);
    return (
      <div key={key} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleBranchTree(key, branch, options.compareBaseRef, detailsKey)}
          onKeyDown={(event) =>
            toggleBranchTreeFromKeyboard(key, branch, event, options.compareBaseRef, detailsKey)
          }
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                { id: "switch", label: "Checkout", disabled: switchDisabled },
                { id: "sync", label: syncLabel, disabled: syncDisabled },
                ...(current && aheadCount > 0
                  ? [
                      {
                        id: "undo-latest",
                        label: "Undo latest commit",
                        disabled: isActionRunning(undoKey),
                      },
                    ]
                  : []),
                ...(!current
                  ? [
                      {
                        id: "merge",
                        label: "Merge branch into current",
                        disabled: isActionRunning(mergeKey),
                      },
                      {
                        id: "rebase",
                        label: "Rebase current branch onto branch",
                        disabled: isActionRunning(rebaseKey),
                      },
                    ]
                  : []),
                contextMenuSeparator("delete-separator-before"),
                {
                  id: "delete",
                  label: "Delete branch",
                  destructive: true,
                  disabled: deleteDisabled,
                  icon: "trash",
                },
                contextMenuSeparator("delete-separator-after"),
                { id: "copy-branch-name", label: "Copy branch name", icon: "copy" },
              ],
              {
                switch: () => switchRef(branch.name),
                sync: () => runSync(),
                delete: () => deleteBranch(branch, false),
                "undo-latest": () => undoCommit(branch.name),
                merge: () => mergeBranchIntoCurrent(branch.name),
                rebase: () => rebaseCurrentOnto(branch.name),
                "copy-branch-name": () => copyText(branch.name),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <AttentionIcon kind={attention} />
          <span className="min-w-0 flex-1 truncate text-sm">{branch.name}</span>
          <div className="pointer-events-none ml-auto flex min-w-0 shrink-0 items-center gap-1">
            {hasUpstream && aheadCount === 0 && behindCount === 0 ? (
              <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                <SyncedIcon />
              </span>
            ) : null}
            {!hasUpstream ? <CompactBadge>local</CompactBadge> : null}
            {options.secondaryBadge}
            {current ? <CompactBadge>current</CompactBadge> : null}
            {branch.isDefault ? <CompactBadge>default</CompactBadge> : null}
            {branch.worktreePath && !current ? <CompactBadge>worktree</CompactBadge> : null}
            <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
            {relativeDate ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
            ) : null}
          </div>
          <RowActions>
            <IconButton
              label="Checkout"
              disabled={switchDisabled}
              loading={isActionRunning(switchKey)}
              onClick={() => void switchRef(branch.name)}
            >
              <GitBranch className="size-3.5" />
            </IconButton>
            <IconButton
              label={syncLabel}
              disabled={syncDisabled}
              loading={isActionRunning(syncKey) || isActionRunning(fetchKey)}
              onClick={(event) => runSync(event)}
            >
              <BranchSyncActionIcon state={syncState} />
            </IconButton>
            <IconButton
              label="Delete branch. Shift: force."
              destructive
              disabled={deleteDisabled}
              loading={isActionRunning(deleteKey)}
              onClick={(event) => deleteBranch(branch, isActionForced(event))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            {current && aheadCount > 0 ? (
              <IconButton
                label="Undo latest commit"
                disabled={isActionRunning(undoKey)}
                loading={isActionRunning(undoKey)}
                onClick={() => undoCommit(branch.name)}
              >
                <Undo2 className="size-3.5" />
              </IconButton>
            ) : null}
            {!current ? (
              <>
                <IconButton
                  label="Merge branch into current"
                  disabled={isActionRunning(mergeKey)}
                  loading={isActionRunning(mergeKey)}
                  onClick={() => mergeBranchIntoCurrent(branch.name)}
                >
                  <GitMerge className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Rebase current branch onto branch"
                  disabled={isActionRunning(rebaseKey)}
                  loading={isActionRunning(rebaseKey)}
                  onClick={() => rebaseCurrentOnto(branch.name)}
                >
                  <GitPullRequestArrow className="size-3.5" />
                </IconButton>
              </>
            ) : null}
          </RowActions>
        </div>
        {expanded && details ? renderBranchTree(branch, details, detailsKey) : null}
        {expanded && !details && loadingDetails ? (
          <div className="ml-2 border-l border-border/60 px-2 py-1 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  };

  const remoteBranchRow = (branch: VcsRef, displayName: string, hasLocalBranch: boolean) => {
    const details = branchDetailsByRef.get(branch.name);
    const key = treeKey("remote-branch", `${branch.remoteName ?? "local"}:${displayName}`);
    const expanded = expandedTree.has(key);
    const loadingDetails = loadingBranchDetails.has(branch.name);
    const current = branch.current;
    const relativeDate = formatRelativeDate(branch.lastActivityAt);
    const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
    const hasUpstream = branchHasUpstream(branch, snapshot);
    const syncState = branchSyncState(branch, snapshot);
    const switchKey = `branch-switch:${branch.name}`;
    const syncKey = `branch-sync:${branch.name}`;
    const fetchKey = `branch-fetch:${branch.name}`;
    const deleteKey = `branch-delete:${branch.name}`;
    const undoKey = `branch-undo-latest:${branch.name}`;
    const mergeKey = `branch-merge:${branch.name}`;
    const rebaseKey = `rebase-current:${branch.name}`;
    const switchDisabled = current || isActionRunning(switchKey);
    const syncLabel = hasLocalBranch ? branchSyncActionLabel(syncState) : "Fetch branch";
    const syncDisabled = hasLocalBranch
      ? isActionRunning(syncKey) || isActionRunning(fetchKey)
      : isActionRunning(fetchKey);
    const deleteDisabled = isActionRunning(deleteKey);
    const fetchRemoteBranch = () =>
      void runAction(
        fetchKey,
        () => api?.vcs.fetchBranch({ cwd, branchName: branch.name }) ?? Promise.resolve(),
      );
    return (
      <div key={`${branch.remoteName ?? "local"}:${displayName}`} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleBranchTree(key, branch)}
          onKeyDown={(event) => toggleBranchTreeFromKeyboard(key, branch, event)}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                { id: "switch", label: "Checkout", disabled: switchDisabled },
                { id: "sync", label: syncLabel, disabled: syncDisabled },
                ...(current && aheadCount > 0
                  ? [
                      {
                        id: "undo-latest",
                        label: "Undo latest commit",
                        disabled: isActionRunning(undoKey),
                      },
                    ]
                  : []),
                ...(!current
                  ? [
                      {
                        id: "merge",
                        label: "Merge branch into current",
                        disabled: isActionRunning(mergeKey),
                      },
                      {
                        id: "rebase",
                        label: "Rebase current branch onto branch",
                        disabled: isActionRunning(rebaseKey),
                      },
                    ]
                  : []),
                contextMenuSeparator("delete-separator-before"),
                {
                  id: "delete",
                  label: hasLocalBranch ? "Delete branch" : "Delete remote branch",
                  destructive: true,
                  disabled: deleteDisabled,
                  icon: "trash",
                },
                contextMenuSeparator("delete-separator-after"),
                { id: "copy-branch-name", label: "Copy branch name", icon: "copy" },
              ],
              {
                switch: () => switchRef(branch.name),
                sync: () => (hasLocalBranch ? runBranchSync(branch) : fetchRemoteBranch()),
                delete: () => deleteBranch(branch, false),
                "undo-latest": () => undoCommit(branch.name),
                merge: () => mergeBranchIntoCurrent(branch.name),
                rebase: () => rebaseCurrentOnto(branch.name),
                "copy-branch-name": () => copyText(displayName),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {hasLocalBranch ? (
            <SyncedIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>
          <div className="pointer-events-none ml-auto flex min-w-0 shrink-0 items-center gap-1">
            {hasLocalBranch && !hasUpstream ? <CompactBadge>local</CompactBadge> : null}
            {current ? <CompactBadge>current</CompactBadge> : null}
            {branch.isDefault ? <CompactBadge>default</CompactBadge> : null}
            <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
            {relativeDate ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
            ) : null}
          </div>
          <RowActions>
            <IconButton
              label="Checkout"
              disabled={switchDisabled}
              loading={isActionRunning(switchKey)}
              onClick={() => void switchRef(branch.name)}
            >
              <GitBranch className="size-3.5" />
            </IconButton>
            {hasLocalBranch ? (
              <IconButton
                label={branchSyncActionLabel(syncState)}
                disabled={syncDisabled}
                loading={isActionRunning(syncKey) || isActionRunning(fetchKey)}
                onClick={(event) => syncBranch(branch, event)}
              >
                <BranchSyncActionIcon state={syncState} />
              </IconButton>
            ) : (
              <IconButton
                label="Fetch branch"
                disabled={syncDisabled}
                loading={isActionRunning(fetchKey)}
                onClick={fetchRemoteBranch}
              >
                <RefreshCw className="size-3.5" />
              </IconButton>
            )}
            <IconButton
              label={hasLocalBranch ? "Delete branch. Shift: force." : "Delete remote branch"}
              destructive
              disabled={deleteDisabled}
              loading={isActionRunning(deleteKey)}
              onClick={(event) => deleteBranch(branch, hasLocalBranch && isActionForced(event))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            {current && aheadCount > 0 ? (
              <IconButton
                label="Undo latest commit"
                disabled={isActionRunning(undoKey)}
                loading={isActionRunning(undoKey)}
                onClick={() => undoCommit(branch.name)}
              >
                <Undo2 className="size-3.5" />
              </IconButton>
            ) : null}
            {!current ? (
              <>
                <IconButton
                  label="Merge branch into current"
                  disabled={isActionRunning(mergeKey)}
                  loading={isActionRunning(mergeKey)}
                  onClick={() => mergeBranchIntoCurrent(branch.name)}
                >
                  <GitMerge className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Rebase current branch onto branch"
                  disabled={isActionRunning(rebaseKey)}
                  loading={isActionRunning(rebaseKey)}
                  onClick={() => rebaseCurrentOnto(branch.name)}
                >
                  <GitPullRequestArrow className="size-3.5" />
                </IconButton>
              </>
            ) : null}
          </RowActions>
        </div>
        {expanded && details ? renderBranchTree(branch, details, branch.name) : null}
        {expanded && !details && loadingDetails ? (
          <div className="ml-2 border-l border-border/60 px-2 py-1 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  };

  const remoteRow = (remote: VcsPanelRemote) => {
    const key = treeKey("remote", remote.name);
    const expanded = expandedTree.has(key);
    const fetchKey = `remote-fetch:${remote.name}`;
    const removeKey = `remote-remove:${remote.name}`;
    const fetchRemote = () =>
      void runAction(
        fetchKey,
        () => api?.vcs.fetchRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
      );
    const removeRemote = () =>
      void (async () => {
        if (!(await confirm(`Remove remote ${remote.name}?`))) return;
        await runAction(
          removeKey,
          () => api?.vcs.removeRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
        );
      })();
    const remoteUrl = remote.fetchUrl ?? remote.pushUrl ?? "";
    return (
      <div key={remote.name} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                { id: "fetch", label: "Fetch remote", disabled: isActionRunning(fetchKey) },
                contextMenuSeparator("remove-separator-before"),
                {
                  id: "remove",
                  label: "Remove remote",
                  destructive: true,
                  disabled: isActionRunning(removeKey),
                  icon: "trash",
                },
                contextMenuSeparator("remove-separator-after"),
                { id: "copy-name", label: "Copy name", icon: "copy" },
                { id: "copy-url", label: "Copy url", disabled: !remoteUrl, icon: "copy" },
              ],
              {
                fetch: fetchRemote,
                remove: removeRemote,
                "copy-name": () => copyText(remote.name),
                "copy-url": () => copyText(remoteUrl, "Remote URL unavailable."),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{remote.name}</span>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {remote.fetchUrl ?? "No fetch URL"}
          </span>
          <RowActions>
            <IconButton
              label="Fetch remote"
              disabled={isActionRunning(fetchKey)}
              loading={isActionRunning(fetchKey)}
              onClick={fetchRemote}
            >
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton
              label="Remove remote"
              destructive
              disabled={isActionRunning(removeKey)}
              loading={isActionRunning(removeKey)}
              onClick={removeRemote}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {expanded ? (
          <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
            {remote.branches.length === 0 ? (
              <div className="px-1.5 py-1 text-xs text-muted-foreground">No remote branches.</div>
            ) : (
              remote.branches.map((branch) => {
                const localBranch = localBranchForRemoteBranch(snapshot, remote, branch);
                return remoteBranchRow(
                  localBranch ?? remoteBranchRef(remote, branch),
                  branch.name,
                  localBranch !== null,
                );
              })
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const localBranchesRow = (branches: readonly VcsRef[]) => {
    const key = treeKey("remote", "local");
    const expanded = expandedTree.has(key);
    return (
      <div key="local" className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                contextMenuSeparator("copy-separator"),
                { id: "copy-name", label: "Copy name", icon: "copy" },
              ],
              {
                "copy-name": () => copyText("unpublished"),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">unpublished</span>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {branches.length === 1 ? "1 branch" : `${branches.length} branches`}
          </span>
        </div>
        {expanded ? (
          <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
            {branches.map((branch) => remoteBranchRow(branch, branch.name, true))}
          </div>
        ) : null}
      </div>
    );
  };

  const stashRow = (stash: VcsPanelStash) => {
    const key = treeKey("stash", stash.refName);
    const expanded = expandedTree.has(key);
    const details = stashDetailsByRef.get(stash.refName);
    const loadingDetails = loadingStashDetails.has(stash.refName);
    const applyKey = `stash-apply:${stash.refName}`;
    const popKey = `stash-pop:${stash.refName}`;
    const dropKey = `stash-drop:${stash.refName}`;
    const relativeDate = formatRelativeDate(stash.createdAt);
    const branchName = stashBranchName(stash);
    const applyStash = () =>
      void runAction(
        applyKey,
        () => api?.vcs.applyStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
      );
    const popStash = () =>
      void runAction(
        popKey,
        () => api?.vcs.popStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
      );
    const dropStash = () =>
      void (async () => {
        if (!(await confirm(`Drop ${stash.refName}?`))) return;
        await runAction(
          dropKey,
          () => api?.vcs.dropStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
        );
      })();
    return (
      <div key={stash.refName} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 min-w-0 items-center justify-between gap-1.5 rounded px-1.5 text-xs hover:bg-accent/60"
          onClick={() => toggleStashTree(key, stash.refName)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleStashTree(key, stash.refName);
          }}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                { id: "apply", label: "Apply stash", disabled: isActionRunning(applyKey) },
                { id: "pop", label: "Pop stash", disabled: isActionRunning(popKey) },
                contextMenuSeparator("drop-separator-before"),
                {
                  id: "drop",
                  label: "Drop stash",
                  destructive: true,
                  disabled: isActionRunning(dropKey),
                  icon: "trash",
                },
                contextMenuSeparator("drop-separator-after"),
                { id: "copy-stash-name", label: "Copy stash name", icon: "copy" },
                {
                  id: "copy-branch-name",
                  label: "Copy branch name",
                  disabled: !branchName,
                  icon: "copy",
                },
              ],
              {
                apply: applyStash,
                pop: popStash,
                drop: dropStash,
                "copy-stash-name": () => copyText(stash.refName),
                "copy-branch-name": () => copyText(branchName ?? "", "Stash branch unavailable."),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <Archive className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{stash.message}</span>
          {relativeDate ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
          ) : null}
          <span className="shrink-0 font-mono text-muted-foreground">{stash.refName}</span>
          <RowActions>
            <IconButton
              label="Apply stash"
              disabled={isActionRunning(applyKey)}
              loading={isActionRunning(applyKey)}
              onClick={applyStash}
            >
              <Download className="size-3.5" />
            </IconButton>
            <IconButton
              label="Pop stash"
              disabled={isActionRunning(popKey)}
              loading={isActionRunning(popKey)}
              onClick={popStash}
            >
              <Archive className="size-3.5" />
            </IconButton>
            <IconButton
              label="Drop stash"
              destructive
              disabled={isActionRunning(dropKey)}
              loading={isActionRunning(dropKey)}
              onClick={dropStash}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {expanded && details ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            <FileChangeList
              files={details.files}
              emptyLabel="No changes."
              onFileContextMenu={openFileChangeContextMenu}
              {...fileDiffListProps(() => ({ kind: "stash", stashRef: stash.refName }))}
            />
          </div>
        ) : null}
        {expanded && !details && loadingDetails ? (
          <div className="ml-2 border-l border-border/60 px-2 py-1 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  };

  const showRefreshSpinner =
    loading && presentationState.status === "ready" && presentationState.syncMessage !== null;
  const syncBannerMessage = showRefreshSpinner ? null : presentationState.syncMessage;
  const repositorySummary = (
    <div className="relative shrink-0 border-b border-border/70 px-2 py-1.5 pr-9 text-xs">
      {showRefreshSpinner ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={presentationState.syncMessage ?? "Refreshing repository state..."}
                className="absolute right-2 top-2 inline-flex size-5 items-center justify-center text-muted-foreground"
              >
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              </span>
            }
          />
          <TooltipPopup side="left">{presentationState.syncMessage}</TooltipPopup>
        </Tooltip>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium">
          {snapshot.status.refName ?? "Detached HEAD"}
        </span>
        <BranchBadge snapshot={snapshot} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>
          {changedFiles.length > 0
            ? changedFiles.length === 1
              ? "1 file"
              : `${changedFiles.length} files`
            : "Clean"}
        </span>
        <StatLabels
          insertions={snapshot.status.workingTree.insertions}
          deletions={snapshot.status.workingTree.deletions}
        />
        {snapshot.status.aheadOfDefaultCount ? (
          <span>{snapshot.status.aheadOfDefaultCount} ahead of default</span>
        ) : null}
      </div>
      {syncBannerMessage ? (
        <div
          className={cn(
            "relative mt-1 rounded border py-1.5 pl-2 pr-8",
            error
              ? "border-destructive/35 bg-destructive/10 text-destructive-foreground"
              : "border-border/70 bg-muted/45 text-muted-foreground",
          )}
        >
          <div className="max-h-20 overflow-auto whitespace-pre-wrap break-words">
            {syncBannerMessage}
          </div>
          <div className="absolute right-1 top-1">
            <IconButton
              label="Copy status"
              disabled={!error}
              onClick={() => copyText(error ?? "", "No error to copy.")}
            >
              <Copy className="size-3.5" />
            </IconButton>
          </div>
        </div>
      ) : null}
    </div>
  );

  const changesSection = (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {changedFiles.length === 0 ? (
        <div className="px-1 py-1 text-sm text-muted-foreground">Working tree clean</div>
      ) : (
        <>
          <div className="flex h-6 shrink-0 items-center justify-between gap-2 rounded px-1 text-xs font-medium uppercase text-muted-foreground">
            <div className="flex min-w-0 items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center">
                      <Checkbox
                        checked={allChangedFilesSelected}
                        indeterminate={partialChangedFilesSelected}
                        aria-label={
                          allChangedFilesSelected ? "Unselect all files" : "Select all files"
                        }
                        onCheckedChange={toggleAllChangedFilesSelection}
                      />
                    </span>
                  }
                />
                <TooltipPopup side="top">
                  {allChangedFilesSelected ? "Unselect all files" : "Select all files"}
                </TooltipPopup>
              </Tooltip>
              <span className="min-w-0 truncate">
                {selectedChangedFiles.length} of {changedFiles.length} files selected
              </span>
              <StatLabels
                insertions={selectedChangeStats.insertions}
                deletions={selectedChangeStats.deletions}
              />
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                label="Commit selected changes. Shift: message."
                disabled={
                  isActionRunning("changes-commit") ||
                  gitAction.isPending ||
                  selectedChangedFiles.length === 0
                }
                loading={isActionRunning("changes-commit") || gitAction.isPending}
                onClick={(event) =>
                  event.shiftKey ? openCommitDialog() : void runGeneratedPanelCommit()
                }
              >
                <GitCommit className="size-3.5" />
              </IconButton>
              <IconButton
                label="Stash selected changes. Shift: message."
                disabled={isActionRunning("changes-stash") || selectedChangedFiles.length === 0}
                loading={isActionRunning("changes-stash")}
                onClick={(event) =>
                  event.shiftKey
                    ? openStashDialog("selected", selectedChangePathList)
                    : void runGeneratedPanelStash()
                }
              >
                <Archive className="size-3.5" />
              </IconButton>
              <IconButton
                label="Discard selected changes"
                destructive
                disabled={
                  isActionRunning("changes-discard-selected") || selectedChangedFiles.length === 0
                }
                loading={isActionRunning("changes-discard-selected")}
                onClick={discardSelectedChanges}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <LegendList<PanelChangedFile>
              data={changedFiles}
              keyExtractor={(file) => file.path}
              renderItem={renderWorkingFileItem}
              estimatedItemSize={WORKING_FILE_ROW_ESTIMATED_HEIGHT}
              drawDistance={WORKING_FILE_DRAW_DISTANCE}
              extraData={workingFileListExtraData}
              className="scrollbar-gutter-both h-full overflow-x-hidden overscroll-y-contain"
            />
          </div>
        </>
      )}
    </div>
  );

  type WorkItem =
    | {
        readonly kind: "working-tree";
        readonly key: string;
        readonly attention: AttentionKind;
        readonly activity: number;
      }
    | {
        readonly kind: "branch";
        readonly key: string;
        readonly branch: VcsRef;
        readonly attention: AttentionKind;
        readonly activity: number;
      }
    | {
        readonly kind: "fork-branch";
        readonly key: string;
        readonly branch: VcsRef;
        readonly fork: VcsPanelSnapshotResult["actionableForkBranches"][number];
        readonly attention: AttentionKind;
        readonly activity: number;
      }
    | {
        readonly kind: "stash";
        readonly key: string;
        readonly stash: VcsPanelStash;
        readonly attention: AttentionKind;
        readonly activity: number;
      };

  const currentBranch = snapshot.localBranches.find((branch) => branch.current) ?? null;
  const localBranchesWithoutUpstream = localOnlyBranches(snapshot);
  const workingTreeAttention: AttentionKind = changedFiles.some((file) => file.hasConflicts)
    ? "conflicts"
    : changedFiles.length > 0
      ? "dirty"
      : "stale";
  const workItems: WorkItem[] = [
    ...(changedFiles.length > 0
      ? [
          {
            kind: "working-tree" as const,
            key: "working-tree",
            attention: workingTreeAttention,
            activity: currentBranch ? branchActivityTimestamp(currentBranch) : 0,
          },
        ]
      : []),
    ...snapshot.localBranches
      .filter((branch) => {
        const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
        return !branchHasUpstream(branch, snapshot) || aheadCount > 0 || behindCount > 0;
      })
      .map((branch) => ({
        kind: "branch" as const,
        key: `branch:${branch.name}`,
        branch,
        attention: branchAttention(branch, snapshot),
        activity: branchActivityTimestamp(branch),
      })),
    ...snapshot.actionableForkBranches.flatMap((fork) => {
      const branch = snapshot.localBranches.find(
        (localBranch) => localBranch.name === fork.localBranchName,
      );
      if (!branch) return [];
      return [
        {
          kind: "fork-branch" as const,
          key: `fork:${fork.localBranchName}:${fork.remoteRefName}`,
          branch,
          fork,
          attention: "behind" as const,
          activity: branchActivityTimestamp(fork),
        },
      ];
    }),
    ...snapshot.stashes.map((stash) => ({
      kind: "stash" as const,
      key: `stash:${stash.refName}`,
      stash,
      attention: "dirty" as const,
      activity: stashActivityTimestamp(stash),
    })),
  ].toSorted((left, right) => {
    if (left.kind === "working-tree" && right.kind !== "working-tree") return -1;
    if (right.kind === "working-tree" && left.kind !== "working-tree") return 1;
    const attention = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention];
    if (attention !== 0) return attention;
    return right.activity - left.activity;
  });

  const renderWorkingTreeRow = () => {
    const key = treeKey("work", "working-tree");
    const expanded = isTreeExpanded(key, true);
    const { aheadCount, behindCount } = currentBranch
      ? branchSyncCounts(currentBranch, snapshot)
      : { aheadCount: 0, behindCount: 0 };
    return (
      <div className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key, true)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event, true)}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                {
                  id: "commit-selected",
                  label: "Commit selected changes",
                  disabled:
                    isActionRunning("changes-commit") ||
                    gitAction.isPending ||
                    selectedChangedFiles.length === 0,
                },
                {
                  id: "stash-selected",
                  label: "Stash selected changes",
                  disabled: isActionRunning("changes-stash") || selectedChangedFiles.length === 0,
                },
                contextMenuSeparator("discard-separator-before"),
                {
                  id: "discard-selected",
                  label: "Discard selected changes",
                  destructive: true,
                  disabled:
                    isActionRunning("changes-discard-selected") ||
                    selectedChangedFiles.length === 0,
                  icon: "trash",
                },
              ],
              {
                "commit-selected": () => void runGeneratedPanelCommit(),
                "stash-selected": () => void runGeneratedPanelStash(),
                "discard-selected": discardSelectedChanges,
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <AttentionIcon kind={workingTreeAttention} />
          <span className="min-w-0 flex-1 truncate text-sm">Working tree</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {currentBranch ? <CompactBadge>{currentBranch.name}</CompactBadge> : null}
            {changedFiles.length > 0 ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {changedFiles.length === 1 ? "1 file" : `${changedFiles.length} files`}
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-muted-foreground">clean</span>
            )}
            <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
          </div>
        </div>
        {expanded ? (
          <div className="ml-2 border-l border-border/60 pl-1">{changesSection}</div>
        ) : null}
      </div>
    );
  };

  const workSection = (
    <div className="space-y-0.5">
      {workItems.map((item) => {
        switch (item.kind) {
          case "working-tree":
            return <div key={item.key}>{renderWorkingTreeRow()}</div>;
          case "branch":
            return branchRow(item.branch);
          case "fork-branch": {
            const fetchKey = `fork-fetch:${item.fork.localBranchName}:${item.fork.remoteRefName}`;
            const detailsKey = treeKey(
              "fork-details",
              `${item.fork.localBranchName}:${item.fork.remoteRefName}`,
            );
            return branchRow(item.branch, {
              key: treeKey(
                "fork-branch",
                `${item.fork.localBranchName}:${item.fork.remoteRefName}`,
              ),
              detailsKey,
              compareBaseRef: item.fork.remoteRefName,
              syncCounts: {
                aheadCount: item.fork.aheadCount,
                behindCount: item.fork.behindCount,
              },
              attention: "behind",
              syncLabel: "Fetch",
              syncState: "fetch",
              syncActionKey: fetchKey,
              fetchActionKey: fetchKey,
              secondaryBadge: <CompactBadge>vs {item.fork.remoteRefName}</CompactBadge>,
              onSync: () =>
                void runAction(
                  fetchKey,
                  () =>
                    api?.vcs.fetchBranch({
                      cwd,
                      branchName: item.fork.remoteRefName,
                    }) ?? Promise.resolve(),
                ),
            });
          }
          case "stash":
            return stashRow(item.stash);
        }
      })}
    </div>
  );

  const remotesSection = (
    <div className="space-y-0.5">
      {localBranchesWithoutUpstream.length > 0
        ? localBranchesRow(localBranchesWithoutUpstream)
        : null}
      {snapshot.remotes.length === 0 && localBranchesWithoutUpstream.length === 0 ? (
        <div className="text-sm text-muted-foreground">No remotes configured.</div>
      ) : (
        snapshot.remotes.map(remoteRow)
      )}
    </div>
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {repositorySummary}
        <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {SECTION_ORDER.map((key) => {
            switch (key) {
              case "work":
                return section(
                  key,
                  workSection,
                  <IconButton
                    label="Fetch"
                    disabled={isActionRunning("work-fetch")}
                    loading={isActionRunning("work-fetch")}
                    onClick={() => void fetchActionableBranches()}
                  >
                    <RefreshCw className="size-3.5" />
                  </IconButton>,
                );
              case "remotes":
                return section(
                  key,
                  remotesSection,
                  <div className="flex items-center gap-0.5">
                    <IconButton
                      label="Fetch all remotes"
                      disabled={isActionRunning("remotes-fetch-all")}
                      loading={isActionRunning("remotes-fetch-all")}
                      onClick={() =>
                        void runAction(
                          "remotes-fetch-all",
                          () => api?.vcs.fetchAllRemotes({ cwd }) ?? Promise.resolve(),
                        )
                      }
                    >
                      <RefreshCw className="size-3.5" />
                    </IconButton>
                    <IconButton label="Add remote" onClick={() => setAddRemoteOpen(true)}>
                      <Plus className="size-3.5" />
                    </IconButton>
                  </div>,
                );
            }
          })}
        </div>
      </div>
      <Dialog open={addRemoteOpen} onOpenChange={setAddRemoteOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add remote</DialogTitle>
            <DialogDescription>Register a Git remote for this repository.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              size="sm"
              value={remoteName}
              placeholder="origin"
              aria-label="Remote name"
              onChange={(event) => setRemoteName(event.currentTarget.value)}
            />
            <Input
              size="sm"
              value={remoteUrl}
              placeholder="git@github.com:owner/repo.git"
              aria-label="Remote URL"
              onChange={(event) => setRemoteUrl(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAddRemoteOpen(false);
                setRemoteName("");
                setRemoteUrl("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                isActionRunning("remote-add") ||
                remoteName.trim().length === 0 ||
                remoteUrl.trim().length === 0
              }
              onClick={() =>
                void runAction("remote-add", async () => {
                  if (!api) return;
                  await api.vcs.addRemote({ cwd, name: remoteName.trim(), url: remoteUrl.trim() });
                  setRemoteName("");
                  setRemoteUrl("");
                  setAddRemoteOpen(false);
                })
              }
            >
              {isActionRunning("remote-add") ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Add
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={publishRemoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublishRemoteTarget(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Publish branch</DialogTitle>
            <DialogDescription>
              Choose the remote to set as upstream for{" "}
              {publishRemoteTarget?.branch.name ?? "this branch"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-1">
            {snapshot.remotes.map((remote) => (
              <button
                key={remote.name}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  const target = publishRemoteTarget;
                  setPublishRemoteTarget(null);
                  if (!target) return;
                  void publishBranch(target.branch, remote.name, target.force);
                }}
              >
                <Upload className="size-3.5 shrink-0 text-success-foreground" />
                <span className="min-w-0 flex-1 truncate">{remote.name}</span>
                <span className="min-w-0 flex-[2] truncate text-xs text-muted-foreground">
                  {remote.fetchUrl ?? "No fetch URL"}
                </span>
              </button>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPublishRemoteTarget(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={compareBaseDialogTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          setCompareBaseDialogTarget(null);
          setCompareBaseQuery("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Choose compare base</DialogTitle>
            <DialogDescription>
              Select the ref to compare with {compareBaseDialogTarget?.branch.name ?? "this branch"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Combobox
              items={compareBaseRefs}
              filteredItems={filteredCompareBaseRefs}
              autoHighlight
              value={
                compareBaseDialogTarget
                  ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
                    compareBaseOverrides.get(compareBaseDialogTarget.detailsKey) ??
                    "")
                  : ""
              }
              onOpenChange={(open) => {
                if (!open) setCompareBaseQuery("");
              }}
            >
              <ComboboxTrigger render={<Button variant="outline" size="sm" />}>
                <GitBranch className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {compareBaseDialogTarget
                    ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
                      compareBaseOverrides.get(compareBaseDialogTarget.detailsKey) ??
                      "Choose ref")
                    : "Choose ref"}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup className="flex w-80 flex-col">
                <div className="shrink-0 px-3 pt-2.5">
                  <ComboboxInput
                    size="sm"
                    placeholder="Search refs..."
                    showTrigger={false}
                    value={compareBaseQuery}
                    onChange={(event) => setCompareBaseQuery(event.currentTarget.value)}
                  />
                </div>
                <ComboboxEmpty>No refs found.</ComboboxEmpty>
                <ComboboxList className="max-h-56">
                  {filteredCompareBaseRefs.map((refName) => (
                    <ComboboxItem
                      hideIndicator
                      key={refName}
                      value={refName}
                      onClick={() => chooseCompareBase(refName)}
                    >
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{refName}</span>
                      </div>
                    </ComboboxItem>
                  ))}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCompareBaseDialogTarget(null);
                setCompareBaseQuery("");
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={divergedSyncBranch !== null}
        onOpenChange={(open) => {
          if (!open) setDivergedSyncBranch(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Sync diverged branch</DialogTitle>
            <DialogDescription>
              Choose how to reconcile local and upstream commits for{" "}
              {divergedSyncBranch?.name ?? "this branch"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDivergedSyncBranch(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`)}
              onClick={() => runDivergedSync("force-pull")}
            >
              {isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Force pull
            </Button>
            <Button
              size="sm"
              disabled={
                isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ||
                divergedSyncBranch?.current !== true
              }
              onClick={() => runDivergedSync("merge")}
            >
              {isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Merge sync
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`)}
              onClick={() => runDivergedSync("force-push")}
            >
              {isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Force push
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Commit selected changes</DialogTitle>
            <DialogDescription>
              Provide a message, or leave it blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="source-control-commit-message">
              Commit message (optional)
            </label>
            <Textarea
              id="source-control-commit-message"
              size="sm"
              value={dialogCommitMessage}
              placeholder="Leave empty to auto-generate"
              aria-label="Commit message (optional)"
              disabled={isActionRunning("changes-commit") || gitAction.isPending}
              onChange={(event) => setDialogCommitMessage(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCommitDialogOpen(false);
                setDialogCommitMessage("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                selectedChangedFiles.length === 0 ||
                isActionRunning("changes-commit") ||
                gitAction.isPending
              }
              onClick={() => void runPanelCommit(dialogCommitMessage)}
            >
              {isActionRunning("changes-commit") || gitAction.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={stashDialogTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          setStashDialogTarget(null);
          setDialogStashMessage("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Stash {stashDialogTarget?.label ?? ""} changes</DialogTitle>
            <DialogDescription>
              Provide a message, or leave it blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="source-control-stash-message">
              Stash message (optional)
            </label>
            <Textarea
              id="source-control-stash-message"
              size="sm"
              value={dialogStashMessage}
              placeholder="Leave empty to auto-generate"
              aria-label="Stash message (optional)"
              disabled={isActionRunning("changes-stash")}
              onChange={(event) => setDialogStashMessage(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStashDialogTarget(null);
                setDialogStashMessage("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isActionRunning("changes-stash") || !stashDialogTarget}
              onClick={runPanelStash}
            >
              {isActionRunning("changes-stash") ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Stash
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
