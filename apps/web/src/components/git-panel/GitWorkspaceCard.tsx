import {
  ArrowRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  UploadIcon,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { WorkspaceStatusLevel } from "./GitPanel.logic";
import { GitCopyablePath } from "./GitCopyablePath";
import { GitStatusDot } from "./GitStatusDot";

interface GitWorkspaceCardProps {
  isPrimary: boolean;
  name: string;
  branch: string;
  targetBranch: string | null;
  path: string | null;
  statusLevel: WorkspaceStatusLevel;
  statusLabel: string;
  aheadCount: number;
  behindCount: number;
  hasOpenPr: boolean;
  isDefaultBranch: boolean;
  onOpen: () => void;
}

export function GitWorkspaceCard({
  isPrimary,
  name,
  branch,
  targetBranch,
  path,
  statusLevel,
  statusLabel,
  aheadCount,
  behindCount,
  hasOpenPr,
  isDefaultBranch,
  onOpen,
}: GitWorkspaceCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        isPrimary
          ? "border-border bg-card"
          : "border-primary/20 bg-primary/[0.02] dark:bg-primary/[0.04]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderGit2Icon
            className={cn("size-4 shrink-0", isPrimary ? "text-muted-foreground" : "text-primary")}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{name}</span>
              {!isPrimary && (
                <Badge variant="secondary" size="sm">
                  Dedicated
                </Badge>
              )}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onOpen} title="Open in editor">
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <div className="flex items-center gap-1 text-muted-foreground">
          <GitBranchIcon className="size-3" />
          <span className="font-mono">{branch}</span>
        </div>
        {targetBranch && !isDefaultBranch && (
          <>
            <ArrowRightIcon className="size-3 text-muted-foreground/50" />
            <span className="font-mono text-muted-foreground">{targetBranch}</span>
          </>
        )}
        {isDefaultBranch && (
          <Badge variant="warning" size="sm">
            default
          </Badge>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <div className="flex items-center gap-1.5">
          <GitStatusDot level={statusLevel} pulse={statusLevel === "error"} />
          <span className="text-muted-foreground">{statusLabel}</span>
        </div>
        {aheadCount > 0 && (
          <span className="flex items-center gap-1 text-success-foreground">
            <UploadIcon className="size-3" />
            {aheadCount}
          </span>
        )}
        {behindCount > 0 && (
          <span className="flex items-center gap-1 text-warning-foreground">
            <DownloadIcon className="size-3" />
            {behindCount}
          </span>
        )}
        {hasOpenPr && (
          <Badge variant="info" size="sm">
            <GitPullRequestIcon className="size-3" />
            PR
          </Badge>
        )}
      </div>

      {path && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <GitCopyablePath path={path} />
        </div>
      )}
    </div>
  );
}
