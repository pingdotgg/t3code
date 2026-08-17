import type {
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelRemote,
  VcsPanelStash,
  VcsRef,
} from "@t3tools/contracts";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  GitBranch,
  GitCommit,
  GitCompare,
  LoaderCircle,
  RefreshCw,
  Tag,
  Target,
  Upload,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { VisualStudioCode } from "../Icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipCardPopup, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type AttentionKind,
  type BranchSyncState,
  formatRelativeDate,
} from "./SourceControlPanel.logic";
import { formatReadableDate, type WorkingTreeChangeSetView } from "./SourceControlPanelModel";

export function StatLabels({
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

export function BranchSyncLabels({
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

export function branchSyncActionLabel(state: BranchSyncState): string {
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

export function BranchSyncActionIcon({ state }: { readonly state: BranchSyncState }) {
  switch (state) {
    case "publish":
    case "push":
      return <Upload className="size-3.5" />;
    case "pull":
      return <Download className="size-3.5" />;
    case "diverged":
      return <GitCompare className="size-3.5" />;
    case "fetch":
      return <RefreshCw className="size-3.5" />;
  }
}

export const ATTENTION_RANK: Record<AttentionKind, number> = {
  conflicts: 0,
  diverged: 1,
  behind: 2,
  unpushed: 3,
  dirty: 4,
  stale: 5,
};

export function stashActivityTimestamp(stash: VcsPanelStash): number {
  if (!stash.createdAt) return 0;
  const time = Date.parse(stash.createdAt);
  return Number.isFinite(time) ? time : 0;
}

export function AttentionIcon({ kind }: { readonly kind: AttentionKind }) {
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

export function AuthorAvatar({
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
      onError={() => setFailed(true)}
    />
  );
}

type DisplayHeadRef =
  | { readonly kind: "local"; readonly name: string; readonly synced: boolean }
  | { readonly kind: "remote"; readonly name: string };

function displayHeadRefs(
  headRefs: readonly string[],
  remoteNames: readonly string[] = [],
): DisplayHeadRef[] {
  const remoteNameSet = new Set(remoteNames);
  const remoteRefParts = (
    ref: string,
  ): { readonly remoteName: string; readonly branchName: string } | null => {
    const slashIndex = ref.indexOf("/");
    if (slashIndex <= 0) return null;
    const remoteName = ref.slice(0, slashIndex);
    if (!remoteNameSet.has(remoteName)) return null;
    const branchName = ref.slice(slashIndex + 1);
    if (branchName.length === 0 || branchName === "HEAD") return null;
    return { remoteName, branchName };
  };
  const localRefs = new Set(headRefs.filter((ref) => remoteRefParts(ref) === null));
  const remoteByBranch = new Map<string, string>();
  for (const ref of headRefs) {
    const parsed = remoteRefParts(ref);
    if (parsed) remoteByBranch.set(parsed.branchName, ref);
  }
  const refs: DisplayHeadRef[] = [...localRefs]
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => ({ kind: "local", name, synced: remoteByBranch.has(name) }));
  for (const branchName of [...remoteByBranch.keys()].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (!localRefs.has(branchName)) refs.push({ kind: "remote", name: branchName });
  }
  return refs;
}

export function SyncedIcon({ className }: { readonly className?: string }) {
  return <Target className={cn("size-3 shrink-0", className)} aria-label="Synced upstream" />;
}

export function CompactBadge({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-4 items-center rounded border border-border/70 px-1 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

export function RefLabels({
  commit,
  remoteNames,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly remoteNames?: readonly string[] | undefined;
}) {
  const headRefs = displayHeadRefs(commit.headRefs, remoteNames);
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

function sumFiles(files: readonly VcsPanelFileChange[]) {
  return files.reduce(
    (sum, file) => ({
      insertions: sum.insertions + file.insertions,
      deletions: sum.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}

export function CommitTooltip({
  commit,
  remoteNames,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly remoteNames?: readonly string[] | undefined;
}) {
  const relativeDate = formatRelativeDate(commit.authoredAt);
  const readableDate = formatReadableDate(commit.authoredAt);
  const stats = sumFiles(commit.files);
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
      <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
      <RefLabels commit={commit} remoteNames={remoteNames} />
    </div>
  );
}

function fileTooltipAnchor(trigger: HTMLElement | null) {
  if (!trigger) return null;
  const panel = trigger.closest<HTMLElement>("[data-source-control-tooltip-boundary]");
  if (!panel) return trigger;
  return {
    contextElement: trigger,
    getBoundingClientRect: () => {
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const left = panelRect.left + 8;
      return DOMRect.fromRect({
        x: left,
        y: triggerRect.top,
        width: Math.max(0, triggerRect.right - left),
        height: triggerRect.height,
      });
    },
  };
}

function TooltipMetadataRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-1.5 text-muted-foreground">
      <span>{label}</span>
      <span className="min-w-0 break-all font-mono leading-4 text-foreground/90">{value}</span>
    </div>
  );
}

function FilePathTooltip({
  file,
  anchor,
}: {
  readonly file: VcsPanelFileChange;
  readonly anchor: () => ReturnType<typeof fileTooltipAnchor>;
}) {
  return (
    <TooltipCardPopup anchor={anchor} side="left" align="start">
      <div className="max-w-80 space-y-1.5 px-2 py-1.5 text-left">
        <div className="break-all font-mono text-xs text-foreground">{file.path}</div>
        {file.originalPath && file.originalPath !== file.path ? (
          <TooltipMetadataRow label="Renamed from" value={file.originalPath} />
        ) : null}
        <StatLabels insertions={file.insertions} deletions={file.deletions} />
      </div>
    </TooltipCardPopup>
  );
}

export function WorkingFileTooltipRow({
  children,
  file,
  onContextMenu,
  onToggle,
}: {
  readonly children: ReactNode;
  readonly file: VcsPanelFileChange;
  readonly onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onToggle: () => void;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipAnchor = useCallback(() => fileTooltipAnchor(triggerRef.current), []);
  return (
    <Tooltip preserveOnNestedTriggerHover>
      <TooltipTrigger
        render={
          <div
            ref={triggerRef}
            role="button"
            tabIndex={0}
            data-file-change-tooltip-anchor
            className="group relative flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
            onClick={onToggle}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onToggle();
            }}
            onContextMenu={onContextMenu}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <FilePathTooltip file={file} anchor={tooltipAnchor} />
    </Tooltip>
  );
}

export function fileStatusLetter(status: VcsPanelFileChange["status"]): string {
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

export function fileStatusColor(status: VcsPanelFileChange["status"]): string {
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

export function FileChangeTooltipRow({
  expanded,
  file,
  onFileContextMenu,
  onFileToggle,
  onOpenFile,
  onOpenInVsCode,
}: {
  readonly expanded: boolean;
  readonly file: VcsPanelFileChange;
  readonly onFileContextMenu?:
    | ((event: ReactMouseEvent<HTMLDivElement>, file: VcsPanelFileChange) => void)
    | undefined;
  readonly onFileToggle?: ((file: VcsPanelFileChange) => void) | undefined;
  readonly onOpenFile?: ((file: VcsPanelFileChange) => void) | undefined;
  readonly onOpenInVsCode?: ((file: VcsPanelFileChange) => void) | undefined;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipAnchor = useCallback(() => fileTooltipAnchor(triggerRef.current), []);
  return (
    <Tooltip preserveOnNestedTriggerHover>
      <TooltipTrigger
        render={
          <div
            ref={triggerRef}
            role={onFileToggle ? "button" : undefined}
            tabIndex={onFileToggle ? 0 : undefined}
            data-file-change-tooltip-anchor
            className="group relative flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
            onClick={onFileToggle ? () => onFileToggle(file) : undefined}
            onKeyDown={
              onFileToggle
                ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onFileToggle(file);
                  }
                : undefined
            }
            onContextMenu={
              onFileContextMenu ? (event) => onFileContextMenu(event, file) : undefined
            }
          />
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
      </TooltipTrigger>
      <FilePathTooltip file={file} anchor={tooltipAnchor} />
    </Tooltip>
  );
}

export function BranchTooltip({
  branch,
  displayName,
  aheadCount,
  behindCount,
}: {
  readonly branch: VcsRef;
  readonly displayName: string;
  readonly aheadCount: number;
  readonly behindCount: number;
}) {
  const relativeDate = formatRelativeDate(branch.lastActivityAt);
  const readableDate = formatReadableDate(branch.lastActivityAt);
  return (
    <TooltipCardPopup side="left" align="start">
      <div className="w-72 max-w-full space-y-2 px-2 py-1.5 text-left">
        <div className="break-all text-sm font-medium text-foreground">{displayName}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          {branch.name !== displayName ? (
            <TooltipMetadataRow label="Ref" value={branch.name} />
          ) : null}
          {branch.upstreamName ? (
            <TooltipMetadataRow label="Upstream" value={branch.upstreamName} />
          ) : null}
          {branch.worktreePath ? (
            <TooltipMetadataRow label="Worktree" value={branch.worktreePath} />
          ) : null}
          {branch.current || branch.isDefault || aheadCount > 0 || behindCount > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {branch.current ? <CompactBadge>current</CompactBadge> : null}
              {branch.isDefault ? <CompactBadge>default</CompactBadge> : null}
              <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
            </div>
          ) : null}
          {relativeDate || readableDate ? (
            <div>
              {relativeDate ?? "Unknown time"}
              {readableDate ? ` (${readableDate})` : null}
            </div>
          ) : null}
        </div>
      </div>
    </TooltipCardPopup>
  );
}

export function WorkingTreeTooltip({
  changeSet,
}: {
  readonly changeSet: WorkingTreeChangeSetView;
}) {
  const stats = sumFiles(changeSet.files);
  return (
    <TooltipCardPopup side="left" align="start">
      <div className="w-72 max-w-full space-y-2 px-2 py-1.5 text-left">
        <div className="text-sm font-medium text-foreground">
          {changeSet.current ? "Working tree" : "Sibling working tree"}
        </div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          <TooltipMetadataRow label="Branch" value={changeSet.branchName ?? "Detached HEAD"} />
          <TooltipMetadataRow label="Worktree" value={changeSet.worktreePath ?? changeSet.cwd} />
          <div className="flex flex-wrap items-center gap-1.5">
            <span>
              {changeSet.files.length === 1 ? "1 file" : `${changeSet.files.length} files`}
            </span>
            <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
          </div>
        </div>
      </div>
    </TooltipCardPopup>
  );
}

export function RemoteTooltip({ remote }: { readonly remote: VcsPanelRemote }) {
  return (
    <TooltipCardPopup side="left" align="start">
      <div className="w-72 max-w-full space-y-2 px-2 py-1.5 text-left">
        <div className="break-all text-sm font-medium text-foreground">{remote.name}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          <TooltipMetadataRow label="Fetch" value={remote.fetchUrl ?? "No fetch URL"} />
          {remote.pushUrl && remote.pushUrl !== remote.fetchUrl ? (
            <TooltipMetadataRow label="Push" value={remote.pushUrl} />
          ) : null}
          <div>
            {remote.branches.length === 1 ? "1 branch" : `${remote.branches.length} branches`}
          </div>
        </div>
      </div>
    </TooltipCardPopup>
  );
}

export function StashTooltip({
  stash,
  branchName,
}: {
  readonly stash: VcsPanelStash;
  readonly branchName: string | null;
}) {
  const relativeDate = formatRelativeDate(stash.createdAt);
  const readableDate = formatReadableDate(stash.createdAt);
  return (
    <TooltipCardPopup side="left" align="start">
      <div className="w-72 space-y-2 px-2 py-1.5 text-left">
        <div className="wrap-break-word text-sm font-medium text-foreground">{stash.message}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          <div>
            Ref <span className="font-mono text-foreground/90">{stash.refName}</span>
          </div>
          {branchName ? <TooltipMetadataRow label="Branch" value={branchName} /> : null}
          {relativeDate || readableDate ? (
            <div>
              {relativeDate ?? "Unknown time"}
              {readableDate ? ` (${readableDate})` : null}
            </div>
          ) : null}
        </div>
      </div>
    </TooltipCardPopup>
  );
}

export function IconButton({
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
              destructive &&
                "[--control-icon-color:currentColor] text-destructive-foreground hover:text-destructive-foreground",
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

export function RowActions({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded bg-background/95 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
