import type { EnvironmentId, PullRequestRef, PullRequestReviewGuideStop } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { ScrollTextIcon, TriangleAlertIcon } from "lucide-react";
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
  const gt = useGT();
  const resolve = useMessages();
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
        {running ? <Spinner /> : <ScrollTextIcon aria-hidden className="size-3.5" />}
        {running ? gt("Reading the change...") : label}
      </Button>
    ) : null;
  const refreshError =
    query.error === null ? null : (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertDescription>{query.error}</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" disabled={query.isPending} onClick={query.refresh}>
            {gt("Try again")}
          </Button>
        </AlertAction>
      </Alert>
    );

  if (guide === null) {
    if (query.isPending && data === null && refreshError === null) {
      return (
        <div
          tabIndex={-1}
          data-workspace-focus-default
          className="flex min-h-48 items-center justify-center outline-none"
        >
          <Spinner />
        </div>
      );
    }
    return (
      <div
        tabIndex={-1}
        data-workspace-focus-default
        className="scrollbar-gutter-both flex h-full flex-col items-center justify-center-safe gap-2 overflow-y-auto px-4 py-10 text-center outline-none"
      >
        {refreshError ?? (
          <>
            <p className="text-sm font-medium text-foreground">
              {running
                ? gt("Writing a review guide")
                : failure === null
                  ? gt("No review guide yet")
                  : gt("Could not write a review guide")}
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              {running
                ? gt(
                    "An agent is reading the change. A large one takes a few minutes. You can leave; you will be told when it is ready.",
                  )
                : failure === null
                  ? gt(
                      "A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make.",
                    )
                  : resolve(FAILURE_HINT)}
            </p>
            {writeButton(failure === null ? gt("Write guide") : gt("Try again"), "sm")}
            {failure === null || running ? null : <FailureDetails detail={failure} />}
          </>
        )}
      </div>
    );
  }

  const banner =
    refreshError ??
    (stale || failure !== null || running ? (
      <Alert variant={running ? "info" : "warning"}>
        {running ? <Spinner /> : <TriangleAlertIcon />}
        <AlertDescription>
          {running ? (
            gt("Rewriting this guide. You will be told when the new one is ready.")
          ) : failure === null ? (
            gt("Written before the latest push.")
          ) : (
            <>
              {gt(
                "Could not rewrite this guide. Check the review guide model in Settings → Source control.",
              )}
              <FailureDetails detail={failure} />
            </>
          )}
        </AlertDescription>
        {!running && canWrite ? (
          <AlertAction>{writeButton(gt("Rewrite"), "xs")}</AlertAction>
        ) : null}
      </Alert>
    ) : null);

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

const FAILURE_HINT = msg("Check the review guide model in Settings → Source control & issues.");

function FailureDetails({ detail }: { detail: string }) {
  return (
    <details className="w-full max-w-lg text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded-sm -outline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <T>Technical details</T>
      </summary>
      <pre className="scrollbar-gutter-both mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left font-mono text-xs">
        {detail}
      </pre>
    </details>
  );
}
