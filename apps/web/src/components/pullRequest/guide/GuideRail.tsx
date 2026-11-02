import type { FileDiffMetadata } from "@pierre/diffs";

import { getDiffLineStat } from "~/lib/diffRendering";

import { EyeIcon } from "lucide-react";
import type {
  PullRequestReviewGuideAttention,
  PullRequestReviewGuideStop,
} from "@t3tools/contracts";
import {
  stopFilePaths,
  reviewGuideStopProgress,
  stopSubline,
  letterStopNotes,
} from "@t3tools/client-runtime/review-guide-tour";

import { Badge } from "../../ui/badge";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { GuideNotes } from "./GuideNotes";
import { GuideProse } from "./GuideProse";
import { ReviewChapterProgress } from "../ReviewChapterHeader";
import { ReviewChapterRail, ReviewChapterFileLink } from "../ReviewChapterRail";

const ATTENTION_LABELS = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
} as const satisfies Record<PullRequestReviewGuideAttention["kind"], string>;

/** The Guide table of contents uses the same chapter navigation as grouped Code review. */
export function GuideRail({
  stops,
  position,
  seen,
  onSelect,
  isViewed,
  onSetViewed,
  files,
  onSelectFile,
}: {
  files: ReadonlyMap<string, FileDiffMetadata>;
  onSelectFile: (path: string) => void;
  stops: ReadonlyArray<PullRequestReviewGuideStop>;
  position: number;
  seen: ReadonlySet<number>;
  onSelect: (position: number) => void;
  isViewed: (path: string) => boolean;
  onSetViewed: ((paths: ReadonlyArray<string>, viewed: boolean) => void) | null;
}) {
  return (
    <ReviewChapterRail
      ariaLabel="Review tour"
      chapters={stops.map((stop, index) => {
        const paths = stopFilePaths(stop);
        const progress = reviewGuideStopProgress(stop, isViewed);
        const stat =
          paths.length > 0 && paths.every((path) => files.has(path))
            ? getDiffLineStat(
                paths.flatMap((path) => {
                  const file = files.get(path);
                  return file ? [file] : [];
                }),
              )
            : null;
        return {
          stat,
          title: stop.title,
          reviewed: seen.has(index),
          ...(onSetViewed
            ? {
                review: {
                  reviewedCount: progress.reviewedCount,
                  fileCount: paths.length,
                  onSetReviewed: (value: boolean) => onSetViewed(paths, value),
                },
              }
            : {}),
          selectedContent:
            index === position ? (
              <div className="flex min-w-0 flex-col gap-4 px-2 pb-3">
                {onSetViewed && paths.length > 0 ? (
                  <ReviewChapterProgress
                    reviewedCount={progress.reviewedCount}
                    fileCount={paths.length}
                    onSetReviewed={(value) => onSetViewed(paths, value)}
                  />
                ) : null}
                {stop.summary.trim() !== "" ? (
                  <div className="text-sm text-muted-foreground">
                    <GuideProse text={stop.summary} />
                  </div>
                ) : null}
                {stop.attention !== null ? (
                  <Alert controlAlignment="first-line">
                    <EyeIcon />
                    <AlertTitle>{ATTENTION_LABELS[stop.attention.kind]}</AlertTitle>
                    <AlertDescription>
                      <GuideProse text={stop.attention.note} />
                    </AlertDescription>
                  </Alert>
                ) : null}
                <GuideNotes notes={letterStopNotes(stop).lettered} />
                <ul className="flex min-w-0 flex-col gap-0.5">
                  {paths.map((path) => {
                    const file = files.get(path);
                    const stat = file === undefined ? null : getDiffLineStat([file]);
                    return (
                      <li key={path}>
                        <ReviewChapterFileLink
                          path={path}
                          stat={stat}
                          onSelect={() => onSelectFile(path)}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null,
          detail: (
            <>
              {stop.attention !== null ? (
                <Badge size="sm" variant="warning">
                  Look closely
                </Badge>
              ) : null}
              {onSetViewed && paths.length > 0 ? (
                index !== position ? (
                  <span>
                    {progress.reviewedCount} of {paths.length} files reviewed
                  </span>
                ) : null
              ) : (
                <span>{stopSubline(stop)}</span>
              )}
            </>
          ),
        };
      })}
      position={position}
      onSelect={onSelect}
    />
  );
}
