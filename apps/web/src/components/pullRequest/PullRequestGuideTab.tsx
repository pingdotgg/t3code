import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewGuideStop,
} from "@t3tools/contracts";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";

import type { ReviewCommentContext } from "~/reviewCommentContext";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ExcerptCommenting } from "./guide/GuideExcerpt";
import { PullRequestAttachments } from "./PullRequestAttachments";
import { guideRunKey, useGuideRunStore } from "./guide/guideRunStore";
import { GuideProseContext } from "./guide/GuideProse";
import { GuideTour } from "./guide/GuideTour";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";
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
  detail,
  workspaceRoot,
  active,
  canComment,
  canCommentRanges = false,
  onAskAboutLines,
  onAskAboutStop,
  onFinishReview,
  onOpenFile,
  onTourShown,
  fallback,
  viewControlsTarget,
}: {
  /** The ordinary diff reader keeps the whole change available until the guide arrives. */
  fallback: (status: ReactNode) => ReactNode;
  viewControlsTarget: HTMLElement | null;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  title: string | null;
  detail: Pick<PullRequestDetailView, "capabilities" | "reviewThreads">;
  /** The checkout the guide's prose renders against, as the description does. */
  workspaceRoot: string;
  active: boolean;
  canComment: boolean;
  canCommentRanges?: boolean;
  /** Opens an agent thread about lines of the change. Null where no thread can be opened. */
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
  const pending = usePendingReviewComments(reference, detail.reviewThreads);
  const { add: addComment } = usePendingReviewCommentActions(environmentId, reference);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
  const commenting = ((): ExcerptCommenting | null =>
    !canComment && onAskAboutLines === null && !detail.capabilities.review.reply
      ? null
      : {
          canComment,
          canCommentRanges,
          renderAttachments: (onTextChange, onBusyChange, textarea) => (
            <PullRequestAttachments
              environmentId={environmentId}
              reference={reference}
              onTextChange={onTextChange}
              textareaRef={{ current: textarea }}
              onBusyChange={onBusyChange}
            />
          ),
          pending,
          threads: detail.reviewThreads.filter((thread) =>
            thread.comments.some((comment) => !comment.pendingReviewId),
          ),
          pendingCommentTarget: {
            environmentId,
            reference,
            canCopyLink: detail.capabilities.review.draftComment === true,
          },
          onComment: ({ path, oldPath, position, body }) =>
            addComment(
              {
                id: nextPendingReviewCommentId(),
                path,
                ...(oldPath === null ? {} : { oldPath }),
                position,
                body,
              },
              detail.capabilities.review.draftComment === true,
            ),
          onRemove: (commentId) => removeComment(reviewKey, commentId),
          onAskAgent: onAskAboutLines,
        })();
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
  const attemptedGuide = useRef<string | null>(null);
  useEffect(() => {
    if (
      !active ||
      data === null ||
      data === undefined ||
      guide !== null ||
      running ||
      !canWrite ||
      failure !== null ||
      attemptedGuide.current === runKey
    )
      return;
    attemptedGuide.current = runKey;
    void write();
  }, [active, data, guide, running, canWrite, failure, runKey, write]);
  const writeButton = (label: string, size: "sm" | "xs") =>
    canWrite ? (
      <Button size={size} variant="outline" disabled={running} onClick={() => void write()}>
        {running ? <Spinner /> : <SparklesIcon aria-hidden className="size-3.5" />}
        {running ? "Reading the change..." : label}
      </Button>
    ) : null;

  if (guide === null) {
    return fallback(
      <div className="mb-4 flex flex-col gap-2" aria-busy={running}>
        <style>{`
          @keyframes guide-status-glimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
          [data-guide-generating] { background: linear-gradient(100deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%); background-size: 200% 100%; background-clip: text; color: transparent; animation: guide-status-glimmer 2.4s ease-in-out infinite; animation-play-state: var(--visible-animation-state, paused); }
          @media (prefers-reduced-motion: reduce) { [data-guide-generating] { animation: none; } }
        `}</style>
        <h2
          ref={running && active ? observeVisibleAnimation : undefined}
          role="status"
          data-guide-generating={(running && active) || undefined}
          className="text-sm font-medium"
        >
          {failure ??
            query.error ??
            (running ? "Generating guide…" : query.isPending ? "Loading guide…" : "Review guide")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {running
            ? "Organizing this change into chapters. Review the files while you wait."
            : "Review the files while the guide is prepared."}
        </p>
        {!running && !query.isPending
          ? writeButton(failure === null ? "Write guide" : "Try again", "xs")
          : null}
      </div>,
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
        viewControlsTarget={viewControlsTarget}
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
