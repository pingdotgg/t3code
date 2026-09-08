import type {
  GitButlerBranch,
  GitButlerCommit,
  GitButlerFileChange,
  GitButlerStack,
} from "@t3tools/contracts";
import { ChevronRight, GitBranch, GitCommitHorizontal } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

export const GITBUTLER_RENDER_LIMITS = {
  stacks: 10,
  branchesPerStack: 10,
  commitsPerBranch: 20,
  filesPerGroup: 50,
  conflictedFiles: 100,
} as const;

export const shortCommitId = (commitId: string) => commitId.slice(0, 8);

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_]/g, " ")
    .replace(/^./, (first) => first.toUpperCase());
}

function HiddenCount({ count, noun }: { readonly count: number; readonly noun: string }) {
  return count > 0 ? (
    <p className="text-[10px] text-muted-foreground">
      {`${count} more ${noun}${count === 1 ? "" : "s"} not shown.`}
    </p>
  ) : null;
}

export function FileChanges({
  changes,
  emptyLabel,
  onOpenFile,
}: {
  readonly changes: ReadonlyArray<GitButlerFileChange>;
  readonly emptyLabel?: string;
  readonly onOpenFile?: ((filePath: string) => void) | undefined;
}) {
  if (changes.length === 0) {
    return emptyLabel ? <p className="text-xs text-muted-foreground">{emptyLabel}</p> : null;
  }
  const visibleChanges = changes.slice(0, GITBUTLER_RENDER_LIMITS.filesPerGroup);
  return (
    <div className="space-y-1">
      <ul className="space-y-1" aria-label="GitButler file ownership">
        {visibleChanges.map((change) => (
          <li key={`${change.filePath}:${change.changeType}`}>
            <button
              type="button"
              aria-label={`Open ${change.filePath}`}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring [contain-intrinsic-block-size:28px] [content-visibility:auto]"
              onClick={() => onOpenFile?.(change.filePath)}
              disabled={!onOpenFile}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
              <code className="min-w-0 flex-1 truncate text-[11px]">{change.filePath}</code>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {humanize(change.changeType)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <HiddenCount count={changes.length - visibleChanges.length} noun="file" />
    </div>
  );
}

function CommitRow({ commit }: { readonly commit: GitButlerCommit }) {
  const relativeTime = formatRelativeTimeLabel(commit.createdAt);
  return (
    <li className="flex gap-2 py-2 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <GitCommitHorizontal
        className={cn(
          "mt-0.5 size-3.5 shrink-0 rotate-90",
          commit.conflicted && "text-warning-foreground",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">{commit.message}</span>
          {commit.conflicted ? (
            <Badge variant="warning" size="sm">
              Conflict
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
          <code>{shortCommitId(commit.commitId)}</code>
          <span>{commit.authorName}</span>
          {relativeTime ? <span>{relativeTime}</span> : null}
          {commit.reviewId ? <span>Review {commit.reviewId}</span> : null}
        </div>
      </div>
    </li>
  );
}

function reviewStatusPresentation(status: GitButlerBranch["reviewStatus"]): {
  readonly label: string;
  readonly variant: "success" | "error" | "warning" | "secondary";
} | null {
  switch (status) {
    case "passing":
      return { label: "CI passing", variant: "success" };
    case "failing":
      return { label: "CI failing", variant: "error" };
    case "pending":
      return { label: "CI pending", variant: "warning" };
    case "unknown":
      return { label: "CI unknown", variant: "secondary" };
    case null:
      return null;
  }
}

function BranchDetails({
  branch,
  onOpenReview,
}: {
  readonly branch: GitButlerBranch;
  readonly onOpenReview?: ((reviewNumber: number) => void) | undefined;
}) {
  const reviewStatus = reviewStatusPresentation(branch.reviewStatus);
  const reviewNumber = branch.reviewNumber;
  const visibleCommits = branch.commits.slice(0, GITBUTLER_RENDER_LIMITS.commitsPerBranch);
  return (
    <>
      {branch.reviewId || reviewStatus ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {branch.reviewId ? (
            reviewNumber && onOpenReview ? (
              <Button
                variant="link"
                size="micro"
                className="h-auto px-0 text-[10px] text-muted-foreground"
                onClick={() => onOpenReview(reviewNumber)}
              >
                Review {branch.reviewId}
              </Button>
            ) : (
              <span className="text-[10px] text-muted-foreground">Review {branch.reviewId}</span>
            )
          ) : null}
          {reviewStatus ? (
            <Badge variant={reviewStatus.variant} size="sm">
              {reviewStatus.label}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {branch.commits.length > 0 ? (
        <div className="mt-1">
          <ul className="divide-y divide-border/50" aria-label={`${branch.name} commits`}>
            {visibleCommits.map((commit) => (
              <CommitRow key={commit.commitId} commit={commit} />
            ))}
          </ul>
          <HiddenCount count={branch.commits.length - visibleCommits.length} noun="commit" />
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No local commits on this branch.</p>
      )}
      {branch.upstreamCommits.length > 0 ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {branch.upstreamCommits.length} upstream commit
          {branch.upstreamCommits.length === 1 ? "" : "s"}
        </p>
      ) : null}
    </>
  );
}

function BranchCard({
  branch,
  onOpenReview,
}: {
  readonly branch: GitButlerBranch;
  readonly onOpenReview?: ((reviewNumber: number) => void) | undefined;
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-card px-3 py-2.5 [contain-intrinsic-block-size:120px] [content-visibility:auto]">
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <h4 className="min-w-0 flex-1 truncate text-xs font-medium">{branch.name}</h4>
        <Badge variant="secondary" size="sm">
          {humanize(branch.branchStatus)}
        </Badge>
      </div>
      <div className="pl-[22px]">
        <BranchDetails branch={branch} onOpenReview={onOpenReview} />
      </div>
    </section>
  );
}

export function GitButlerStackSection({
  stack,
  stackIndex,
  onOpenReview,
  onOpenFile,
}: {
  readonly stack: GitButlerStack;
  readonly stackIndex: number;
  readonly onOpenReview?: ((reviewNumber: number) => void) | undefined;
  readonly onOpenFile?: ((filePath: string) => void) | undefined;
}) {
  const visibleBranches = stack.branches.slice(0, GITBUTLER_RENDER_LIMITS.branchesPerStack);
  const showsStackRail = visibleBranches.length > 1;
  const stackTitle = `Stack ${stackIndex + 1}`;
  return (
    <Collapsible defaultOpen>
      <section className="space-y-2">
        <CollapsibleTrigger
          className="group flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Toggle ${stackTitle}`}
        >
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <h3 className="min-w-0 flex-1 truncate text-xs font-medium">{stackTitle}</h3>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {stack.branches.length} branch{stack.branches.length === 1 ? "" : "es"}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-3">
            {stack.assignedChanges.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground">Assigned files</p>
                <FileChanges changes={stack.assignedChanges} onOpenFile={onOpenFile} />
              </div>
            ) : null}
            {visibleBranches.length > 0 ? (
              <div className="space-y-2">
                {visibleBranches.map((branch, branchIndex) => (
                  <div
                    key={branch.name}
                    className={cn(
                      showsStackRail &&
                        "relative pl-4 before:absolute before:top-[14px] before:left-0 before:size-1.5 before:rounded-full before:bg-muted-foreground",
                      showsStackRail &&
                        branchIndex < visibleBranches.length - 1 &&
                        "after:absolute after:top-[17px] after:-bottom-[25px] after:left-[3px] after:w-px after:bg-border/70",
                    )}
                  >
                    <BranchCard branch={branch} onOpenReview={onOpenReview} />
                  </div>
                ))}
                <HiddenCount count={stack.branches.length - visibleBranches.length} noun="branch" />
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
