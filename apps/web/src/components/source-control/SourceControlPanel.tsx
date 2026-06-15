import type {
  EnvironmentId,
  ThreadId,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelStashDetails,
  VcsRef,
} from "@t3tools/contracts";
import {
  Archive,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitCommit,
  GitCompare,
  GitMerge,
  GitPullRequestArrow,
  Plus,
  RefreshCw,
  RotateCcw,
  Tag,
  Target,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { openInPreferredEditor } from "~/editorPreferences";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";
import { invalidateSourceControlState, useGitStackedAction } from "~/lib/sourceControlActions";
import { cn, newCommandId } from "~/lib/utils";
import { useVcsStatus } from "~/lib/vcsStatusState";
import { resolvePathLinkTarget } from "~/terminal-links";

import { shouldIncludeBranchPickerItem } from "../BranchToolbar.logic";
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

interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
}

type SectionKey = "work" | "remotes";

const SECTION_ORDER: readonly SectionKey[] = ["work", "remotes"];

const SECTION_TITLES: Record<SectionKey, string> = {
  work: "Work in Progress",
  remotes: "Remotes",
};

const DEFAULT_SECTION_WEIGHTS: Record<SectionKey, number> = {
  work: 3,
  remotes: 1.4,
};

const COLLAPSED_SECTION_HEIGHT = 32;
const MIN_SECTION_WEIGHT = 0.35;
const ACTION_LOCK_TIMEOUT_MS = 15_000;
const COMMIT_PAGE_SIZE = 10;
const commitDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Source control action failed.";
}

function formatBranchSync(snapshot: VcsPanelSnapshotResult): string {
  const status = snapshot.status;
  if (!status.hasUpstream) return "No upstream";
  return formatSyncCounts(status.aheadCount, status.behindCount) ?? "Synced";
}

function formatSyncCounts(aheadCount: number, behindCount: number): string | null {
  const parts = [];
  if (aheadCount > 0) parts.push(`↑${aheadCount}`);
  if (behindCount > 0) parts.push(`↓${behindCount}`);
  if (parts.length === 0) return null;
  return parts.join(" ");
}

interface PanelChangedFile extends VcsPanelFileChange {
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly hasConflicts: boolean;
}

function mergedFileStatus(
  statuses: ReadonlySet<VcsPanelFileChange["status"]>,
): VcsPanelFileChange["status"] {
  if (statuses.has("conflicted")) return "conflicted";
  if (statuses.has("deleted")) return "deleted";
  if (statuses.has("renamed")) return "renamed";
  if (statuses.has("copied")) return "copied";
  if (statuses.has("added")) return "added";
  if (statuses.has("untracked")) return "untracked";
  return "modified";
}

function mergeChangeGroups(groups: readonly VcsPanelChangeGroup[]): PanelChangedFile[] {
  const files = new Map<
    string,
    {
      originalPath: string | null;
      statuses: Set<VcsPanelFileChange["status"]>;
      insertions: number;
      deletions: number;
      hasStagedChanges: boolean;
      hasUnstagedChanges: boolean;
      hasConflicts: boolean;
    }
  >();

  for (const group of groups) {
    for (const file of group.files) {
      const existing = files.get(file.path) ?? {
        originalPath: file.originalPath,
        statuses: new Set<VcsPanelFileChange["status"]>(),
        insertions: 0,
        deletions: 0,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasConflicts: false,
      };
      existing.originalPath ??= file.originalPath;
      existing.statuses.add(file.status);
      existing.insertions += file.insertions;
      existing.deletions += file.deletions;
      existing.hasStagedChanges ||= group.kind === "staged";
      existing.hasUnstagedChanges ||= group.kind === "unstaged";
      existing.hasConflicts ||= group.kind === "conflicts";
      files.set(file.path, existing);
    }
  }

  return [...files.entries()]
    .map(([path, file]) => ({
      path,
      originalPath: file.originalPath,
      status: mergedFileStatus(file.statuses),
      insertions: file.insertions,
      deletions: file.deletions,
      hasStagedChanges: file.hasStagedChanges,
      hasUnstagedChanges: file.hasUnstagedChanges,
      hasConflicts: file.hasConflicts,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

function isActionForced(event: ReactMouseEvent): boolean {
  return event.shiftKey;
}

function shouldFetchBeforePull(event: ReactMouseEvent): boolean {
  return event.altKey;
}

function branchSyncCounts(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
): { readonly aheadCount: number; readonly behindCount: number } {
  if (branch.current) {
    return {
      aheadCount: snapshot.status.aheadCount,
      behindCount: snapshot.status.behindCount,
    };
  }
  return {
    aheadCount: branch.aheadCount ?? 0,
    behindCount: branch.behindCount ?? 0,
  };
}

function branchHasUpstream(branch: VcsRef, snapshot: VcsPanelSnapshotResult): boolean {
  return branch.current ? snapshot.status.hasUpstream : Boolean(branch.upstreamName);
}

function treeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function formatRelativeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const elapsedMs = Date.now() - time;
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "last week";
  if (days < 30) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
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

function expandedBranchesForSnapshot(
  snapshot: VcsPanelSnapshotResult,
  expanded: ReadonlySet<string>,
): VcsRef[] {
  const localBranches = snapshot.localBranches.filter((branch) =>
    expanded.has(treeKey("branch", branch.name)),
  );
  const expandedLocalBranches = localOnlyBranches(snapshot).filter((branch) =>
    expanded.has(treeKey("remote-branch", `local:${branch.name}`)),
  );
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
      .map((branch) => branch.ref),
  );
  return [...localBranches, ...expandedLocalBranches, ...remoteBranches];
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

type BranchSyncState = "fetch" | "pull" | "push" | "publish" | "diverged";

function branchSyncState(branch: VcsRef, snapshot: VcsPanelSnapshotResult): BranchSyncState {
  const hasUpstream = branchHasUpstream(branch, snapshot);
  const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
  if (!hasUpstream) return "publish";
  if (aheadCount > 0 && behindCount > 0) return "diverged";
  if (behindCount > 0) return "pull";
  if (aheadCount > 0) return "push";
  return "fetch";
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

type AttentionKind = "conflicts" | "diverged" | "behind" | "unpushed" | "dirty" | "stale";

const ATTENTION_RANK: Record<AttentionKind, number> = {
  conflicts: 0,
  diverged: 1,
  behind: 2,
  unpushed: 3,
  dirty: 4,
  stale: 5,
};

function branchAttention(branch: VcsRef, snapshot: VcsPanelSnapshotResult): AttentionKind {
  const hasUpstream = branchHasUpstream(branch, snapshot);
  const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
  if (aheadCount > 0 && behindCount > 0) return "diverged";
  if (behindCount > 0) return "behind";
  if (aheadCount > 0 || !hasUpstream) return "unpushed";
  return "stale";
}

function branchActivityTimestamp(branch: VcsRef): number {
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
  if (!commit.authorAvatarUrl) return null;
  return (
    <img
      alt={commit.authorName ? `${commit.authorName} avatar` : "Author avatar"}
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
      referrerPolicy="no-referrer"
      src={commit.authorAvatarUrl}
      onError={(event) => {
        event.currentTarget.hidden = true;
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
  onClick,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
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
            disabled={disabled}
            className={cn(
              "size-6",
              destructive && "text-destructive-foreground hover:text-destructive-foreground",
            )}
            onClick={onClick}
          >
            {children}
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
  return (
    <Badge variant={status.behindCount > 0 ? "warning" : "info"} size="sm">
      {formatBranchSync(snapshot)}
    </Badge>
  );
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
}: {
  readonly files: readonly VcsPanelFileChange[];
  readonly emptyLabel: string;
}) {
  if (files.length === 0) {
    return <div className="px-3 py-1 text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-0.5">
      {files.map((file) => (
        <div
          key={`${file.path}:${file.status}`}
          className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
        >
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
        </div>
      ))}
    </div>
  );
}

export function SourceControlPanel({
  cwd,
  environmentId,
  threadId,
  worktreePath,
}: SourceControlPanelProps) {
  const api = useMemo(() => readEnvironmentApi(environmentId), [environmentId]);
  const gitActionScope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const gitAction = useGitStackedAction(gitActionScope);
  const vcsStatus = useVcsStatus(gitActionScope);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const expandedTreeRef = useRef<ReadonlySet<string>>(new Set());
  const lastFocusRefreshAtRef = useRef(0);
  const lastVcsStatusFingerprintRef = useRef<string | null>(null);
  const previousChangedPathsRef = useRef<ReadonlySet<string>>(new Set());
  const [snapshot, setSnapshot] = useState<VcsPanelSnapshotResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningActions, setRunningActions] = useState<ReadonlySet<string>>(() => new Set());
  const [panelBusyLabel, setPanelBusyLabel] = useState<string | null>(null);
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
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [divergedSyncBranch, setDivergedSyncBranch] = useState<VcsRef | null>(null);
  const [publishRemoteTarget, setPublishRemoteTarget] = useState<{
    readonly branch: VcsRef;
    readonly force: boolean;
  } | null>(null);
  const [compareBaseDialogBranch, setCompareBaseDialogBranch] = useState<VcsRef | null>(null);
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
  const changedFiles = useMemo(
    () => mergeChangeGroups(snapshot?.changeGroups ?? []),
    [snapshot?.changeGroups],
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
    () => selectedChangedFiles.map((file) => file.path),
    [selectedChangedFiles],
  );
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
  const isActionRunning = useCallback(
    (actionKey: string) => runningActions.has(actionKey),
    [runningActions],
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
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const nextSnapshot = await api.vcs.panelSnapshot({ cwd });
      syncChangedPathSelection(nextSnapshot.changeGroups);
      setSnapshot(nextSnapshot);
      const expandedBranches = expandedBranchesForSnapshot(nextSnapshot, expandedTreeRef.current);
      const nextDetails = new Map(mapBranchDetails(nextSnapshot.branchDetails));
      setLoadingBranchDetails(new Set());
      if (expandedBranches.length > 0) {
        setLoadingBranchDetails(new Set(expandedBranches.map((branch) => branch.name)));
        const details = await Promise.all(
          expandedBranches.map((branch) =>
            api.vcs.branchDetails({
              cwd,
              branch,
              defaultCompareRef: nextSnapshot.defaultCompareRef,
              compareBaseRef: compareBaseOverrides.get(branch.name),
            }),
          ),
        );
        for (const detail of details) {
          nextDetails.set(detail.fullRefName, detail);
          nextDetails.set(detail.name, detail);
        }
      }
      setBranchDetailsByRef(nextDetails);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoadingBranchDetails(new Set());
      setLoading(false);
    }
  }, [api, compareBaseOverrides, cwd, syncChangedPathSelection]);

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
      let timeoutId: number | null = window.setTimeout(() => {
        timeoutId = null;
        setRunningActions((current) => {
          const next = new Set(current);
          next.delete(actionKey);
          return next;
        });
        void refresh();
      }, ACTION_LOCK_TIMEOUT_MS);
      try {
        await action();
        void invalidateSourceControlState({ environmentId, cwd });
        await refresh();
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        setRunningActions((current) => {
          const next = new Set(current);
          next.delete(actionKey);
          return next;
        });
      }
    },
    [cwd, environmentId, refresh],
  );

  const openFile = useCallback(
    async (path: string) => {
      const localApi = readLocalApi();
      if (!localApi) {
        setError("No local editor bridge is available.");
        return;
      }
      try {
        await openInPreferredEditor(localApi, resolvePathLinkTarget(path, cwd));
      } catch (nextError) {
        setError(errorMessage(nextError));
      }
    },
    [cwd],
  );

  const confirm = useCallback(async (message: string) => {
    return (await readLocalApi()?.dialogs.confirm(message)) ?? window.confirm(message);
  }, []);

  const switchRef = useCallback(
    (refName: string) =>
      runAction(`branch-switch:${refName}`, async () => {
        if (!api) return;
        const result = await api.vcs.switchRef({ cwd, refName });
        await readEnvironmentApi(environmentId)?.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          branch: result.refName,
          worktreePath,
        });
      }),
    [api, cwd, environmentId, runAction, threadId, worktreePath],
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

  const undoLatestCommit = useCallback(
    (branchName: string) =>
      void (async () => {
        if (!(await confirm(`Undo latest commit on ${branchName}?`))) return;
        await runAction(
          `branch-undo-latest:${branchName}`,
          () => api?.vcs.undoLatestCommit({ cwd }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
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
          await readEnvironmentApi(environmentId)?.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId,
            branch: result.refName,
            worktreePath,
          });
        });
      })(),
    [api, confirm, cwd, environmentId, runAction, threadId, worktreePath],
  );

  const createBranchFromCommit = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        const branchName = window.prompt(`Create branch from ${commit.shortSha}`, "");
        const trimmed = branchName?.trim();
        if (!trimmed) return;
        await runAction(`commit-create-branch:${commit.sha}:${trimmed}`, async () => {
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

  const syncBranch = useCallback(
    (branch: VcsRef, event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!snapshot) return;
      const force = isActionForced(event);
      const fetchFirst = shouldFetchBeforePull(event);
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
        await api.vcs.pullBranch({ cwd, branchName: branch.name, merge: true });
        await api.vcs.pushBranch({ cwd, branchName: branch.name });
      });
    },
    [api, cwd, divergedSyncBranch, runAction],
  );

  const runPanelCommit = useCallback(
    (message: string) => {
      const commitMessage = message.trim();
      setPanelBusyLabel(
        commitMessage ? "Committing staged changes..." : "Generating commit message...",
      );
      return runAction("changes-commit", async () => {
        setCommitDialogOpen(false);
        setDialogCommitMessage("");
        await gitAction.run({
          actionId: newCommandId(),
          action: "commit",
          ...(commitMessage ? { commitMessage } : {}),
          filePaths: [...selectedChangePathList],
        });
      }).finally(() => setPanelBusyLabel(null));
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
      setPanelBusyLabel(stashMessage ? "Stashing changes..." : "Generating stash message...");
      return runAction("changes-stash", async () => {
        if (!api) return;
        await api.vcs.createStash({
          cwd,
          mode: "all",
          includeUntracked: true,
          paths: [...paths],
          ...(stashMessage ? { message: stashMessage } : {}),
        });
      }).finally(() => setPanelBusyLabel(null));
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
    async (branch: VcsRef, compareBaseRef?: string) => {
      if (!api || !snapshot) return;
      if (!compareBaseRef && branchDetailsByRef.has(branch.name)) return;
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(branch.name);
        return next;
      });
      try {
        const details = await api.vcs.branchDetails({
          cwd,
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          compareBaseRef: compareBaseRef ?? compareBaseOverrides.get(branch.name),
        });
        setBranchDetailsByRef((current) => {
          const next = new Map(current);
          next.set(details.fullRefName, details);
          next.set(details.name, details);
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
    [api, branchDetailsByRef, compareBaseOverrides, cwd, snapshot],
  );

  const chooseCompareBase = useCallback(
    (baseRef: string) => {
      const branch = compareBaseDialogBranch;
      setCompareBaseDialogBranch(null);
      setCompareBaseQuery("");
      if (!branch) return;
      setCompareBaseOverrides((current) => {
        const next = new Map(current);
        next.set(branch.name, baseRef);
        return next;
      });
      void loadBranchDetails(branch, baseRef);
    },
    [compareBaseDialogBranch, loadBranchDetails],
  );

  const toggleBranchTree = useCallback(
    (key: string, branch: VcsRef) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadBranchDetails(branch);
    },
    [expandedTree, loadBranchDetails, toggleTree],
  );

  const toggleBranchTreeFromKeyboard = useCallback(
    (key: string, branch: VcsRef, event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleBranchTree(key, branch);
    },
    [toggleBranchTree],
  );

  const loadMoreBranchCommits = useCallback(
    async (branch: VcsRef, details: VcsPanelBranchDetails) => {
      if (!api || details.commitsRemaining <= 0) return;
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(branch.name);
        return next;
      });
      try {
        const result = await api.vcs.branchCommits({
          cwd,
          branch,
          skip: details.commits.length,
          limit: COMMIT_PAGE_SIZE,
        });
        setBranchDetailsByRef((current) => {
          const nextDetails = current.get(details.fullRefName) ?? details;
          const merged = {
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

  if (loading && !snapshot) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading repository state...
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="text-sm text-destructive-foreground">
          {error ?? "Source control is unavailable."}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
    );
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
    return (
      <div
        key={file.path}
        className="group relative flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
      >
        <Checkbox
          checked={selected}
          disabled={isActionRunning(discardKey)}
          aria-label={selected ? `Deselect ${file.path}` : `Select ${file.path}`}
          onCheckedChange={(checked) => toggleChangedFileSelection(file.path, checked === true)}
        />
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
            onClick={() =>
              void (async () => {
                if (!(await confirm(`Discard changes in ${file.path}?`))) return;
                await runAction(
                  discardKey,
                  () =>
                    api?.vcs.discardFiles({
                      cwd,
                      paths: [file.path],
                      staged: file.hasStagedChanges,
                    }) ?? Promise.resolve(),
                );
              })()
            }
          >
            <Trash2 className="size-3.5" />
          </IconButton>
          <IconButton label="Open file" onClick={() => void openFile(file.path)}>
            <ExternalLink className="size-3.5" />
          </IconButton>
        </RowActions>
      </div>
    );
  };

  const renderCommit = (commit: VcsPanelCommitSummary) => {
    const key = treeKey("commit", commit.sha);
    const expanded = expandedTree.has(key);
    const stats = sumFiles(commit.files);
    const relativeDate = formatRelativeDate(commit.authoredAt);
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
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
                <AuthorAvatar commit={commit} />
                <span className="min-w-0 flex-1 truncate">{commit.message}</span>
                <RefLabels commit={commit} />
                <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
                {relativeDate ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
                ) : null}
                <RowActions>
                  <IconButton label="Revert commit" onClick={() => revertCommit(commit)}>
                    <RotateCcw className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Rebase current branch onto commit"
                    onClick={() => rebaseCurrentOnto(commit.sha)}
                  >
                    <GitMerge className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Checkout as detached HEAD"
                    onClick={() => checkoutCommitDetached(commit)}
                  >
                    <GitCommit className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Create branch from commit"
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
            <FileChangeList files={commit.files} emptyLabel="No file changes." />
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
    readonly count: number | null;
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

  const renderBranchTree = (branch: VcsRef, details: VcsPanelBranchDetails) => {
    const hasBranchUpstream = branchHasUpstream(branch, snapshot);
    return (
      <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
        {renderBranchSubsection({
          details,
          id: "compare",
          title: (
            <>
              Compare with
              <span className="ml-1 text-muted-foreground">{details.baseRef ?? "choose base"}</span>
            </>
          ),
          count: null,
          icon: <GitCompare className="size-3.5 shrink-0 text-muted-foreground" />,
          action: (
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setCompareBaseDialogBranch(branch);
                setCompareBaseQuery("");
              }}
            >
              choose
            </button>
          ),
          children: details.baseRef ? (
            <div className="space-y-0.5">
              {details.aheadCommits.length > 0
                ? renderBranchSubsection({
                    details,
                    id: "compare-ahead",
                    title: `${details.aheadCommits.length} Ahead`,
                    count: null,
                    icon: <Upload className="size-3.5 shrink-0 text-success-foreground" />,
                    children: details.aheadCommits.map(renderCommit),
                  })
                : null}
              {details.behindCommits.length > 0
                ? renderBranchSubsection({
                    details,
                    id: "compare-behind",
                    title: `${details.behindCommits.length} Behind`,
                    count: null,
                    icon: <Download className="size-3.5 shrink-0 text-warning-foreground" />,
                    children: details.behindCommits.map(renderCommit),
                  })
                : null}
              {renderBranchSubsection({
                details,
                id: "compare-history",
                title: "History",
                count: null,
                defaultExpanded: true,
                children:
                  details.compareCommits.length === 0 ? (
                    <div className="px-3 py-1 text-xs text-muted-foreground">No commits.</div>
                  ) : (
                    details.compareCommits.map(renderCommit)
                  ),
              })}
              {renderBranchSubsection({
                details,
                id: "compare-changes",
                title: "Changes",
                count: null,
                action: <FileChangeSummary files={details.compareFiles} />,
                children: <FileChangeList files={details.compareFiles} emptyLabel="No changes." />,
              })}
            </div>
          ) : (
            <div className="px-3 py-1 text-xs text-muted-foreground">Choose a base ref.</div>
          ),
        })}
        {hasBranchUpstream && details.aheadCommits.length > 0
          ? renderBranchSubsection({
              details,
              id: "ahead",
              title: `${details.aheadCommits.length} Ahead`,
              count: null,
              icon: <Upload className="size-3.5 shrink-0 text-success-foreground" />,
              children: details.aheadCommits.map(renderCommit),
            })
          : null}
        {hasBranchUpstream && details.behindCommits.length > 0
          ? renderBranchSubsection({
              details,
              id: "behind",
              title: `${details.behindCommits.length} Behind`,
              count: null,
              icon: <Download className="size-3.5 shrink-0 text-warning-foreground" />,
              children: details.behindCommits.map(renderCommit),
            })
          : null}
        {renderBranchSubsection({
          details,
          id: "commits",
          title: "History",
          count: null,
          defaultExpanded: true,
          children: (
            <div className="space-y-0.5">
              {details.commits.length === 0 ? (
                <div className="px-3 py-1 text-xs text-muted-foreground">No commits.</div>
              ) : (
                details.commits.map(renderCommit)
              )}
              {details.commitsRemaining > 0 ? (
                <button
                  type="button"
                  className="flex h-7 w-full items-center rounded px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  disabled={loadingBranchDetails.has(branch.name)}
                  onClick={() => void loadMoreBranchCommits(branch, details)}
                >
                  Load {Math.min(COMMIT_PAGE_SIZE, details.commitsRemaining)} more of{" "}
                  {details.commitsRemaining} previous commits
                </button>
              ) : null}
            </div>
          ),
        })}
      </div>
    );
  };

  const branchRow = (branch: VcsRef) => {
    const details = branchDetailsByRef.get(branch.name);
    const key = treeKey("branch", branch.name);
    const expanded = expandedTree.has(key);
    const loadingDetails = loadingBranchDetails.has(branch.name);
    const current = branch.current;
    const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
    const hasUpstream = branchHasUpstream(branch, snapshot);
    const attention = branchAttention(branch, snapshot);
    const syncState = branchSyncState(branch, snapshot);
    const switchKey = `branch-switch:${branch.name}`;
    const syncKey = `branch-sync:${branch.name}`;
    const deleteKey = `branch-delete:${branch.name}`;
    const undoKey = `branch-undo-latest:${branch.name}`;
    const mergeKey = `branch-merge:${branch.name}`;
    const rebaseKey = `rebase-current:${branch.name}`;
    const syncLabel = branchSyncActionLabel(syncState);
    const relativeDate = formatRelativeDate(branch.lastActivityAt);
    return (
      <div key={branch.name} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleBranchTree(key, branch)}
          onKeyDown={(event) => toggleBranchTreeFromKeyboard(key, branch, event)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <AttentionIcon kind={attention} />
          <span className="min-w-0 flex-1 truncate text-sm">{branch.name}</span>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
            {hasUpstream && aheadCount === 0 && behindCount === 0 ? (
              <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                <SyncedIcon />
              </span>
            ) : null}
            {!hasUpstream ? <CompactBadge>local</CompactBadge> : null}
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
              label="Switch branch"
              disabled={current || isActionRunning(switchKey)}
              onClick={() => void switchRef(branch.name)}
            >
              <GitBranch className="size-3.5" />
            </IconButton>
            <IconButton
              label={syncLabel}
              disabled={isActionRunning(syncKey) || isActionRunning(`branch-fetch:${branch.name}`)}
              onClick={(event) => syncBranch(branch, event)}
            >
              <BranchSyncActionIcon state={syncState} />
            </IconButton>
            <IconButton
              label="Delete branch. Shift: force."
              destructive
              disabled={current || isActionRunning(deleteKey)}
              onClick={(event) => deleteBranch(branch, isActionForced(event))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            {current && aheadCount > 0 ? (
              <IconButton
                label="Undo latest commit"
                disabled={isActionRunning(undoKey)}
                onClick={() => undoLatestCommit(branch.name)}
              >
                <Undo2 className="size-3.5" />
              </IconButton>
            ) : null}
            {!current ? (
              <>
                <IconButton
                  label="Merge branch into current"
                  disabled={isActionRunning(mergeKey)}
                  onClick={() => mergeBranchIntoCurrent(branch.name)}
                >
                  <GitMerge className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Rebase current branch onto branch"
                  disabled={isActionRunning(rebaseKey)}
                  onClick={() => rebaseCurrentOnto(branch.name)}
                >
                  <GitPullRequestArrow className="size-3.5" />
                </IconButton>
              </>
            ) : null}
          </RowActions>
        </div>
        {expanded && details ? renderBranchTree(branch, details) : null}
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
    return (
      <div key={`${branch.remoteName ?? "local"}:${displayName}`} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleBranchTree(key, branch)}
          onKeyDown={(event) => toggleBranchTreeFromKeyboard(key, branch, event)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
            {hasLocalBranch && hasUpstream && aheadCount === 0 && behindCount === 0 ? (
              <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                <SyncedIcon />
              </span>
            ) : null}
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
              label="Switch branch"
              disabled={current || isActionRunning(switchKey)}
              onClick={() => void switchRef(branch.name)}
            >
              <GitBranch className="size-3.5" />
            </IconButton>
            {hasLocalBranch ? (
              <IconButton
                label={branchSyncActionLabel(syncState)}
                disabled={isActionRunning(syncKey) || isActionRunning(fetchKey)}
                onClick={(event) => syncBranch(branch, event)}
              >
                <BranchSyncActionIcon state={syncState} />
              </IconButton>
            ) : (
              <IconButton
                label="Fetch branch"
                disabled={isActionRunning(fetchKey)}
                onClick={() =>
                  void runAction(
                    fetchKey,
                    () =>
                      api?.vcs.fetchBranch({ cwd, branchName: branch.name }) ?? Promise.resolve(),
                  )
                }
              >
                <RefreshCw className="size-3.5" />
              </IconButton>
            )}
            <IconButton
              label={hasLocalBranch ? "Delete branch. Shift: force." : "Delete remote branch"}
              destructive
              disabled={isActionRunning(deleteKey)}
              onClick={(event) => deleteBranch(branch, hasLocalBranch && isActionForced(event))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            {current && aheadCount > 0 ? (
              <IconButton
                label="Undo latest commit"
                disabled={isActionRunning(undoKey)}
                onClick={() => undoLatestCommit(branch.name)}
              >
                <Undo2 className="size-3.5" />
              </IconButton>
            ) : null}
            {!current ? (
              <>
                <IconButton
                  label="Merge branch into current"
                  disabled={isActionRunning(mergeKey)}
                  onClick={() => mergeBranchIntoCurrent(branch.name)}
                >
                  <GitMerge className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Rebase current branch onto branch"
                  disabled={isActionRunning(rebaseKey)}
                  onClick={() => rebaseCurrentOnto(branch.name)}
                >
                  <GitPullRequestArrow className="size-3.5" />
                </IconButton>
              </>
            ) : null}
          </RowActions>
        </div>
        {expanded && details ? renderBranchTree(branch, details) : null}
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
    return (
      <div key={remote.name} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
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
              onClick={() =>
                void runAction(
                  fetchKey,
                  () => api?.vcs.fetchRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
                )
              }
            >
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton
              label="Remove remote"
              destructive
              disabled={isActionRunning(removeKey)}
              onClick={() =>
                void (async () => {
                  if (!(await confirm(`Remove remote ${remote.name}?`))) return;
                  await runAction(
                    removeKey,
                    () =>
                      api?.vcs.removeRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
                  );
                })()
              }
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
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">local</span>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {branches.length === 1
              ? "1 unpublished branch"
              : `${branches.length} unpublished branches`}
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
              onClick={() =>
                void runAction(
                  applyKey,
                  () => api?.vcs.applyStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
                )
              }
            >
              <Download className="size-3.5" />
            </IconButton>
            <IconButton
              label="Pop stash"
              disabled={isActionRunning(popKey)}
              onClick={() =>
                void runAction(
                  popKey,
                  () => api?.vcs.popStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
                )
              }
            >
              <Archive className="size-3.5" />
            </IconButton>
            <IconButton
              label="Drop stash"
              destructive
              disabled={isActionRunning(dropKey)}
              onClick={() =>
                void (async () => {
                  if (!(await confirm(`Drop ${stash.refName}?`))) return;
                  await runAction(
                    dropKey,
                    () => api?.vcs.dropStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
                  );
                })()
              }
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {expanded && details ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            <FileChangeList files={details.files} emptyLabel="No changes." />
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

  const repositorySummary = (
    <div className="shrink-0 border-b border-border/70 px-2 py-1.5 text-xs">
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
      {error ? <div className="mt-1 text-destructive-foreground">{error}</div> : null}
      {panelBusyLabel ? (
        <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" />
          <span>{panelBusyLabel}</span>
        </div>
      ) : null}
    </div>
  );

  const changesSection = (
    <div className="space-y-2">
      {changedFiles.length === 0 ? (
        <div className="px-1 py-1 text-sm text-muted-foreground">Working tree clean</div>
      ) : (
        <div className="space-y-0.5">
          <div className="flex h-6 items-center justify-between gap-2 rounded px-1 text-xs font-medium uppercase text-muted-foreground">
            <span className="min-w-0 truncate">
              {selectedChangedFiles.length} of {changedFiles.length} selected
            </span>
            <div className="flex items-center gap-1">
              <IconButton
                label="Select all changes"
                disabled={selectedChangedFiles.length === changedFiles.length}
                onClick={() => setSelectedChangePaths(new Set(changedPaths))}
              >
                <Check className="size-3.5" />
              </IconButton>
              <IconButton
                label="Clear all changes"
                disabled={selectedChangedFiles.length === 0}
                onClick={() => setSelectedChangePaths(new Set())}
              >
                <X className="size-3.5" />
              </IconButton>
              <IconButton
                label="Commit selected changes. Shift: message."
                disabled={
                  isActionRunning("changes-commit") ||
                  gitAction.isPending ||
                  selectedChangedFiles.length === 0
                }
                onClick={(event) =>
                  event.shiftKey ? openCommitDialog() : void runGeneratedPanelCommit()
                }
              >
                <GitCommit className="size-3.5" />
              </IconButton>
              <IconButton
                label="Stash selected changes. Shift: message."
                disabled={isActionRunning("changes-stash") || selectedChangedFiles.length === 0}
                onClick={(event) =>
                  event.shiftKey
                    ? openStashDialog("selected", selectedChangePathList)
                    : void runGeneratedPanelStash()
                }
              >
                <Archive className="size-3.5" />
              </IconButton>
            </div>
          </div>
          {changedFiles.map((file) => renderWorkingFile(file))}
        </div>
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
        if (branch.current) return false;
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
    const syncState = currentBranch ? branchSyncState(currentBranch, snapshot) : "fetch";
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
          {currentBranch ? (
            <RowActions>
              <IconButton
                label={branchSyncActionLabel(syncState)}
                disabled={
                  isActionRunning(`branch-sync:${currentBranch.name}`) ||
                  isActionRunning(`branch-fetch:${currentBranch.name}`)
                }
                onClick={(event) => syncBranch(currentBranch, event)}
              >
                <BranchSyncActionIcon state={syncState} />
              </IconButton>
              {aheadCount > 0 ? (
                <IconButton
                  label="Undo latest commit"
                  disabled={isActionRunning(`branch-undo-latest:${currentBranch.name}`)}
                  onClick={() => undoLatestCommit(currentBranch.name)}
                >
                  <Undo2 className="size-3.5" />
                </IconButton>
              ) : null}
            </RowActions>
          ) : null}
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
                return section(key, workSection);
              case "remotes":
                return section(
                  key,
                  remotesSection,
                  <div className="flex items-center gap-0.5">
                    <IconButton
                      label="Fetch all remotes"
                      disabled={isActionRunning("remotes-fetch-all")}
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
        open={compareBaseDialogBranch !== null}
        onOpenChange={(open) => {
          if (open) return;
          setCompareBaseDialogBranch(null);
          setCompareBaseQuery("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Choose compare base</DialogTitle>
            <DialogDescription>
              Select the ref to compare with {compareBaseDialogBranch?.name ?? "this branch"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Combobox
              items={compareBaseRefs}
              filteredItems={filteredCompareBaseRefs}
              autoHighlight
              value={
                compareBaseDialogBranch
                  ? (branchDetailsByRef.get(compareBaseDialogBranch.name)?.baseRef ??
                    compareBaseOverrides.get(compareBaseDialogBranch.name) ??
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
                  {compareBaseDialogBranch
                    ? (branchDetailsByRef.get(compareBaseDialogBranch.name)?.baseRef ??
                      compareBaseOverrides.get(compareBaseDialogBranch.name) ??
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
                setCompareBaseDialogBranch(null);
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
              Force pull
            </Button>
            <Button
              size="sm"
              disabled={isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`)}
              onClick={() => runDivergedSync("merge")}
            >
              Merge sync
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`)}
              onClick={() => runDivergedSync("force-push")}
            >
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
              Stash
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
