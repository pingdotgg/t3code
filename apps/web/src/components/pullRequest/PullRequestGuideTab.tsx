import type { EnvironmentId, PullRequestRef, PullRequestReviewGuideStop } from "@t3tools/contracts";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

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

export function PullRequestGuideTab({
  environmentId,
  reference,
  title,
  workspaceRoot,
  active,
  canComment,
  rangeComments,
  onAskAboutLines,
  onAskAboutStop,
  onFinishReview,
  onOpenFile,
  onTourShown,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  title: string | null;
  workspaceRoot: string;
  active: boolean;
  canComment: boolean;
  rangeComments: boolean;
  onAskAboutLines: ((comment: ReviewCommentContext, request: string) => void) | null;
  onAskAboutStop:
    | ((stop: PullRequestReviewGuideStop, index: number, question: string) => void)
    | null;
  onFinishReview: (() => void) | null;
  onOpenFile: (path: string) => void;
  onTourShown?: (() => void) | undefined;
}) {
  const { query, data, running, canWrite, write } = useReviewGuideWriter({
    environmentId,
    reference,
    title,
  });
  const runKey = guideRunKey(environmentId, reference);
  const reviewKey = pullRequestReviewKey(reference);
  const pending = usePendingReviewComments(reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
  const commenting: ExcerptCommenting | null =
    !canComment && onAskAboutLines === null
      ? null
      : {
          canComment,
          rangeComments,
          pending,
          onComment: ({ path, oldPath, position, startPosition, body }) =>
            addComment(reviewKey, {
              id: nextPendingReviewCommentId(),
              path,
              ...(oldPath === null ? {} : { oldPath }),
              ...(startPosition === undefined ? {} : { startPosition }),
              position,
              body,
            }),
          onRemove: (commentId) => removeComment(reviewKey, commentId),
          onAskAgent: onAskAboutLines,
        };
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
