import type { GitBranch, GitMergeBranchesResult, GitStatusResult } from "@t3tools/contracts";
import { ArrowRightIcon, DownloadIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { GitPanelSection } from "./GitPanelSection";
import { resolveMergeDisabledReason } from "./GitSyncSection.logic";

interface GitSyncSectionProps {
  localBranches: GitBranch[];
  activeWorkspaceBranch: string | null;
  mergeSourceBranch: string;
  onMergeSourceBranchChange: (value: string) => void;
  gitStatus: GitStatusResult | null;
  mergeState: GitStatusResult["merge"];
  hasConflicts: boolean;
  isMergeRunning: boolean;
  isAbortMergeRunning: boolean;
  activeThreadId: string | null;
  lastMergeResult: GitMergeBranchesResult | null;
  defaultOpen: boolean;
  onRunLocalMerge: () => void | Promise<void>;
  onCreateResolveConflictDraft: () => void;
  onAbortActiveMerge: () => void | Promise<void>;
}

export function GitSyncSection({
  localBranches,
  activeWorkspaceBranch,
  mergeSourceBranch,
  onMergeSourceBranchChange,
  gitStatus,
  mergeState,
  hasConflicts,
  isMergeRunning,
  isAbortMergeRunning,
  activeThreadId,
  lastMergeResult,
  defaultOpen,
  onRunLocalMerge,
  onCreateResolveConflictDraft,
  onAbortActiveMerge,
}: GitSyncSectionProps) {
  const mergeDisabledReason = resolveMergeDisabledReason({
    gitStatus,
    activeWorkspaceBranch,
    mergeSourceBranch,
    hasConflicts,
    mergeInProgress: mergeState.inProgress,
    isMerging: isMergeRunning,
  });

  return (
    <GitPanelSection title="Sync" collapsible defaultOpen={defaultOpen}>
      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">
          Pull a branch <span className="font-medium">into</span> this workspace
        </p>

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">From branch</span>
            <select
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={mergeSourceBranch}
              onChange={(event) => onMergeSourceBranchChange(event.target.value)}
              disabled={localBranches.length < 2}
            >
              {mergeSourceBranch.length === 0 && <option value="">No candidates</option>}
              {localBranches
                .filter((branch) => branch.name !== activeWorkspaceBranch)
                .map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={mergeDisabledReason !== null}
            onClick={() => void onRunLocalMerge()}
          >
            <DownloadIcon className="size-4" />
            {isMergeRunning ? "Syncing..." : "Sync"}
          </Button>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{mergeSourceBranch || "..."}</span>
          <ArrowRightIcon className="size-3" />
          <span className="font-mono font-medium">{activeWorkspaceBranch ?? "..."}</span>
        </div>

        {mergeDisabledReason && (
          <p className="text-xs text-muted-foreground">{mergeDisabledReason}</p>
        )}

        {hasConflicts && (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/[0.04] p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-destructive-foreground">
                {mergeState.conflictedFiles.length} conflicted file
                {mergeState.conflictedFiles.length === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!activeThreadId}
                  onClick={onCreateResolveConflictDraft}
                >
                  Resolve conflict
                </Button>
                <Button
                  variant="destructive-outline"
                  size="xs"
                  disabled={isAbortMergeRunning}
                  onClick={() => void onAbortActiveMerge()}
                >
                  Abort
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {mergeState.conflictedFiles.map((file) => (
                <Badge key={file} variant="outline" size="sm">
                  {file}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {lastMergeResult && !hasConflicts && (
          <div
            className={cn(
              "rounded-md border p-2 text-xs",
              lastMergeResult.status === "merged"
                ? "border-success/30 bg-success/[0.04] text-success-foreground"
                : "border-destructive/30 bg-destructive/[0.04] text-destructive-foreground",
            )}
          >
            {lastMergeResult.status === "merged"
              ? `Merged ${lastMergeResult.sourceBranch} → ${lastMergeResult.targetBranch}`
              : `Conflicts merging ${lastMergeResult.sourceBranch}`}
          </div>
        )}
      </div>
    </GitPanelSection>
  );
}
