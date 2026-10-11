import type { EnvironmentId, PullRequestRef, PullRequestReviewGuideStop } from "@t3tools/contracts";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo } from "react";

import type { ReviewCommentContext } from "~/reviewCommentContext";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ExcerptCommenting } from "./guide/GuideExcerpt";
import { guideRunKey, useGuideRunStore } from "./guide/guideRunStore";
import { GuideProseContext } from "./guide/GuideProse";
import { GuideTour } from "./guide/GuideTour";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

/**
 * A maintainer's tour of the pull request: stops through the diff in reading order with the
 * calls only a person can make. Generated on request and stored, so opening the tab is free.
 * Rewriting a current guide lives in the header menu; the tab only asks when it has a reason.
 */
export function PullRequestGuideTab({
  environmentId,
  reference,
  title,
  workspaceRoot,
  active,
  canComment,
  onAskAboutLines,
  onAskAboutStop,
  onFinishReview,
  onOpenFile,
  onTourShown,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** The pull request's title for the notice when a guide is ready, null until the detail loads. */
  title: string | null;
  /** The checkout the guide's prose renders against, as the description does. */
  workspaceRoot: string;
  /** Whether this is the tab on screen. */
  active: boolean;
  /** Whether this reader may queue line comments for a review on this host. */
  canComment: boolean;
  /** Opens an agent thread about lines of the change. Null where no thread can be opened. */
  onAskAboutLines: ((comment: ReviewCommentContext, request: string) => void) | null;
  onAskAboutStop:
    | ((stop: PullRequestReviewGuideStop, index: number, question: string) => void)
    | null;
  /** Opens the review composer with the comments queued so far. Null where the reader cannot review. */
  onFinishReview: (() => void) | null;
  /** Shows a file in the Code tab. */
  onOpenFile: (path: string) => void;
  /** Told when a written guide comes on screen; a run in progress is not one. */
  onTourShown?: (() => void) | undefined;
}) {
  const { query, data, running, canWrite, write } = useReviewGuideWriter({
    environmentId,
    reference,
    title,
  });
  const runKey = guideRunKey(environmentId, reference);
  // Line comments join the review the Code tab collects, so either place shows and sends them.
  const reviewKey = pullRequestReviewKey(reference);
  const pending = usePendingReviewComments(reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
  const commenting = useMemo<ExcerptCommenting | null>(
    () =>
      !canComment && onAskAboutLines === null
        ? null
        : {
            canComment,
            pending,
            onComment: ({ path, oldPath, position, body }) =>
              addComment(reviewKey, {
                id: nextPendingReviewCommentId(),
                path,
                ...(oldPath === null ? {} : { oldPath }),
                position,
                body,
              }),
            onRemove: (commentId) => removeComment(reviewKey, commentId),
            onAskAgent: onAskAboutLines,
          },
    [addComment, canComment, onAskAboutLines, pending, removeComment, reviewKey],
  );
  useEffect(() => {
    if (!active) return;
    useGuideRunStore.getState().setShown(runKey);
    return () => {
      if (useGuideRunStore.getState().shownKey === runKey)
        useGuideRunStore.getState().setShown(null);
    };
  }, [active, runKey]);

  const guide = data?.guide ?? null;
  const tourShown = active && guide !== null;
  const reportTourShown = useEffectEvent(() => onTourShown?.());
  useEffect(() => {
    if (tourShown) reportTourShown();
  }, [tourShown]);
  const runState = data?.run ?? null;
  const currentHeadSha = data?.currentHeadSha ?? null;
  const stale = guide !== null && currentHeadSha !== null && currentHeadSha !== guide.headSha;
  // A failure is shown only while it is about the head the reader is looking at.
  const failure =
    runState?._tag === "Failed" && runState.headSha === currentHeadSha ? runState.detail : null;
  const writeButton = (label: string, size: "sm" | "xs") =>
    canWrite ? (
      <Button size={size} variant="outline" disabled={running} onClick={() => void write()}>
        {running ? <Spinner /> : <SparklesIcon aria-hidden className="size-3.5" />}
        {running ? "Reading the change..." : label}
      </Button>
    ) : null;

  if (guide === null) {
    if (query.isPending && data === null) {
      return (
        <div className="flex min-h-48 items-center justify-center">
          <Spinner />
        </div>
      );
    }
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {running ? "Writing a review guide" : "No review guide yet"}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {failure ??
            query.error ??
            (running
              ? "An agent is reading the change. A large one takes a few minutes. You can leave; you will be told when it is ready."
              : "A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make.")}
        </p>
        {writeButton(failure === null ? "Write guide" : "Try again", "sm")}
      </div>
    );
  }

  // Only a guide that needs attention says so; a current one is just the tour.
  const banner =
    stale || failure !== null || running ? (
      <Alert variant={running ? "info" : "warning"}>
        {running ? <Spinner /> : <TriangleAlertIcon />}
        <AlertDescription>
          {running
            ? "Rewriting this guide. You will be told when the new one is ready."
            : (failure ?? "Written before the latest push.")}
        </AlertDescription>
        {!running && canWrite ? <AlertAction>{writeButton("Rewrite", "xs")}</AlertAction> : null}
      </Alert>
    ) : null;

  return (
    <GuideProseContext value={{ environmentId, cwd: workspaceRoot }}>
      <GuideTour
        environmentId={environmentId}
        reference={reference}
        guide={guide}
        banner={banner}
        active={active}
        commenting={commenting}
        onAsk={
          onAskAboutStop === null
            ? null
            : (index, question) => {
                const stop = guide.stops[index];
                if (stop !== undefined) onAskAboutStop(stop, index, question);
              }
        }
        onFinish={onFinishReview}
        onOpenFile={onOpenFile}
      />
    </GuideProseContext>
  );
}
