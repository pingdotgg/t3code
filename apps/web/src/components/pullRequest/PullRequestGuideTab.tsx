import type { EnvironmentId, PullRequestRef, PullRequestReviewGuideStop } from "@t3tools/contracts";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import type { ReviewCommentContext } from "~/reviewCommentContext";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ExcerptCommenting } from "./guide/GuideExcerpt";
import { GuideProseContext } from "./guide/GuideProse";
import { GuideTour } from "./guide/GuideTour";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import type { PullRequestCompletionScope } from "./PullRequestMarkdownTextarea";

import { translateNow } from "~/components/media/translateNow";
export function PullRequestGuideTab({
  environmentId,
  reference,
  title,
  workspaceRoot,
  active,
  canComment,
  rangeComments,
  completionScope,
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
  completionScope: PullRequestCompletionScope | null;
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
          completionScope,
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
  const guide = data?.guide ?? null;
  const tourShown = active && guide !== null;
  const reportTourShown = useEffectEvent(() => onTourShown?.());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the parent once the loaded guide tour is on screen, which data arrival can cause
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
        {running ? translateNow("review.extra.reading.the.change") : label}
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
      <div className="scrollbar-gutter-both flex h-full flex-col items-center justify-center-safe gap-2 overflow-y-auto px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {running
            ? translateNow("review.extra.writing.a.review.guide")
            : failure === null
              ? translateNow("review.extra.no.review.guide.yet")
              : translateNow("review.extra.could.not.write.a.review.guide")}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {running
            ? translateNow("review.extra.an.agent.is.reading.the.change.a.large")
            : failure === null
              ? (query.error ?? translateNow("review.extra.a.guide.is.a.tour.of.the.change"))
              : FAILURE_HINT()}
        </p>
        {writeButton(
          failure === null
            ? translateNow("review.extra.write.guide")
            : translateNow("review.extra.try.again"),
          "sm",
        )}
        {failure === null || running ? null : <FailureDetails detail={failure} />}
      </div>
    );
  }

  const banner =
    stale || failure !== null || running ? (
      <Alert variant={running ? "info" : "warning"}>
        {running ? <Spinner /> : <TriangleAlertIcon />}
        <AlertDescription>
          {running ? (
            translateNow("review.extra.rewriting.this.guide.you.will.be.told.when")
          ) : failure === null ? (
            translateNow("review.extra.written.before.the.latest.push")
          ) : (
            <>
              {translateNow("review.pr.couldNotRewriteGuide", { hint: FAILURE_HINT() })}
              <FailureDetails detail={failure} />
            </>
          )}
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

const FAILURE_HINT = () =>
  translateNow("review.extra.check.the.review.guide.model.in.settings.source");

function FailureDetails({ detail }: { detail: string }) {
  return (
    <details className="w-full max-w-lg text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded-sm -outline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {translateNow("review.extra.technical.details")}
      </summary>
      <pre className="scrollbar-gutter-both mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left font-mono text-xs">
        {detail}
      </pre>
    </details>
  );
}
