import type { GitButlerWorkspaceStatus } from "@t3tools/contracts";
import { GitBranch, TriangleAlert } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  FileChanges,
  GITBUTLER_RENDER_LIMITS,
  GitButlerStackSection,
  shortCommitId,
} from "./GitButlerWorkspaceStack";

export function StateMessage({
  title,
  detail,
  tone = "neutral",
}: {
  readonly title: string;
  readonly detail: string;
  readonly tone?: "neutral" | "warning";
}) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm rounded-xl border border-border/70 bg-card p-5">
        <GitBranch
          className={cn(
            "mx-auto mb-3 size-5",
            tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function GitButlerUnavailableState() {
  return (
    <StateMessage
      title="GitButler unavailable"
      detail="Update this environment's T3 Code server to inspect GitButler workspaces."
    />
  );
}

export function GitButlerPanelContent({
  status,
  onOpenReview,
  onOpenFile,
}: {
  readonly status: GitButlerWorkspaceStatus;
  readonly onOpenReview?: ((reviewNumber: number) => void) | undefined;
  readonly onOpenFile?: ((filePath: string) => void) | undefined;
}) {
  if (status.status === "missing") {
    return <StateMessage title="GitButler is not installed" detail={status.installHint} />;
  }
  if (status.status === "incompatible") {
    return <StateMessage title="GitButler needs an update" detail={status.detail} tone="warning" />;
  }
  if (status.status === "notConfigured") {
    return <StateMessage title="Workspace not configured" detail={status.detail} />;
  }
  if (status.status === "error") {
    return (
      <StateMessage title="GitButler status unavailable" detail={status.detail} tone="warning" />
    );
  }

  const isEmpty =
    status.stacks.length === 0 &&
    status.unassignedChanges.length === 0 &&
    status.conflictedFiles.length === 0;
  const lastFetched = status.upstreamLastFetched
    ? formatRelativeTimeLabel(status.upstreamLastFetched) || "unknown"
    : "not fetched yet";
  const visibleConflicts = status.conflictedFiles.slice(0, GITBUTLER_RENDER_LIMITS.conflictedFiles);
  const visibleStacks = status.stacks.slice(0, GITBUTLER_RENDER_LIMITS.stacks);

  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          <Badge variant={status.upstreamBehind > 0 ? "warning" : "success"} size="sm">
            {status.upstreamBehind > 0
              ? `${status.upstreamBehind} behind upstream`
              : "Up to date with upstream"}
          </Badge>
          <span>Fetched {lastFetched}</span>
          <span>Base {shortCommitId(status.mergeBaseCommitId)}</span>
        </div>

        {isEmpty ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">No GitButler branches or changes</p>
            <p className="mt-1 text-xs text-muted-foreground">This workspace is currently clean.</p>
          </div>
        ) : null}

        {status.unassignedChanges.length > 0 ? (
          <section className="space-y-2">
            <div>
              <h3 className="text-xs font-medium">Unassigned changes</h3>
              <p className="text-[10px] text-muted-foreground">Ownership is shown per file.</p>
            </div>
            <FileChanges changes={status.unassignedChanges} onOpenFile={onOpenFile} />
          </section>
        ) : null}

        {status.conflictedFiles.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-warning-foreground">Conflicted files</h3>
            <ul className="space-y-1" aria-label="GitButler conflicted files">
              {visibleConflicts.map((filePath) => (
                <li key={filePath}>
                  <button
                    type="button"
                    aria-label={`Open ${filePath}`}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md bg-warning/8 px-2 py-1.5 text-left text-xs outline-none hover:bg-warning/16 focus-visible:ring-2 focus-visible:ring-ring [contain-intrinsic-block-size:28px] [content-visibility:auto]"
                    onClick={() => onOpenFile?.(filePath)}
                    disabled={!onOpenFile}
                  >
                    <TriangleAlert
                      className="size-3.5 shrink-0 text-warning-foreground"
                      aria-hidden
                    />
                    <code className="min-w-0 flex-1 truncate text-[11px]">{filePath}</code>
                  </button>
                </li>
              ))}
            </ul>
            {status.conflictedFiles.length > visibleConflicts.length ? (
              <p className="text-[10px] text-muted-foreground">
                {status.conflictedFiles.length - visibleConflicts.length} more conflicts not shown.
              </p>
            ) : null}
          </section>
        ) : null}

        {visibleStacks.map((stack, stackIndex) => (
          <GitButlerStackSection
            key={
              stack.branches.length > 0
                ? JSON.stringify(stack.branches.map((branch) => branch.name))
                : stack.id
            }
            stack={stack}
            stackIndex={stackIndex}
            onOpenReview={onOpenReview}
            onOpenFile={onOpenFile}
          />
        ))}
        {status.stacks.length > visibleStacks.length ? (
          <p className="text-[10px] text-muted-foreground">
            {status.stacks.length - visibleStacks.length} more stacks not shown.
          </p>
        ) : null}
      </div>
    </ScrollArea>
  );
}
