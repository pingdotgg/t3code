import type {
  CollaborativeAcceptanceStatus,
  EnvironmentId,
  PullRequestAction,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestListEntry,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestReviewVerdict,
  PullRequestMonitorStatusResult,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  pullRequestActivityQueryOptions,
  collaborativeAcceptanceLookupQueryOptions,
  collaborativeAcceptancePauseMutationOptions,
  collaborativeAcceptanceRequestReviewMutationOptions,
  collaborativeAcceptanceResumeMutationOptions,
  collaborativeAcceptanceStatusQueryOptions,
  pullRequestCommentMutationOptions,
  pullRequestDiffInfiniteQueryOptions,
  pullRequestDetailQueryOptions,
  pullRequestInvalidateMutationOptions,
  pullRequestMonitorStatusQueryOptions,
  pullRequestMonitorContextQueryOptions,
  pullRequestReplyToThreadMutationOptions,
  pullRequestRunActionMutationOptions,
  pullRequestSetThreadResolutionMutationOptions,
  pullRequestSubmitReviewMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { isRateLimitQueryError } from "~/lib/rateLimitQuery";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useOpenLink } from "~/browser/useOpenLink";
import { isWebUrl } from "~/browser/browserLinkTarget";
import { selectThreadShellsAcrossEnvironments, useStore } from "~/store";
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  findPullRequestBrowserThread,
  findPullRequestCreationThread,
} from "~/lib/openPullRequestLink";
import { presentCollaborativeAcceptanceStatus } from "./collaborativeAcceptancePresentation";
import type { ThreadShell } from "~/types";
import { PullRequestBody } from "./PullRequestBody";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestMediaDialog, type PullRequestMediaPreview } from "./PullRequestMediaDialog";

import {
  EMPTY_PENDING_REVIEW_COMMENTS,
  pullRequestReviewKey,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestStateGlyph,
  pullRequestActionLabel,
  pullRequestCheckSummaryLabel,
  pullRequestReviewVerdictPresentation,
  pullRequestStatePresentation,
  resolvePullRequestMergeSelection,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

type DetailTab = "summary" | "timeline" | "code";
type PullRequestDetailView = PullRequestDetail & PullRequestActivity;

const TABS: readonly { readonly value: DetailTab; readonly label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

const LazyPullRequestCodeTab = lazy(() =>
  import("./PullRequestCodeTab").then(({ PullRequestCodeTab }) => ({
    default: PullRequestCodeTab,
  })),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

/**
 * The verdict a submitted review carries. Delegates wording and tone to the
 * shared presentation helper so every surface reads a verdict the same way.
 */
function ReviewVerdictBadge({ reviewState }: { readonly reviewState: string | null }) {
  const presentation = pullRequestReviewVerdictPresentation(reviewState);
  if (presentation.variant === null) {
    return (
      <span className="rounded bg-accent px-1 py-px font-medium text-foreground">
        {presentation.label}
      </span>
    );
  }

  return (
    <Badge size="sm" variant={presentation.variant}>
      {presentation.label}
    </Badge>
  );
}

function isAvailableAction(detail: PullRequestDetailView, action: PullRequestAction): boolean {
  if (
    !detail.capabilities.actions.includes(action) ||
    !detail.viewerPermissions.actions.includes(action)
  ) {
    return false;
  }

  switch (action) {
    case "merge":
      return (
        detail.state === "open" &&
        !detail.isDraft &&
        detail.capabilities.mergeMethods.some((method) => detail.mergeCapabilities[method])
      );
    case "ready":
      return detail.state === "open" && detail.isDraft;
    case "draft":
      return detail.state === "open" && !detail.isDraft;
    case "close":
      return detail.state === "open";
    case "reopen":
      return detail.state === "closed";
  }
}

function toDetailView(
  detail: PullRequestDetail | undefined,
  activity: PullRequestActivity | undefined,
): PullRequestDetailView | null {
  if (!detail) return null;
  return {
    ...detail,
    ...(activity ?? {
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    }),
    author: activity?.author ?? detail.author,
    reviewers: activity?.reviewers ?? detail.reviewers,
  };
}

function PullRequestCollaborationStatusCard({
  status,
  acceptance,
  controls,
  environmentId,
  creatorThread,
  creatorThreadLabel,
  reviewThread,
  onNavigateThread,
}: {
  readonly status: PullRequestMonitorStatusResult | undefined;
  readonly acceptance: CollaborativeAcceptanceStatus | undefined;
  readonly environmentId: EnvironmentId;
  readonly creatorThread: Pick<ThreadShell, "id" | "title"> | null;
  readonly creatorThreadLabel: "Created in" | "Linked from";
  readonly reviewThread: Pick<ThreadShell, "id" | "title"> | null;
  readonly onNavigateThread: () => void;
  readonly controls: {
    readonly canControl: boolean;
    readonly isLoading: boolean;
    readonly error: string | null;
    readonly isPaused: boolean;
    readonly isPending: boolean;
    readonly onPause: () => void;
    readonly onResume: () => void;
    readonly onRequestReview: () => void;
  };
}) {
  const presentation = presentCollaborativeAcceptanceStatus({ monitor: status, acceptance });
  const record = acceptance?.record;
  const candidateHead =
    record?.projection.headSha ??
    record?.case.currentCandidate.headSha ??
    status?.latestSnapshot?.headSha ??
    status?.monitor?.headSha;
  const blockers = status?.monitor?.readiness?.blockers ?? [];
  const currentEvidence = record?.evidence.filter((evidence) => evidence.current) ?? [];
  const completeEvidence = currentEvidence.filter((evidence) => evidence.complete).length;
  const openObligations =
    record?.obligations?.filter((obligation) => obligation.status === "open").length ?? 0;
  const exchangeBudget = record?.case.policy.budgets.exchanges;
  const exchangeCount = record?.exchanges.filter(
    (exchange) => exchange.status !== "cancelled",
  ).length;
  const openFindingCount = status?.openFeedback.length ?? 0;
  const additionalBlockers = blockers.filter(
    (blocker) => (blocker.detail ?? blocker.kind) !== presentation.blocker,
  );
  const threadLinks = [
    creatorThread ? { label: creatorThreadLabel, thread: creatorThread } : null,
    reviewThread ? { label: "Review findings from", thread: reviewThread } : null,
  ].filter(
    (
      entry,
    ): entry is {
      readonly label: string;
      readonly thread: Pick<ThreadShell, "id" | "title">;
    } => entry !== null,
  );

  return (
    <details
      className="group rounded-xl border border-border/70 bg-card/60"
      aria-label="Pull request collaboration status"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <span className="min-w-0 flex-1">
          <h2 className="text-xs font-medium text-muted-foreground">Collaboration</h2>
          <span
            aria-live="polite"
            className="block truncate text-sm font-semibold"
            title={presentation.headline}
          >
            {presentation.headline}
          </span>
        </span>
        {openFindingCount > 0 ? (
          <Badge className="shrink-0" variant="secondary">
            {openFindingCount} finding{openFindingCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="border-t border-border/70 px-3 py-3">
        {presentation.blocker ? (
          <p className="text-xs text-muted-foreground">{presentation.blocker}</p>
        ) : null}
        {threadLinks.length > 0 ? (
          <dl className="mt-3 grid gap-2 text-xs">
            {threadLinks.map(({ label, thread }) => (
              <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-2" key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0">
                  <Link
                    className="block truncate font-medium text-foreground underline-offset-2 hover:underline"
                    params={{ environmentId, threadId: thread.id }}
                    title={thread.title}
                    to="/$environmentId/$threadId"
                    onClick={(event) => {
                      if (
                        event.button === 0 &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey &&
                        !event.altKey
                      ) {
                        onNavigateThread();
                      }
                    }}
                  >
                    {thread.title}
                  </Link>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {(
            [
              ["Automation", presentation.execution],
              ["Review exchange", presentation.collaboration],
              ["Acceptance", presentation.acceptance],
              ["Merge readiness", presentation.readiness],
            ] as const
          ).map(([label, value]) => (
            <div className="min-w-0" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate font-medium" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {additionalBlockers.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {additionalBlockers.slice(0, 3).map((blocker) => (
              <li className="break-words" key={`${blocker.kind}-${blocker.detail ?? ""}`}>
                {blocker.detail ?? blocker.kind}
              </li>
            ))}
          </ul>
        ) : null}
        {record ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Evidence {completeEvidence}/{currentEvidence.length} complete · {openObligations} open
            obligation{openObligations === 1 ? "" : "s"} · {exchangeCount}/{exchangeBudget}{" "}
            exchanges
          </p>
        ) : null}
        {!controls.canControl && (controls.isLoading || controls.error) ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {controls.isLoading
              ? "Loading acceptance details…"
              : `Acceptance details unavailable: ${controls.error}`}
          </p>
        ) : null}
        {candidateHead ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Revision{" "}
            <code className="font-mono" title={candidateHead} translate="no">
              {candidateHead.slice(0, 12)}
            </code>
          </p>
        ) : null}
        {controls.canControl ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={controls.isPending}
              size="xs"
              variant="outline"
              onClick={controls.isPaused ? controls.onResume : controls.onPause}
            >
              {controls.isPaused ? "Resume Automation" : "Pause Automation"}
            </Button>
            <Button
              disabled={controls.isPending}
              size="xs"
              variant="outline"
              onClick={controls.onRequestReview}
            >
              Request Review
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function CommentComposer({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium">Comment</h2>
      <Textarea
        className="mt-2"
        placeholder="Leave a comment"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && value.trim()) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="mt-2 flex justify-end">
        <Button disabled={disabled || !value.trim()} size="xs" onClick={onSubmit}>
          Comment
        </Button>
      </div>
    </section>
  );
}

function ReviewComposer({
  detail,
  reference,
  submitting,
  onSubmit,
}: {
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
  readonly submitting: boolean;
  readonly onSubmit: (input: {
    readonly verdict: PullRequestReviewVerdict;
    readonly body: string;
    readonly comments: readonly PendingReviewComment[];
  }) => void;
}) {
  const key = pullRequestReviewKey(reference);
  const comments = usePullRequestReviewStore(
    (state) => state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS,
  );
  const summary = usePullRequestReviewStore((state) => state.summariesByKey[key] ?? "");
  const remove = usePullRequestReviewStore((state) => state.remove);
  const setSummary = usePullRequestReviewStore((state) => state.setSummary);
  const canSubmit = detail.capabilities.review.verdicts.some((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );

  if (!canSubmit) return null;
  const hasContent = summary.trim().length > 0 || comments.length > 0;
  const submit = (verdict: PullRequestReviewVerdict) =>
    onSubmit({
      verdict,
      body: summary,
      comments,
    });

  return (
    <section className="rounded-lg border border-border/70 bg-card p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageSquareIcon className="size-4" />
        Review
        {comments.length > 0 ? (
          <span className="text-xs font-normal text-muted-foreground">
            {comments.length} pending line {comments.length === 1 ? "comment" : "comments"}
          </span>
        ) : null}
      </div>
      {comments.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {comments.map((comment) => (
            <li className="flex gap-2" key={comment.id}>
              <span className="min-w-0 flex-1 truncate">
                {comment.path}:{comment.line} — {comment.body}
              </span>
              <button
                aria-label={`Discard comment at ${comment.path}:${comment.line}`}
                className="text-destructive hover:underline"
                type="button"
                onClick={() => remove(key, comment.id)}
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Textarea
        className="mt-3"
        disabled={submitting}
        placeholder="Leave a review summary"
        value={summary}
        onChange={(event) => setSummary(key, event.currentTarget.value)}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {detail.capabilities.review.verdicts
          .filter((verdict) => detail.viewerPermissions.verdicts.includes(verdict))
          .map((verdict) => (
            <Button
              disabled={submitting || (verdict !== "approve" && !hasContent)}
              key={verdict}
              size="xs"
              variant={verdict === "request-changes" ? "destructive" : "outline"}
              onClick={() => submit(verdict)}
            >
              {verdict === "approve"
                ? "Approve"
                : verdict === "request-changes"
                  ? "Request changes"
                  : "Comment"}
            </Button>
          ))}
      </div>
    </section>
  );
}

export function PullRequestDetailPanel({
  environmentId,
  reference,
  listEntry = null,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly listEntry?: PullRequestListEntry | null;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("summary");
  const matchingListEntry =
    listEntry?.projectId === reference.projectId &&
    listEntry.repository.toLowerCase() === reference.repository.toLowerCase() &&
    listEntry.number === reference.number
      ? listEntry
      : null;
  const detailQuery = useQuery(pullRequestDetailQueryOptions({ environmentId, reference }));
  const [timelineOrder, setTimelineOrder] = useState<"newest" | "oldest">("newest");
  const monitorQuery = useQuery(
    pullRequestMonitorStatusQueryOptions({
      environmentId,
      reference,
      enabled: detailQuery.data !== undefined,
    }),
  );
  const monitorContextQuery = useQuery(
    pullRequestMonitorContextQueryOptions({
      environmentId,
      reference,
      enabled: monitorQuery.data?.monitor !== null && monitorQuery.data?.monitor !== undefined,
    }),
  );
  const activityQuery = useQuery({
    ...pullRequestActivityQueryOptions({
      environmentId,
      reference,
    }),
    // While GitHub's quota is exhausted every poll fails identically; back
    // off to the server's failure cooldown instead of re-walking the review
    // threads every 30s. Recovery is still automatic on the next poll.
    refetchInterval: (query) =>
      tab === "timeline" ? (isRateLimitQueryError(query.state.error) ? 60_000 : 30_000) : false,
  });
  const [comment, setComment] = useState("");
  const [actionPending, setActionPending] = useState<PullRequestAction | null>(null);
  const [mediaPreview, setMediaPreview] = useState<PullRequestMediaPreview | null>(null);
  const [mergeMethodOverride, setMergeMethodOverride] = useState<PullRequestMergeMethod | null>(
    null,
  );
  const detail = toDetailView(detailQuery.data, activityQuery.data);
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const owner = useMemo(
    () => findPullRequestBrowserThread(threads, environmentId, reference),
    [environmentId, reference, threads],
  );
  const creatorThread = useMemo(
    () => findPullRequestCreationThread(threads, environmentId, reference) ?? null,
    [environmentId, reference, threads],
  );
  const sourceThread = creatorThread ?? owner ?? null;
  const acceptanceProvenance = useMemo(() => {
    for (const findingDetail of monitorContextQuery.data?.findingDetails ?? []) {
      const provenance = findingDetail.finding?.acceptanceProvenance;
      if (provenance) return provenance;
    }
    return null;
  }, [monitorContextQuery.data?.findingDetails]);
  const acceptanceThreadId = monitorQuery.data?.monitor?.ownerThreadId ?? owner?.id ?? null;
  const reviewThreadId =
    monitorQuery.data?.monitor?.linkedReviewThreadId ??
    monitorContextQuery.data?.findingDetails?.find(
      (findingDetail) => findingDetail.reviewThreadId !== null,
    )?.reviewThreadId ??
    null;
  const reviewThread = useMemo(
    () =>
      reviewThreadId === null
        ? null
        : (threads.find(
            (thread) => thread.environmentId === environmentId && thread.id === reviewThreadId,
          ) ?? null),
    [environmentId, reviewThreadId, threads],
  );
  const acceptanceLookupQuery = useQuery(
    collaborativeAcceptanceLookupQueryOptions({
      environmentId,
      threadId: acceptanceThreadId,
      reference,
      enabled: acceptanceThreadId !== null && acceptanceProvenance === null,
    }),
  );
  const acceptanceCaseId =
    acceptanceProvenance?.caseId ?? acceptanceLookupQuery.data?.caseId ?? null;
  const acceptanceQuery = useQuery(
    collaborativeAcceptanceStatusQueryOptions({
      environmentId,
      threadId: acceptanceThreadId,
      caseId: acceptanceCaseId,
      enabled: acceptanceCaseId !== null && acceptanceThreadId !== null,
    }),
  );
  const acceptanceStatus = acceptanceQuery.data ?? acceptanceLookupQuery.data?.status;
  const browserThreadRef = useMemo(
    () => (owner ? scopeThreadRef(owner.environmentId, owner.id) : null),
    [owner?.environmentId, owner?.id],
  );
  const openLink = useOpenLink(browserThreadRef, true);
  const runAction = useMutation(
    pullRequestRunActionMutationOptions({ environmentId, queryClient }),
  );
  const postComment = useMutation(
    pullRequestCommentMutationOptions({ environmentId, queryClient }),
  );
  const submitReview = useMutation(
    pullRequestSubmitReviewMutationOptions({ environmentId, queryClient }),
  );
  const reply = useMutation(
    pullRequestReplyToThreadMutationOptions({ environmentId, queryClient }),
  );
  const resolve = useMutation(
    pullRequestSetThreadResolutionMutationOptions({ environmentId, queryClient }),
  );
  const invalidate = useMutation(
    pullRequestInvalidateMutationOptions({ environmentId, queryClient }),
  );
  const pauseAcceptance = useMutation(
    collaborativeAcceptancePauseMutationOptions({ environmentId, queryClient }),
  );
  const resumeAcceptance = useMutation(
    collaborativeAcceptanceResumeMutationOptions({ environmentId, queryClient }),
  );
  const requestAcceptanceReview = useMutation(
    collaborativeAcceptanceRequestReviewMutationOptions({ environmentId, queryClient }),
  );
  const acceptanceMutationPending =
    pauseAcceptance.isPending || resumeAcceptance.isPending || requestAcceptanceReview.isPending;
  const acceptanceProjection = acceptanceStatus?.record?.projection;
  const acceptanceControls = {
    canControl:
      acceptanceCaseId !== null &&
      acceptanceThreadId !== null &&
      acceptanceStatus?.record !== null &&
      acceptanceStatus?.record !== undefined,
    isLoading:
      acceptanceThreadId !== null &&
      (acceptanceLookupQuery.isLoading ||
        (acceptanceCaseId !== null && acceptanceQuery.isLoading && acceptanceStatus === undefined)),
    error: acceptanceQuery.isError
      ? errorMessage(acceptanceQuery.error)
      : acceptanceLookupQuery.isError
        ? errorMessage(acceptanceLookupQuery.error)
        : null,
    isPaused: acceptanceProjection?.executionPhase === "paused",
    isPending: acceptanceMutationPending,
    onPause: () => {
      if (acceptanceCaseId === null || acceptanceThreadId === null) return;
      void pauseAcceptance
        .mutateAsync({
          threadId: acceptanceThreadId,
          caseId: acceptanceCaseId,
          reason: "ambiguous-outcome",
        })
        .then(() => {
          toastManager.add({ type: "success", title: "Automation paused" });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not pause automation",
            description: errorMessage(error),
          });
        });
    },
    onResume: () => {
      if (acceptanceCaseId === null || acceptanceThreadId === null) return;
      void resumeAcceptance
        .mutateAsync({ threadId: acceptanceThreadId, caseId: acceptanceCaseId })
        .then(() => {
          toastManager.add({ type: "success", title: "Automation resumed" });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not resume automation",
            description: errorMessage(error),
          });
        });
    },
    onRequestReview: () => {
      if (acceptanceCaseId === null || acceptanceThreadId === null) return;
      void requestAcceptanceReview
        .mutateAsync({ threadId: acceptanceThreadId, caseId: acceptanceCaseId })
        .then(() => {
          toastManager.add({ type: "success", title: "Review request queued" });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not request review",
            description: errorMessage(error),
          });
        });
    },
  };

  const refresh = () => {
    void invalidate.mutateAsync({ reference }).catch((error) =>
      toastManager.add({
        type: "error",
        title: "Could not refresh",
        description: errorMessage(error),
      }),
    );
  };
  const performAction = async (
    action: PullRequestAction,
    input?: { mergeMethod?: PullRequestMergeMethod },
  ) => {
    if (!detail || actionPending) return;
    if (
      action === "close" &&
      typeof window !== "undefined" &&
      !window.confirm(`Close PR #${detail.number} "${detail.title}"?`)
    ) {
      return;
    }
    setActionPending(action);
    try {
      const mergeMethod =
        action === "merge"
          ? (input?.mergeMethod ??
            detail.capabilities.mergeMethods.find((method) => detail.mergeCapabilities[method]) ??
            undefined)
          : undefined;
      await runAction.mutateAsync({
        ...reference,
        action,
        ...(mergeMethod ? { mergeMethod } : {}),
      });
      const successLabels: Record<PullRequestAction, string> = {
        close: "Pull request closed",
        draft: "Pull request converted to draft",
        merge: "Pull request merged",
        ready: "Pull request marked ready",
        reopen: "Pull request reopened",
      };
      toastManager.add({ type: "success", title: successLabels[action] });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Pull request action failed",
        description: errorMessage(error),
      });
    } finally {
      setActionPending(null);
    }
  };
  const sendReply = async (threadId: string, body: string) => {
    try {
      await reply.mutateAsync({ ...reference, threadId, body });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not reply",
        description: errorMessage(error),
      });
      throw error;
    }
  };
  const toggleResolved = (threadId: string, resolved: boolean) => {
    void resolve.mutateAsync({ ...reference, threadId, resolved }).catch((error) =>
      toastManager.add({
        type: "error",
        title: "Could not update thread",
        description: errorMessage(error),
      }),
    );
  };
  const submitComment = () => {
    const submittedComment = comment.trim();
    if (postComment.isPending || !submittedComment) return;
    void postComment
      .mutateAsync({ ...reference, body: submittedComment })
      .then(() => setComment((current) => (current === submittedComment ? "" : current)))
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Could not post comment",
          description: errorMessage(error),
        }),
      );
  };
  const timelineItems = useMemo(
    () =>
      [
        ...(detail?.comments ?? []).map((comment) => ({ kind: "comment" as const, item: comment })),
        ...(detail?.commits ?? []).map((commit) => ({ kind: "commit" as const, item: commit })),
      ].toSorted((left, right) => {
        const leftDate = left.kind === "comment" ? left.item.createdAt : left.item.committedDate;
        const rightDate =
          right.kind === "comment" ? right.item.createdAt : right.item.committedDate;
        return leftDate.localeCompare(rightDate);
      }),
    [detail?.comments, detail?.commits],
  );
  const orderedTimelineItems = useMemo(
    () => (timelineOrder === "newest" ? timelineItems.toReversed() : timelineItems),
    [timelineItems, timelineOrder],
  );

  if (detailQuery.isPending) {
    return (
      <div className="flex h-full flex-col gap-4 p-4" aria-busy="true">
        {matchingListEntry ? (
          <>
            <div className="flex items-start gap-3">
              <PullRequestStateGlyph
                isDraft={matchingListEntry.isDraft}
                mergeability={matchingListEntry.mergeability}
                state={matchingListEntry.state}
                className="mt-0.5 size-5"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <span className="truncate">{matchingListEntry.repository}</span>
                  <span aria-hidden>/</span>
                  <span>#{matchingListEntry.number}</span>
                </div>
                <h1 className="mt-1 truncate text-base font-semibold">{matchingListEntry.title}</h1>
                <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel actor={matchingListEntry.author} tooltip={false} />
                  <span>updated {formatRelativeTimeLabel(matchingListEntry.updatedAt)}</span>
                </div>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{matchingListEntry.baseBranch}</span>
              <ArrowLeftIcon className="size-3 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{matchingListEntry.headBranch}</span>
              <PullRequestDiffStat
                additions={matchingListEntry.additions}
                deletions={matchingListEntry.deletions}
              />
            </div>
          </>
        ) : (
          <div className="flex items-start gap-3">
            <div className="size-5 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
              <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
            </div>
          </div>
        )}
        <div className="h-8 animate-pulse rounded bg-muted/70" />
        <div className="h-24 animate-pulse rounded-lg bg-muted/50" />
      </div>
    );
  }
  if (detailQuery.error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{errorMessage(detailQuery.error)}</p>
        <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const availableActions = detail.capabilities.actions.filter((action) =>
    isAvailableAction(detail, action),
  );
  // Merge strategies the host allows for this pull request. The choice is
  // the reviewer's, not the first allowed method's: squash and merge land
  // very different history.
  const { allowedMergeMethods, selectedMergeMethod, showMergeMethodPicker } =
    resolvePullRequestMergeSelection({
      canMerge: availableActions.includes("merge"),
      mergeMethods: detail.capabilities.mergeMethods,
      mergeCapabilities: detail.mergeCapabilities,
      override: mergeMethodOverride,
    });
  const checkSummary = summarizePullRequestChecks(detail.checks);
  const checkIndicatorClassName =
    checkSummary.failing > 0 || checkSummary.cancelled > 0
      ? "text-destructive"
      : checkSummary.pending > 0
        ? "text-muted-foreground"
        : "text-emerald-500";
  const timelineCount = timelineItems.length;
  const tabs = detail.capabilities.diff ? TABS : TABS.filter((tab) => tab.value !== "code");
  const activeTab = tabs.some((item) => item.value === tab) ? tab : "summary";
  const reviewKey = pullRequestReviewKey(reference);
  const prefetchCodeDiff = () => {
    void queryClient.prefetchInfiniteQuery(
      pullRequestDiffInfiniteQueryOptions({
        environmentId,
        request: reference,
      }),
    );
  };
  const statePresentation = pullRequestStatePresentation({
    state: detail.state,
    isDraft: detail.isDraft,
    mergeability: detail.mergeability,
    baseBranch: detail.baseBranch,
  });

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      onClickCapture={(event) => {
        if (event.button !== 0 || !(event.target instanceof Element)) return;
        if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) {
          return;
        }
        const link = event.target.closest("a[href]");
        const url = link?.getAttribute("href");
        if (!url || !isWebUrl(url)) return;
        event.preventDefault();
        event.stopPropagation();
        void openLink(url, { event }).catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not open link",
            description: errorMessage(error),
          });
        });
      }}
    >
      <header className="shrink-0 border-b border-border/60 bg-background">
        <div className="flex h-8 items-center gap-2 border-b border-border/60 px-4 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="min-w-0 truncate font-medium">{detail.repository}</span>
            <span aria-hidden>/</span>
            <a
              className={cn(
                "inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                statePresentation.className,
              )}
              href={detail.url}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                void openLink(detail.url).catch((error: unknown) => {
                  toastManager.add({
                    type: "error",
                    title: "Could not open pull request",
                    description: errorMessage(error),
                  });
                });
              }}
            >
              #{detail.number}
              <ExternalLinkIcon className="size-2.5" />
            </a>
          </div>
          <Button
            aria-label="Refresh pull request"
            size="icon-xs"
            variant="ghost"
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3.5", invalidate.isPending && "animate-spin")} />
          </Button>
          <Button
            aria-label="Close pull request panel"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="min-w-0 px-4 pt-3 pb-4">
          <div className="flex min-w-0 items-start gap-2">
            <span
              className={cn(
                "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                statePresentation.className,
              )}
            >
              <PullRequestStateGlyph
                isDraft={detail.isDraft}
                mergeability={detail.mergeability}
                state={detail.state}
                className="size-3"
              />
              {statePresentation.label}
            </span>
            <h1 className="min-w-0 flex-1 text-base leading-5 font-semibold" title={detail.title}>
              {detail.title}
            </h1>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <PullRequestActorLabel actor={detail.author} className="min-w-0 font-medium" />
            <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
            <span className="shrink-0">updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
            <a
              className="ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground"
              href={detail.url}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                void openLink(detail.url).catch((error: unknown) => {
                  toastManager.add({
                    type: "error",
                    title: "Could not open pull request",
                    description: errorMessage(error),
                  });
                });
              }}
            >
              GitHub <ExternalLinkIcon className="size-3" />
            </a>
          </div>
          <div className="mt-4 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px]">
              <span
                className="min-w-0 max-w-[42%] truncate"
                title={`Base branch: ${detail.baseBranch}`}
              >
                {detail.baseBranch}
              </span>
              <ArrowLeftIcon
                aria-label="receives changes from"
                className="size-3 shrink-0 opacity-60"
              />
              <span className="min-w-0 flex-1 truncate" title={`Head branch: ${detail.headBranch}`}>
                {detail.headBranch}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
              <span className="inline-flex items-center gap-1">
                <FileDiffIcon className="size-3" />
                {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
              </span>
              <PullRequestDiffStat
                additions={detail.additions}
                deletions={detail.deletions}
                className="font-mono text-[11px]"
              />
            </span>
          </div>
        </div>
        {availableActions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 px-4 pb-3">
            {availableActions
              .filter((action) => action !== "close")
              .map((action) => (
                <span className="inline-flex items-center gap-1" key={action}>
                  {action === "merge" && showMergeMethodPicker && selectedMergeMethod ? (
                    <select
                      aria-label="Merge method"
                      className="h-6 rounded border border-input bg-background px-1 text-xs"
                      disabled={actionPending !== null}
                      value={selectedMergeMethod}
                      onChange={(event) =>
                        setMergeMethodOverride(event.currentTarget.value as PullRequestMergeMethod)
                      }
                    >
                      {allowedMergeMethods.map((method) => (
                        <option key={method} value={method}>
                          {method === "merge" ? "Merge" : method === "squash" ? "Squash" : "Rebase"}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <Button
                    aria-label={pullRequestActionLabel(action)}
                    disabled={actionPending !== null}
                    size="xs"
                    title={
                      action === "merge"
                        ? `Merge ${detail.headBranch} into ${detail.baseBranch}${
                            selectedMergeMethod ? ` via ${selectedMergeMethod}` : ""
                          }`
                        : pullRequestActionLabel(action)
                    }
                    variant={action === "merge" ? "default" : "outline"}
                    onClick={() =>
                      void performAction(
                        action,
                        action === "merge" && selectedMergeMethod
                          ? { mergeMethod: selectedMergeMethod }
                          : undefined,
                      )
                    }
                  >
                    {actionPending === action ? (
                      "Working…"
                    ) : action === "merge" ? (
                      <>
                        <GitMergeIcon className="size-3" />
                        Merge
                      </>
                    ) : (
                      pullRequestActionLabel(action)
                    )}
                  </Button>
                </span>
              ))}
            {availableActions.includes("close") ? (
              <Button
                aria-label="Close pull request"
                className="ml-auto"
                disabled={actionPending !== null}
                size="xs"
                title="Close this pull request without merging"
                variant="destructive"
                onClick={() => void performAction("close")}
              >
                {actionPending === "close" ? "Working…" : "Close"}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div
          aria-label="Pull request detail tabs"
          className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
          role="tablist"
        >
          <div className="flex min-w-0 items-center gap-0.5 rounded-md border border-border/70 bg-muted/20 p-0.5">
            {tabs.map((item) => {
              const count =
                item.value === "timeline"
                  ? timelineCount
                  : item.value === "code"
                    ? detail.changedFiles
                    : null;
              const selected = activeTab === item.value;
              return (
                <button
                  aria-controls={selected ? "pr-panel" : undefined}
                  aria-selected={selected}
                  className={cn(
                    "rounded px-2 py-1 text-[11px] font-medium tabular-nums transition-colors",
                    selected
                      ? "bg-background text-foreground shadow-xs/5"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  id={`pr-tab-${item.value}`}
                  key={item.value}
                  role="tab"
                  type="button"
                  onFocus={item.value === "code" ? prefetchCodeDiff : undefined}
                  onPointerEnter={item.value === "code" ? prefetchCodeDiff : undefined}
                  onClick={() => setTab(item.value)}
                >
                  {item.label}
                  {count !== null ? (
                    <span className="ml-1 text-muted-foreground">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {activeTab === "summary" ? (
            <span
              className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title={pullRequestCheckSummaryLabel(checkSummary)}
            >
              <CircleDotIcon className={cn("size-3.5", checkIndicatorClassName)} />
              {detail.checks.length > 0
                ? `${checkSummary.passing}/${detail.checks.length} checks`
                : "No checks"}
            </span>
          ) : null}
          {activeTab === "timeline" ? (
            <div className="ml-auto flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <MessageSquareIcon className="size-3" />
                {detail.commentCount}
              </span>
              <span className="inline-flex items-center gap-1">
                <GitCommitHorizontalIcon className="size-3" />
                {detail.commits.length}
              </span>
              <Button
                aria-label={
                  timelineOrder === "newest"
                    ? "Show oldest activity first"
                    : "Show newest activity first"
                }
                className="h-6 px-1.5 text-[10px] text-muted-foreground"
                size="xs"
                variant="ghost"
                onClick={() =>
                  setTimelineOrder((value) => (value === "newest" ? "oldest" : "newest"))
                }
              >
                <ArrowDownUpIcon className="size-3" />
                {timelineOrder === "newest" ? "Newest" : "Oldest"}
              </Button>
            </div>
          ) : null}
        </div>
        {activeTab === "summary" ? (
          monitorQuery.data ? (
            <div className="border-t border-border/70 px-4 py-3">
              <PullRequestCollaborationStatusCard
                acceptance={acceptanceStatus}
                controls={acceptanceControls}
                creatorThread={sourceThread}
                creatorThreadLabel={creatorThread ? "Created in" : "Linked from"}
                environmentId={environmentId}
                reviewThread={reviewThread}
                status={monitorQuery.data}
                onNavigateThread={onClose}
              />
            </div>
          ) : monitorQuery.isError ? (
            <div className="border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">
              Collaboration status unavailable: {errorMessage(monitorQuery.error)}
            </div>
          ) : null
        ) : null}
      </header>
      <div
        aria-labelledby={`pr-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        id="pr-panel"
        role="tabpanel"
      >
        {activeTab === "summary" ? (
          <PullRequestSummaryTab
            activityError={activityQuery.error ? errorMessage(activityQuery.error) : null}
            activityPending={activityQuery.isPending}
            detail={detail}
            environmentId={environmentId}
            reference={reference}
            onOpenUrl={(url) => {
              void openLink(url).catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not open link",
                  description: errorMessage(error),
                });
              });
            }}
            onPreviewMedia={setMediaPreview}
            onRetryActivity={() => void activityQuery.refetch()}
          />
        ) : null}
        {activeTab === "timeline" ? (
          <div className="relative px-4 pt-4 pb-5">
            {activityQuery.isPending ? (
              <p className="text-xs text-muted-foreground">Loading timeline…</p>
            ) : null}
            {activityQuery.error ? (
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
                <span className="min-w-0 flex-1">
                  Could not load the full timeline: {errorMessage(activityQuery.error)}
                </span>
                <Button size="xs" variant="outline" onClick={() => void activityQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : null}
            {orderedTimelineItems.length > 0 ? (
              <div className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-3 before:w-px before:bg-border/70">
                {orderedTimelineItems.map((entry) =>
                  entry.kind === "commit" ? (
                    <article className="relative flex gap-3" key={entry.item.oid}>
                      <span className="relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
                        <GitCommitHorizontalIcon className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="font-mono text-foreground">
                            {entry.item.oid.slice(0, 7)}
                          </span>
                          <span>committed</span>
                          <span>{formatRelativeTimeLabel(entry.item.committedDate)}</span>
                        </div>
                        <p className="mt-1.5 text-sm">{entry.item.messageHeadline}</p>
                      </div>
                    </article>
                  ) : (
                    <article
                      className="relative flex gap-3 [content-visibility:auto]"
                      key={entry.item.id}
                    >
                      <span className="relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                        <PullRequestActorLabel
                          actor={entry.item.author}
                          className="size-6 justify-center"
                          labelClassName="sr-only"
                          tooltip={false}
                        />
                      </span>
                      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background">
                        <div className="flex flex-wrap items-center gap-2 bg-muted/25 px-3 py-2 text-[11px] text-muted-foreground">
                          <PullRequestActorLabel
                            actor={entry.item.author}
                            className="font-medium text-foreground"
                          />
                          <span>{formatRelativeTimeLabel(entry.item.createdAt)}</span>
                          {entry.item.kind === "review-comment" && entry.item.path ? (
                            <span className="min-w-0 truncate font-mono text-[10px]">
                              {entry.item.path}
                              {typeof entry.item.reviewState === "string" && entry.item.reviewState
                                ? ` · ${entry.item.reviewState}`
                                : ""}
                            </span>
                          ) : null}
                          {entry.item.kind === "review" ? (
                            <ReviewVerdictBadge reviewState={entry.item.reviewState} />
                          ) : null}
                        </div>
                        <div className="px-3 py-3 text-sm">
                          <PullRequestBody
                            body={entry.item.body}
                            cwd={detail.workspaceRoot}
                            onPreview={setMediaPreview}
                          />
                        </div>
                      </div>
                    </article>
                  ),
                )}
              </div>
            ) : null}
            {detail.commentsTruncated ? (
              <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-muted-foreground">
                GitHub returned the most recent {detail.comments.length} of {detail.commentCount}{" "}
                items; some line-level review comments may be missing.
              </p>
            ) : null}
            {orderedTimelineItems.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No conversation yet.</p>
            ) : null}
            {detail.capabilities.comment && detail.viewerPermissions.comment ? (
              <div className="sticky bottom-0 -mx-4 mt-4 border-t border-border bg-background px-4 pt-3 pb-1">
                <CommentComposer
                  value={comment}
                  disabled={postComment.isPending}
                  onChange={setComment}
                  onSubmit={submitComment}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {activeTab === "code" ? (
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading code…</p>}>
            <LazyPullRequestCodeTab
              detail={detail}
              environmentId={environmentId}
              key={reviewKey}
              reference={reference}
              onReply={sendReply}
              onResolve={toggleResolved}
              pending={reply.isPending || resolve.isPending}
            />
          </Suspense>
        ) : null}
        {activeTab !== "summary" ? (
          <div className="p-4 pt-0">
            <ReviewComposer
              detail={detail}
              reference={reference}
              submitting={submitReview.isPending}
              onSubmit={({ verdict, body, comments }) =>
                void submitReview
                  .mutateAsync({
                    ...reference,
                    verdict,
                    body,
                    comments: comments.map(({ id: _id, ...comment }) => comment),
                  })
                  .then(() => {
                    usePullRequestReviewStore.getState().removeSubmitted(
                      reviewKey,
                      comments.map((comment) => comment.id),
                    );
                    usePullRequestReviewStore.getState().clearSubmitted(reviewKey, body);
                    toastManager.add({ type: "success", title: "Review submitted" });
                  })
                  .catch((error) =>
                    toastManager.add({
                      type: "error",
                      title: "Could not submit review",
                      description: errorMessage(error),
                    }),
                  )
              }
            />
          </div>
        ) : null}
      </div>
      {mediaPreview ? (
        <PullRequestMediaDialog
          key={`${mediaPreview.type}:${mediaPreview.src}`}
          preview={mediaPreview}
          onClose={() => setMediaPreview(null)}
        />
      ) : null}
    </section>
  );
}
