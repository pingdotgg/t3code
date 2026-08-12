import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import type { EnvironmentId, ThreadTurnDiffGroup } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildFileDiffRenderKey,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import {
  buildRepoFilterOptions,
  repoRootBaseName,
  scopedDiffFileKey,
  shouldUseGroupedCheckpointDiff,
} from "../lib/diffRepoKeys";
import { reviewEnvironment } from "../state/review";
import { useEnvironmentQuery } from "../state/query";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type DiffThemeType = "light" | "dark";

export interface DiffRepoTarget {
  readonly repoRoot: string;
  readonly cwd: string;
}

interface RenderableDiffGroup {
  readonly repoRoot: string;
  readonly displayName: string;
  readonly files: ReadonlyArray<FileDiffMetadata>;
}

interface RepoFileDiffProps {
  readonly fileDiff: FileDiffMetadata;
  readonly repoRoot: string;
  readonly collapsedDiffFileKeys: ReadonlySet<string>;
  readonly diffRenderMode: "stacked" | "split";
  readonly wordWrap: boolean;
  readonly resolvedTheme: string;
  readonly openDiffFile: (filePath: string, repoRoot: string) => void;
  readonly toggleDiffFileCollapsed: (fileKey: string) => void;
}

interface RepoDiffPresentationProps extends Omit<RepoFileDiffProps, "fileDiff" | "repoRoot"> {}

export function useRefreshOnReopen(refresh: () => void, hasCachedData: boolean) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const reopenedRef = useRef(hasCachedData);
  useEffect(() => {
    if (reopenedRef.current) refreshRef.current();
  }, []);
}

export function useMultiRepoDiffState(input: {
  readonly isMultiRepoBranchView: boolean;
  readonly diffRepoTargets: ReadonlyArray<DiffRepoTarget>;
  readonly checkpointGroups: ReadonlyArray<ThreadTurnDiffGroup> | undefined;
  readonly resolvedTheme: string;
  readonly selectedFilePath: string | null;
  readonly selectedRepoRoot: string | null;
  readonly selectedFileRevealRequestId: number;
}) {
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const renderableGroups = useMemo(() => {
    if (!input.checkpointGroups || input.checkpointGroups.length === 0) return [];
    return input.checkpointGroups
      .map((group) => {
        const renderable = getRenderablePatch(
          group.diff,
          `diff-panel:${group.repoRoot}:${input.resolvedTheme}`,
        );
        const files =
          renderable?.kind === "files"
            ? renderable.files.toSorted((left, right) =>
                resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
              )
            : [];
        return { repoRoot: group.repoRoot, displayName: group.displayName, files };
      })
      .filter((group) => group.files.length > 0);
  }, [input.checkpointGroups, input.resolvedTheme]);
  const isGroupedDiffView = shouldUseGroupedCheckpointDiff(
    input.checkpointGroups?.length ?? 0,
    renderableGroups.length,
  );
  const repoFilterOptions = useMemo(() => {
    const roots = input.isMultiRepoBranchView
      ? input.diffRepoTargets.map((entry) => entry.repoRoot)
      : renderableGroups.map((group) => group.repoRoot);
    return buildRepoFilterOptions(roots);
  }, [input.diffRepoTargets, input.isMultiRepoBranchView, renderableGroups]);
  const effectiveRepoFilter =
    repoFilter && repoFilterOptions.some((option) => option.repoRoot === repoFilter)
      ? repoFilter
      : null;

  useEffect(() => {
    if (!isGroupedDiffView || !input.selectedFilePath || !input.selectedRepoRoot) return;
    if (effectiveRepoFilter && effectiveRepoFilter !== input.selectedRepoRoot) {
      setRepoFilter(input.selectedRepoRoot);
      return;
    }
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-diff-repo-root="${CSS.escape(input.selectedRepoRoot!)}"][data-diff-file-path="${CSS.escape(input.selectedFilePath!)}"]`,
        )
        ?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    effectiveRepoFilter,
    input.selectedFilePath,
    input.selectedFileRevealRequestId,
    input.selectedRepoRoot,
    isGroupedDiffView,
  ]);

  return {
    effectiveRepoFilter,
    effectiveRepoFilterLabel:
      repoFilterOptions.find((option) => option.repoRoot === effectiveRepoFilter)?.displayName ??
      "All repos",
    groupedDiffFileKeys: renderableGroups.flatMap((group) =>
      group.files.map((file) => scopedDiffFileKey(buildFileDiffRenderKey(file), group.repoRoot)),
    ),
    isGroupedDiffView,
    repoFilterOptions,
    setRepoFilter,
    showRepoFilter: repoFilterOptions.length > 1,
    visibleDiffTargets: effectiveRepoFilter
      ? input.diffRepoTargets.filter((entry) => entry.repoRoot === effectiveRepoFilter)
      : input.diffRepoTargets,
    visibleGroups: effectiveRepoFilter
      ? renderableGroups.filter((group) => group.repoRoot === effectiveRepoFilter)
      : renderableGroups,
  };
}

export function MultiRepoDiffContextControl(props: {
  readonly showRepoFilter: boolean;
  readonly repoFilterOptions: ReadonlyArray<{
    readonly repoRoot: string;
    readonly displayName: string;
  }>;
  readonly effectiveRepoFilter: string | null;
  readonly effectiveRepoFilterLabel: string;
  readonly worktreePath: string | null;
  readonly setRepoFilter: (repoRoot: string | null) => void;
}) {
  if (props.showRepoFilter) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Filter diff by repo. Currently ${props.effectiveRepoFilterLabel}`}
        >
          <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
          <span className="max-w-32 truncate">{props.effectiveRepoFilterLabel}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => props.setRepoFilter(null)}>
            <span>All repos</span>
            {props.effectiveRepoFilter === null && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
          {props.repoFilterOptions.map((option) => (
            <DropdownMenuItem
              key={option.repoRoot}
              onClick={() => props.setRepoFilter(option.repoRoot)}
              title={option.repoRoot}
            >
              <span className="truncate">{option.displayName}</span>
              {props.effectiveRepoFilter === option.repoRoot && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (!props.worktreePath) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground"
            aria-label={`Diff reflects the thread worktree at ${props.worktreePath}`}
          >
            <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
            <span className="max-w-32 truncate">{repoRootBaseName(props.worktreePath)}</span>
          </span>
        }
      />
      <TooltipPopup side="bottom" className="max-w-80 whitespace-normal leading-tight">
        Reflects this thread&apos;s isolated worktree, not your own checkout of the repo:
        <br />
        <span className="font-mono break-all">{props.worktreePath}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

function RepoFileDiff({
  fileDiff,
  repoRoot,
  collapsedDiffFileKeys,
  diffRenderMode,
  wordWrap,
  resolvedTheme,
  openDiffFile,
  toggleDiffFileCollapsed,
}: RepoFileDiffProps) {
  const filePath = resolveFileDiffPath(fileDiff);
  const fileKey = buildFileDiffRenderKey(fileDiff);
  const collapseFileKey = scopedDiffFileKey(fileKey, repoRoot);
  const collapsed = collapsedDiffFileKeys.has(collapseFileKey);
  return (
    <div
      key={`${repoRoot}:${fileKey}:${resolvedTheme}`}
      data-diff-file-path={filePath}
      data-diff-repo-root={repoRoot}
      className="diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0"
      onClickCapture={(event) => {
        const composedPath = event.nativeEvent.composedPath?.() ?? [];
        const clickedHeader = composedPath.some(
          (node) => node instanceof Element && node.hasAttribute("data-title"),
        );
        if (clickedHeader) openDiffFile(filePath, repoRoot);
      }}
    >
      <FileDiff
        fileDiff={fileDiff}
        renderHeaderPrefix={() => (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                    getDiffCollapseIconClassName(fileDiff),
                  )}
                  aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                  aria-expanded={!collapsed}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleDiffFileCollapsed(collapseFileKey);
                  }}
                />
              }
            >
              {collapsed ? (
                <ChevronRightIcon className="size-4" />
              ) : (
                <ChevronDownIcon className="size-4" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
          </Tooltip>
        )}
        options={{
          collapsed,
          diffStyle: diffRenderMode === "split" ? "split" : "unified",
          lineDiffType: "none",
          overflow: wordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(resolvedTheme as DiffThemeType),
          themeType: resolvedTheme as DiffThemeType,
        }}
      />
    </div>
  );
}

function BranchDiffRepoSection(
  props: DiffRepoTarget &
    RepoDiffPresentationProps & {
      readonly environmentId: EnvironmentId;
      readonly scope: "branch" | "unstaged";
      readonly baseRef: string | null;
      readonly ignoreWhitespace: boolean;
      readonly refreshVersion: number;
    },
) {
  const preview = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        ignoreWhitespace: props.ignoreWhitespace,
        ...(props.baseRef ? { baseRef: props.baseRef } : {}),
      },
    }),
  );
  useRefreshOnReopen(preview.refresh, preview.data !== null);
  const refreshRef = useRef(preview.refresh);
  refreshRef.current = preview.refresh;
  useEffect(() => {
    if (props.refreshVersion > 0) refreshRef.current();
  }, [props.refreshVersion]);
  const source = preview.data?.sources.find(
    (entry) => entry.kind === (props.scope === "unstaged" ? "working-tree" : "branch-range"),
  );
  const files = useMemo(() => {
    const renderable = getRenderablePatch(
      source?.diff,
      `diff-panel:${props.repoRoot}:${props.resolvedTheme}`,
      { compactPartialHunkOffsets: true },
    );
    if (!renderable || renderable.kind !== "files") return [];
    return renderable.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [props.repoRoot, props.resolvedTheme, source?.diff]);
  const countLabel =
    preview.isPending && source === undefined
      ? "Loading…"
      : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return (
    <div>
      <div
        className="diff-render-group-header sticky top-0 z-10 mt-2 mb-1 flex items-center gap-2 rounded-md bg-background/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur first:mt-0"
        title={props.cwd}
      >
        <span className="truncate text-foreground/90">{repoRootBaseName(props.repoRoot)}</span>
        <span className="text-muted-foreground/70">{countLabel}</span>
        {source?.truncated === true && <span className="text-amber-500/80">truncated</span>}
      </div>
      {preview.error && files.length === 0 ? (
        <p className="px-2 pb-2 text-[11px] text-red-500/80">{preview.error}</p>
      ) : (
        files.map((fileDiff) => (
          <RepoFileDiff
            key={`${props.repoRoot}:${buildFileDiffRenderKey(fileDiff)}`}
            {...props}
            fileDiff={fileDiff}
          />
        ))
      )}
    </div>
  );
}

export function MultiRepoBranchDiff(
  props: RepoDiffPresentationProps & {
    readonly environmentId: EnvironmentId;
    readonly targets: ReadonlyArray<DiffRepoTarget>;
    readonly scope: "branch" | "unstaged";
    readonly baseRef: string | null;
    readonly ignoreWhitespace: boolean;
    readonly refreshVersion: number;
  },
) {
  return (
    <div className="diff-render-surface min-h-0 flex-1 overflow-auto">
      {props.targets.map((target) => (
        <BranchDiffRepoSection key={target.repoRoot} {...props} {...target} />
      ))}
    </div>
  );
}

export function MultiRepoCheckpointDiff(
  props: RepoDiffPresentationProps & {
    readonly groups: ReadonlyArray<RenderableDiffGroup>;
  },
) {
  return (
    <Virtualizer
      className="diff-render-surface h-full min-h-0 overflow-auto"
      config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
    >
      {props.groups.flatMap((group) => [
        <div
          key={`diff-group:${group.repoRoot}`}
          className="diff-render-group-header sticky top-0 z-10 mt-2 mb-1 flex items-center gap-2 rounded-md bg-background/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur first:mt-0"
          title={group.repoRoot}
        >
          <span className="truncate text-foreground/90">{group.displayName}</span>
          <span className="text-muted-foreground/70">
            {group.files.length} {group.files.length === 1 ? "file" : "files"}
          </span>
        </div>,
        ...group.files.map((fileDiff) => (
          <RepoFileDiff
            key={`${group.repoRoot}:${buildFileDiffRenderKey(fileDiff)}`}
            {...props}
            fileDiff={fileDiff}
            repoRoot={group.repoRoot}
          />
        )),
      ])}
    </Virtualizer>
  );
}
