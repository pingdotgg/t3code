/**
 * Code Review & PRs right-panel surface.
 *
 * Lists the repository's open change requests, split into "Assigned to me" and
 * "Not assigned to me". Checking one out reuses the same prepare-thread flow as
 * the Checkout PR dialog, so a PR opened here lands in a draft thread on the
 * PR's branch, either in the main repo or in a dedicated worktree.
 */
import type {
  ChangeRequest,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon, RefreshCwIcon, SearchIcon, SparklesIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useCallback, useMemo, useState } from "react";

import { selectCodeReview, useCodeReviewStore } from "~/codeReviewStore";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import {
  getSourceControlPresentation,
  resolveChangeRequestPresentation,
} from "~/sourceControlPresentation";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import { useEnvironmentThread } from "~/state/threads";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { vcsEnvironment } from "~/state/vcs";
import {
  CODE_REVIEW_STATUS_LABELS,
  filterChangeRequests,
  partitionChangeRequests,
  resolveRowReviewStatus,
  selectViewerAccount,
  type CodeReviewStatus,
  type PullRequestTab,
} from "./PullRequestsPanel.logic";
import { useStartCodeReview } from "./useStartCodeReview";

const LIST_LIMIT = 50;

interface PullRequestsPanelProps {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  /** Resolves the model a review should run with, read at click time. */
  readonly resolveModelSelection: () => ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
  }) => Promise<void> | void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

function stateToneClass(state: ChangeRequest["state"]): string {
  switch (state) {
    case "merged":
      return "text-violet-600 dark:text-violet-300/90";
    case "closed":
      return "text-zinc-500 dark:text-zinc-400/80";
    case "open":
      return "text-emerald-600 dark:text-emerald-300/90";
  }
}

function reviewStatusToneClass(status: CodeReviewStatus): string {
  switch (status) {
    case "reviewing":
      return "text-info";
    case "reviewed":
      return "text-success";
    case "failed":
      return "text-destructive";
    case "stopped":
      return "text-muted-foreground";
  }
}

function ReviewStatusChip({ status, onOpen }: { status: CodeReviewStatus; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] hover:bg-accent",
        reviewStatusToneClass(status),
      )}
    >
      {status === "reviewing" ? <Spinner className="size-2.5" /> : null}
      {CODE_REVIEW_STATUS_LABELS[status]}
    </button>
  );
}

function ChangeRequestRow({
  changeRequest,
  terminology,
  busy,
  preparingMode,
  environmentId,
  reviewThreadId,
  reviewStarting,
  canReview,
  onCheckout,
  onReview,
  onOpenReview,
}: {
  changeRequest: ChangeRequest;
  terminology: string;
  busy: boolean;
  preparingMode: "local" | "worktree" | null;
  environmentId: EnvironmentId | null;
  reviewThreadId: ThreadId | null;
  reviewStarting: boolean;
  canReview: boolean;
  onCheckout: (mode: "local" | "worktree") => void;
  onReview: () => void;
  onOpenReview: () => void;
}) {
  const openPrLink = useOpenPrLink();
  // Subscribed per row so the chip tracks the review thread live rather than
  // through a second copy of run state in the review store. The snapshot
  // streams in asynchronously, so a known review falls back to "reviewing"
  // rather than losing its chip until the thread arrives.
  const reviewThread = useEnvironmentThread(environmentId, reviewThreadId);
  const reviewStatus = resolveRowReviewStatus({
    reviewThreadId,
    thread: Option.getOrNull(reviewThread.data),
  });
  const updatedAt = Option.getOrNull(changeRequest.updatedAt);
  const updatedLabel =
    updatedAt === null ? null : formatRelativeTimeLabel(DateTime.formatIso(updatedAt));
  const assignees = changeRequest.assignees ?? [];

  return (
    <article className="group/pr relative flex flex-col gap-1 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-accent/40">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed font-medium break-words">
          {changeRequest.title}
        </p>
        <span
          className={cn("shrink-0 text-[10px] capitalize", stateToneClass(changeRequest.state))}
        >
          {changeRequest.state}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="tabular-nums">#{changeRequest.number}</span>
        <span className="truncate">
          {changeRequest.headRefName} → {changeRequest.baseRefName}
        </span>
        {changeRequest.author ? <span className="truncate">by {changeRequest.author}</span> : null}
        {updatedLabel ? <span className="shrink-0">{updatedLabel}</span> : null}
      </div>
      {assignees.length > 0 ? (
        <p className="truncate text-[10px] text-muted-foreground">
          Assigned to {assignees.join(", ")}
        </p>
      ) : null}
      {/*
        Not hover-gated: a review running in the background is exactly the
        thing you want to see without pointing at the row.
      */}
      {reviewStatus !== null ? (
        <ReviewStatusChip status={reviewStatus} onOpen={onOpenReview} />
      ) : null}
      {/*
        Floating rather than in flow: 50 rows each reserving a hidden button
        band makes the list twice as tall and hard to scan. Overlaying keeps
        rows compact without the layout shifting under the pointer on hover.
      */}
      <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-accent/95 p-1 opacity-0 shadow-sm transition group-hover/pr:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                className="h-6 gap-1 px-2 text-[10px]"
                disabled={!canReview || reviewStarting}
                onClick={onReview}
              >
                <SparklesIcon className="size-3" />
                {reviewStarting ? "Starting…" : reviewStatus === null ? "Review" : "Re-review"}
              </Button>
            }
          />
          <TooltipPopup>
            {canReview
              ? `Review this ${terminology} in a background thread`
              : `Reviewing needs a project with a recognised source control provider.`}
          </TooltipPopup>
        </Tooltip>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px]"
          disabled={busy}
          onClick={() => {
            onCheckout("local");
          }}
        >
          {preparingMode === "local" ? "Preparing..." : "Local"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px]"
          disabled={busy}
          onClick={() => {
            onCheckout("worktree");
          }}
        >
          {preparingMode === "worktree" ? "Preparing..." : "Worktree"}
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={`Open ${terminology} #${changeRequest.number} in browser`}
                onClick={(event) => {
                  openPrLink(event, changeRequest.url);
                }}
              >
                <ExternalLinkIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup>Open in browser</TooltipPopup>
        </Tooltip>
      </div>
    </article>
  );
}

export function PullRequestsPanel({
  environmentId,
  cwd,
  threadId,
  projectId,
  resolveModelSelection,
  runtimeMode,
  onPrepared,
  onOpenThread,
}: PullRequestsPanelProps) {
  const [tab, setTab] = useState<PullRequestTab>("assigned");
  const [query, setQuery] = useState("");
  const [preparing, setPreparing] = useState<{
    number: number;
    mode: "local" | "worktree";
  } | null>(null);

  const changeRequestsQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? sourceControlEnvironment.changeRequests({
          environmentId,
          input: { cwd, state: "open", limit: LIST_LIMIT },
        })
      : null,
  );
  const discoveryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const statusQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd } })
      : null,
  );

  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
  const prepareAction = usePreparePullRequestThreadAction(scope);

  const settings = usePrimarySettings();
  const configuredReviewModel = settings.codeReviewModelSelection;
  const resolveReviewModelSelection = useCallback(
    () => configuredReviewModel ?? resolveModelSelection(),
    [configuredReviewModel, resolveModelSelection],
  );
  const reviewScope = useMemo(
    () => ({
      environmentId,
      projectId,
      resolveModelSelection: resolveReviewModelSelection,
      runtimeMode,
      branch: statusQuery.data?.refName ?? null,
      instructions: settings.codeReviewInstructions,
    }),
    [
      environmentId,
      projectId,
      resolveReviewModelSelection,
      runtimeMode,
      settings.codeReviewInstructions,
      statusQuery.data?.refName,
    ],
  );
  const { start: startReview, startingNumber } = useStartCodeReview(reviewScope);
  const reviewsByKey = useCodeReviewStore((state) => state.byKey);
  // An unknown provider has no diff command to hand the agent, so a review
  // would start a thread that immediately gets stuck.
  const canReview =
    projectId !== null && (changeRequestsQuery.data?.provider ?? "unknown") !== "unknown";

  const presentation = getSourceControlPresentation(statusQuery.data?.sourceControlProvider);
  const terminology = presentation.terminology;
  const pluralLabel = resolveChangeRequestPresentation(
    statusQuery.data?.sourceControlProvider,
  ).pluralLongName;
  const ProviderIcon = presentation.Icon;

  const providerKind = changeRequestsQuery.data?.provider ?? null;
  const viewer = useMemo(
    () => selectViewerAccount(discoveryQuery.data?.sourceControlProviders ?? [], providerKind),
    [discoveryQuery.data, providerKind],
  );

  const partition = useMemo(
    () => partitionChangeRequests(changeRequestsQuery.data?.changeRequests ?? [], viewer),
    [changeRequestsQuery.data, viewer],
  );
  const visible = useMemo(
    () =>
      filterChangeRequests(tab === "assigned" ? partition.assigned : partition.unassigned, query),
    [partition, query, tab],
  );

  const checkout = useCallback(
    async (changeRequest: ChangeRequest, mode: "local" | "worktree") => {
      setPreparing({ number: changeRequest.number, mode });
      const result = await prepareAction.run({
        reference: String(changeRequest.number),
        mode,
        ...(mode === "worktree" && threadId ? { threadId } : {}),
      });
      setPreparing(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) prepareAction.resetError();
        return;
      }
      await onPrepared({
        branch: result.value.branch,
        worktreePath: result.value.worktreePath,
      });
    },
    [onPrepared, prepareAction, threadId],
  );

  if (environmentId === null || cwd === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Open a project to see its {pluralLabel}.
      </div>
    );
  }

  const listError = changeRequestsQuery.error;
  const isLoading = changeRequestsQuery.isPending && changeRequestsQuery.data === undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <ProviderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs capitalize">{pluralLabel}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6"
            onClick={changeRequestsQuery.refresh}
            disabled={changeRequestsQuery.isPending}
            aria-label={`Refresh ${pluralLabel}`}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={`Filter by title, #number, branch or author`}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <div
          role="tablist"
          aria-label={`${terminology.singular} assignment`}
          className="flex items-center gap-1"
        >
          {(
            [
              { id: "assigned", label: "Assigned to me", count: partition.assigned.length },
              { id: "unassigned", label: "Not assigned to me", count: partition.unassigned.length },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => {
                setTab(entry.id);
              }}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px]",
                tab === entry.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {entry.label}
              <span className="tabular-nums opacity-70">{entry.count}</span>
            </button>
          ))}
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading {pluralLabel}...
          </div>
        ) : listError ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-muted-foreground">
            <p className="text-destructive">{listError ?? `Unable to load ${pluralLabel}.`}</p>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px]"
              onClick={changeRequestsQuery.refresh}
            >
              Try again
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            {tab === "assigned" && viewer === null
              ? `Sign in to ${presentation.providerName} to see ${pluralLabel} assigned to you.`
              : query.trim().length > 0
                ? `No ${pluralLabel} match this filter.`
                : tab === "assigned"
                  ? `No open ${pluralLabel} are assigned to you.`
                  : `No other open ${pluralLabel}.`}
          </div>
        ) : (
          <div className="flex flex-col">
            {visible.map((changeRequest) => {
              const review =
                environmentId !== null && projectId !== null
                  ? selectCodeReview(reviewsByKey, {
                      environmentId,
                      projectId,
                      provider: changeRequest.provider,
                      number: changeRequest.number,
                    })
                  : null;
              return (
                <ChangeRequestRow
                  key={changeRequest.number}
                  changeRequest={changeRequest}
                  terminology={terminology.singular}
                  busy={prepareAction.isPending}
                  preparingMode={preparing?.number === changeRequest.number ? preparing.mode : null}
                  environmentId={environmentId}
                  reviewThreadId={review?.threadId ?? null}
                  reviewStarting={startingNumber === changeRequest.number}
                  canReview={canReview}
                  onCheckout={(mode) => {
                    void checkout(changeRequest, mode);
                  }}
                  onReview={() => {
                    void startReview(changeRequest);
                  }}
                  onOpenReview={() => {
                    if (review) onOpenThread(review.threadId);
                  }}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
