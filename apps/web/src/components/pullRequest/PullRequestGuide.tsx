import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestDetailView } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon, BookOpenIcon } from "lucide-react";
import { useState } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";

import { Button } from "../ui/button";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { describeReviewFile } from "./pullRequestDiff.logic";

export function PullRequestGuide({
  file,
  detail,
  environmentId,
  index,
  count,
  hasMore,
  loading,
  actionPending,
  viewed,
  onSetViewed,
  onPrevious,
  onNext,
  onExplain,
  onSelectHunk,
}: {
  file: FileDiffMetadata;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  index: number;
  count: number;
  hasMore: boolean;
  loading: boolean;
  actionPending: boolean;
  viewed?: boolean;
  onSetViewed?: (viewed: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onExplain?: () => void;
  onSelectHunk: (index: number) => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const path = resolveFileDiffPath(file);
  const discussions = detail.reviewThreads.filter(
    (thread) => thread.path === path && !thread.isResolved,
  ).length;
  return (
    <aside
      aria-label="Review guide"
      className="max-h-64 w-full shrink-0 overflow-y-auto border-b border-border/60 p-4 @min-[48rem]/review-code:max-h-none @min-[48rem]/review-code:w-72 @min-[48rem]/review-code:border-b-0 @min-[48rem]/review-code:border-r"
    >
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-4 flex items-center justify-between gap-2 border-b border-border/60 bg-background px-4 py-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {index + 1} / {count}
          {hasMore ? "+" : ""} files
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous review file"
            disabled={index === 0}
            onClick={onPrevious}
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={
              index + 1 === count && hasMore ? "Load more review files" : "Next review file"
            }
            disabled={index + 1 === count && (!hasMore || loading)}
            onClick={onNext}
          >
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      {onSetViewed ? (
        <Button
          className="mb-3"
          size="xs"
          variant="outline"
          disabled={actionPending || loading}
          onClick={() => onSetViewed(!viewed)}
        >
          {viewed
            ? "Mark as not viewed"
            : index + 1 < count
              ? "Mark viewed & next"
              : "Mark as viewed"}
        </Button>
      ) : null}
      <h2 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{path}</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {describeReviewFile(file)}
      </p>
      {discussions > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {discussions} open {discussions === 1 ? "conversation" : "conversations"}
        </p>
      ) : null}
      {file.hunks.length > 0 ? (
        <nav aria-label="Changed sections" className="mt-4 flex flex-col gap-1">
          {file.hunks.map((hunk, hunkIndex) => (
            <Button
              variant="ghost"
              size="sm-multiline"
              key={`${hunk.deletionStart}:${hunk.additionStart}`}
              type="button"
              onClick={() => onSelectHunk(hunkIndex)}
              className="flex-col items-start gap-0 text-left"
            >
              <span className="block break-words font-mono [overflow-wrap:anywhere]">
                {hunk.hunkContext?.trim() || `Changed section ${hunkIndex + 1}`}
              </span>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                {hunk.additionCount === 0
                  ? `Previous line ${hunk.deletionStart}`
                  : `Line ${hunk.additionStart}`}
              </span>
            </Button>
          ))}
        </nav>
      ) : null}
      {onExplain ? (
        <Button
          className="mt-4"
          variant="outline"
          size="xs"
          onClick={onExplain}
          disabled={actionPending}
        >
          <BookOpenIcon className="size-3" />
          Explain this file
        </Button>
      ) : null}
      {detail.body.trim() ? (
        <details
          className="mt-5 border-t border-border/60 pt-3"
          onToggle={(event) => setContextOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs font-medium">Pull request context</summary>
          {contextOpen ? (
            <PullRequestMarkdown
              className="mt-3 text-xs"
              text={detail.body}
              cwd={detail.workspaceRoot}
              environmentId={environmentId}
            />
          ) : null}
        </details>
      ) : null}
    </aside>
  );
}
