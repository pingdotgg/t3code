import {
  ChevronDownIcon,
  ClipboardIcon,
  Columns2Icon,
  EllipsisVerticalIcon,
  FilesIcon,
  FoldVerticalIcon,
  GitBranchIcon,
  RefreshCwIcon,
  Rows3Icon,
  UnfoldVerticalIcon,
} from "lucide-react";
import type { TurnId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import type { TurnDiffSummary } from "../types";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { Button } from "./ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type DiffRenderMode = "stacked" | "split";

/** A resolved diff selection the panel can render. */
export type DiffSourceSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "working-tree" }
  | { kind: "all-turns" }
  | { kind: "last-turn" }
  | { kind: "turn"; turnId: TurnId };

export interface DiffBranchOption {
  name: string;
  current: boolean;
  isDefault: boolean;
  isRemote: boolean;
}

export interface DiffPanelToolbarProps {
  source: DiffSourceSelection;
  currentBranch: string | null;
  branchBaseLabel: string | null;
  branches: ReadonlyArray<DiffBranchOption>;
  changedTurnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  turnPromptByTurnId: Record<string, string>;
  latestTurnId: TurnId | null;
  inferredCheckpointTurnCountByTurnId: Record<string, number>;
  formatTurnTimestamp: (completedAt: string) => string;
  onSelectSource: (source: DiffSourceSelection) => void;

  additions: number;
  deletions: number;

  railCollapsed: boolean;
  onToggleRail: () => void;

  diffRenderMode: DiffRenderMode;
  onDiffRenderModeChange: (mode: DiffRenderMode) => void;
  diffWordWrap: boolean;
  onDiffWordWrapChange: (value: boolean) => void;
  diffIgnoreWhitespace: boolean;
  onDiffIgnoreWhitespaceChange: (value: boolean) => void;

  allCollapsed: boolean;
  onToggleCollapseAll: () => void;

  onRefresh: () => void;
  onCopyGitApply?: (() => void) | undefined;
}

function shortRefName(ref: string): string {
  // Drop a leading remote prefix for display (e.g. origin/dev -> dev).
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(slash + 1) : ref;
}

function sourceLabel(
  source: DiffSourceSelection,
  options: {
    currentBranch: string | null;
    branchBaseLabel: string | null;
    summaries: ReadonlyArray<TurnDiffSummary>;
    inferred: Record<string, number>;
  },
): string {
  switch (source.kind) {
    case "branch": {
      const base = source.baseRef ?? options.branchBaseLabel;
      const current = options.currentBranch ? shortRefName(options.currentBranch) : "HEAD";
      return base ? `${current} → ${shortRefName(base)}` : current;
    }
    case "working-tree":
      return "Working tree";
    case "all-turns":
      return "All turns";
    case "last-turn":
      return "Last turn";
    case "turn": {
      const summary = options.summaries.find((entry) => entry.turnId === source.turnId);
      const count =
        summary?.checkpointTurnCount ??
        (summary ? options.inferred[summary.turnId] : undefined) ??
        "?";
      return `Turn ${count}`;
    }
  }
}

export function DiffPanelToolbar(props: DiffPanelToolbarProps) {
  const {
    source,
    currentBranch,
    branchBaseLabel,
    branches,
    changedTurnDiffSummaries,
    turnPromptByTurnId,
    latestTurnId,
    inferredCheckpointTurnCountByTurnId,
    formatTurnTimestamp,
    onSelectSource,
    additions,
    deletions,
    railCollapsed,
    onToggleRail,
    diffRenderMode,
    onDiffRenderModeChange,
    diffWordWrap,
    onDiffWordWrapChange,
    diffIgnoreWhitespace,
    onDiffIgnoreWhitespaceChange,
    allCollapsed,
    onToggleCollapseAll,
    onRefresh,
    onCopyGitApply,
  } = props;

  const activeLabel = sourceLabel(source, {
    currentBranch,
    branchBaseLabel,
    summaries: changedTurnDiffSummaries,
    inferred: inferredCheckpointTurnCountByTurnId,
  });
  const effectiveBaseRef = source.kind === "branch" ? (source.baseRef ?? branchBaseLabel) : null;

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={railCollapsed ? "Show file tree" : "Hide file tree"}
              aria-pressed={!railCollapsed}
              className={cn(
                "inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
                railCollapsed ? "text-muted-foreground/70" : "bg-accent/60 text-foreground",
              )}
              onClick={() => onToggleRail()}
            >
              <FilesIcon className="size-4" />
            </button>
          }
        />
        <TooltipPopup side="bottom">
          {railCollapsed ? "Show file tree" : "Hide file tree"}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
            >
              <span className="truncate">{activeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          }
        />
        <MenuPopup align="start" className="min-w-44">
          <MenuItem
            onClick={() => onSelectSource({ kind: "working-tree" })}
            className={cn(source.kind === "working-tree" && "bg-accent/60")}
          >
            Working tree
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger className={cn(source.kind === "branch" && "bg-accent/60")}>
              <span className="flex-1">Branch</span>
              {effectiveBaseRef ? (
                <span className="ml-2 max-w-28 truncate text-[10px] text-muted-foreground/70">
                  {shortRefName(effectiveBaseRef)}
                </span>
              ) : null}
            </MenuSubTrigger>
            <MenuSubPopup className="max-h-80 min-w-52">
              {branches.length === 0 ? (
                <MenuItem disabled>No branches found</MenuItem>
              ) : (
                branches.map((branch) => {
                  const isActive = source.kind === "branch" && effectiveBaseRef === branch.name;
                  return (
                    <MenuItem
                      key={branch.name}
                      onClick={() => onSelectSource({ kind: "branch", baseRef: branch.name })}
                      className={cn(isActive && "bg-accent/60")}
                    >
                      <GitBranchIcon className="size-3.5 text-muted-foreground/70" />
                      <span className="flex-1 truncate">{branch.name}</span>
                      {branch.current ? (
                        <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/60">
                          current
                        </span>
                      ) : branch.isDefault ? (
                        <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/60">
                          default
                        </span>
                      ) : null}
                    </MenuItem>
                  );
                })
              )}
            </MenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem
            disabled={latestTurnId === null}
            onClick={() => onSelectSource({ kind: "last-turn" })}
            className={cn(source.kind === "last-turn" && "bg-accent/60")}
          >
            Last turn
          </MenuItem>
          <MenuItem
            disabled={changedTurnDiffSummaries.length === 0}
            onClick={() => onSelectSource({ kind: "all-turns" })}
            className={cn(source.kind === "all-turns" && "bg-accent/60")}
          >
            All turns
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger
              disabled={changedTurnDiffSummaries.length === 0}
              className={cn(source.kind === "turn" && "bg-accent/60")}
            >
              Turns
            </MenuSubTrigger>
            <MenuSubPopup className="max-h-80 min-w-48">
              {changedTurnDiffSummaries.map((summary) => {
                const count =
                  summary.checkpointTurnCount ??
                  inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                  "?";
                const isActive = source.kind === "turn" && source.turnId === summary.turnId;
                return (
                  <MenuItem
                    key={summary.turnId}
                    onClick={() => onSelectSource({ kind: "turn", turnId: summary.turnId })}
                    className={cn(isActive && "bg-accent/60")}
                  >
                    <span className="flex-1">Turn {count}</span>
                    <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/70">
                      {formatTurnTimestamp(summary.completedAt)}
                    </span>
                  </MenuItem>
                );
              })}
            </MenuSubPopup>
          </MenuSub>
        </MenuPopup>
      </Menu>

      <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
        <DiffStatLabel additions={additions} deletions={deletions} />
      </div>

      <div className="ml-auto flex shrink-0 items-center">
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="Diff display options"
                title="Display options"
                variant="ghost"
                size="icon-xs"
              />
            }
          >
            <EllipsisVerticalIcon className="size-4 text-muted-foreground" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            <MenuGroup>
              <MenuGroupLabel>Layout</MenuGroupLabel>
              <div className="px-2 pb-1 pt-0.5">
                <ToggleGroup
                  className="w-full"
                  variant="outline"
                  size="sm"
                  value={[diffRenderMode]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "stacked" || next === "split") onDiffRenderModeChange(next);
                  }}
                >
                  <Toggle className="flex-1 gap-1.5" aria-label="Unified view" value="stacked">
                    <Rows3Icon className="size-3.5" />
                    Unified
                  </Toggle>
                  <Toggle className="flex-1 gap-1.5" aria-label="Split view" value="split">
                    <Columns2Icon className="size-3.5" />
                    Split
                  </Toggle>
                </ToggleGroup>
              </div>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem
              variant="switch"
              checked={diffWordWrap}
              onCheckedChange={(checked) => onDiffWordWrapChange(Boolean(checked))}
              closeOnClick={false}
            >
              Word wrap
            </MenuCheckboxItem>
            <MenuCheckboxItem
              variant="switch"
              checked={!diffIgnoreWhitespace}
              onCheckedChange={(checked) => onDiffIgnoreWhitespaceChange(!checked)}
              closeOnClick={false}
            >
              Show whitespace
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem onClick={() => onToggleCollapseAll()}>
              {allCollapsed ? <UnfoldVerticalIcon /> : <FoldVerticalIcon />}
              {allCollapsed ? "Expand all diffs" : "Collapse all diffs"}
            </MenuItem>
            <MenuItem onClick={() => onRefresh()}>
              <RefreshCwIcon />
              Refresh
            </MenuItem>
            {onCopyGitApply ? (
              <MenuItem onClick={() => onCopyGitApply()}>
                <ClipboardIcon />
                Copy git apply command
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
