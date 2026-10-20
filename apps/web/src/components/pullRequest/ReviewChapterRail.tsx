import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ContextMenuItem } from "@t3tools/contracts";

import { readLocalApi } from "~/localApi";

import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestDiffStat } from "./pullRequestPresentation";

interface ReviewChapter {
  title: string;
  detail: ReactNode;
  reviewed: boolean;
  stat?: { additions: number; deletions: number } | null;
  selectedContent?: ReactNode;
  review?: {
    reviewedCount: number;
    fileCount: number;
    disabled?: boolean;
    onSetReviewed: (reviewed: boolean) => void;
  };
}

function showChapterReviewMenu(chapter: ReviewChapter, position: { x: number; y: number }) {
  const review = chapter.review;
  if (!review || review.disabled || review.fileCount === 0) return;
  const items: ContextMenuItem<"viewed" | "unviewed">[] = [];
  if (review.reviewedCount < review.fileCount)
    items.push({ id: "viewed", label: "Mark all as viewed" });
  if (review.reviewedCount > 0) items.push({ id: "unviewed", label: "Mark all as unviewed" });
  void readLocalApi()
    ?.contextMenu.show(items, position)
    .then((action) => {
      if (action !== null) review.onSetReviewed(action === "viewed");
    });
}

/** Shared table of contents for generated Guide chapters and file-type Code chapters. */
export function ReviewChapterRail({
  chapters,
  position,
  onSelect,
  ariaLabel,
}: {
  chapters: ReadonlyArray<ReviewChapter>;
  position: number;
  onSelect: (position: number) => void;
  ariaLabel: string;
}) {
  return (
    <nav aria-label={ariaLabel} className="flex min-h-0 flex-col gap-4">
      <p className="text-xs text-muted-foreground tabular-nums @max-[56rem]/guide:hidden">
        {chapters.filter((chapter) => chapter.reviewed).length} of {chapters.length} chapters
        reviewed
      </p>
      <ol className="flex flex-col gap-0.5">
        {chapters.map((chapter, index) => (
          <li
            key={index}
            onContextMenu={(event) => {
              const review = chapter.review;
              if (!review || review.disabled || review.fileCount === 0) return;
              event.preventDefault();
              showChapterReviewMenu(chapter, { x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              const review = chapter.review;
              if (!review || review.disabled || review.fileCount === 0) return;
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              showChapterReviewMenu(chapter, { x: bounds.left, y: bounds.bottom });
            }}
            className={cn(position === index && "rounded-md bg-accent/35 text-foreground")}
          >
            <button
              type="button"
              aria-current={position === index ? "step" : undefined}
              onClick={() => onSelect(index)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                position === index ? "text-foreground" : "hover:bg-accent/20",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs tabular-nums",
                  chapter.reviewed
                    ? "border-success/40 text-success-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                {chapter.reviewed ? (
                  <CheckIcon aria-label={`Chapter ${index + 1}, reviewed`} className="size-3" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-start justify-between gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm text-foreground",
                      position === index && chapter.selectedContent ? "break-words" : "truncate",
                    )}
                  >
                    {chapter.title}
                  </span>
                  {chapter.stat ? (
                    <PullRequestDiffStat
                      additions={chapter.stat.additions}
                      deletions={chapter.stat.deletions}
                      className="shrink-0 pt-0.5 font-mono text-2xs"
                    />
                  ) : null}
                </span>
                {chapter.detail !== null ? (
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {chapter.detail}
                  </span>
                ) : null}
              </span>
            </button>
            {position === index ? chapter.selectedContent : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A file shortcut inside the selected chapter, revealing its existing diff in place. */
export function ReviewChapterFileLink({
  path,
  stat,
  onSelect,
}: {
  path: string;
  stat: { additions: number; deletions: number } | null;
  onSelect: () => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Show ${path}`}
            onClick={onSelect}
            className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-xs outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <PierreEntryIcon pathValue={path} kind="file" theme={resolvedTheme} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{path.split("/").at(-1)}</span>
        {stat !== null ? (
          <PullRequestDiffStat
            additions={stat.additions}
            deletions={stat.deletions}
            className="shrink-0 font-mono text-2xs"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="right">{path}</TooltipPopup>
    </Tooltip>
  );
}
