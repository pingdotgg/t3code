import { useAtomValue } from "@effect/atom-react";
import { toServerClock } from "@t3tools/client-runtime/clock";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { buildPendingUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleXIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type MouseEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { useClientSettings } from "../../hooks/useSettings";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTime, formatUpcomingTimestamp } from "../../timestampFormat";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { resolveWorkingStartedAt, type SidebarThreadStatus } from "../Sidebar.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import type { BoardCard } from "./threadBoard.logic";
import { useLaneChangeAnimation } from "./useLaneChangeAnimation";

// Labels and colors match the sidebar's thread status (SidebarThreadRow).
const STATUS_PRESENTATION: Record<
  SidebarThreadStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  preparing: {
    label: msg("Setting up"),
    icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  working: {
    label: msg("Working", { $context: "thread status" }),
    icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  waiting: {
    label: msg("Waiting", { $context: "thread status" }),
    icon: CircleDotDashedIcon,
    className: "text-muted-foreground",
  },
  approval: {
    label: msg("Approval", { $context: "thread status: needs approval" }),
    icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
  },
  input: {
    label: msg("Input", { $context: "thread status: needs user input" }),
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: {
    label: msg("Request", { $context: "thread status: guest request" }),
    icon: UserRoundIcon,
    className: "text-guest-foreground",
  },
  limited: {
    label: msg("Limited", { $context: "thread status: usage limited" }),
    icon: CircleAlertIcon,
    className: "text-warning-foreground",
  },
  failed: {
    label: msg("Failed", { $context: "thread status" }),
    icon: CircleAlertIcon,
    className: "text-error-foreground",
  },
  ready: {
    label: msg("Done", { $context: "thread status" }),
    icon: CircleCheckIcon,
    className: "text-success-foreground",
  },
};

const CHECKS_FAILING_PRESENTATION = {
  label: msg("Checks failing", { $context: "thread status: pull request checks failing" }),
  icon: CircleXIcon,
  className: "text-error-foreground",
};

/** Status icon and label, with the working time while the thread runs. */
export function BoardStatusLabel(props: { card: BoardCard }) {
  const m = useMessages();
  const { card } = props;
  const checksFailing = card.lane === "needs" && card.status === "ready";
  const status = checksFailing ? CHECKS_FAILING_PRESENTATION : STATUS_PRESENTATION[card.status];
  const StatusIcon = status.icon;
  const workingStartedAt = card.lane === "working" ? resolveWorkingStartedAt(card.thread) : null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs font-medium", status.className)}>
      <StatusIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{m(status.label)}</span>
      {workingStartedAt === null ? null : (
        <span className="font-normal text-muted-foreground tabular-nums">
          <WorkingDuration environmentId={card.thread.environmentId} startedAt={workingStartedAt} />
        </span>
      )}
    </span>
  );
}

export function ThreadBoardCard(props: {
  card: BoardCard;
  cardKey: string;
  selected: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { card } = props;
  const { thread } = card;
  const articleRef = useRef<HTMLElement>(null);
  useLaneChangeAnimation(articleRef, props.cardKey, card.lane);
  const pullRequest = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const pullRequestState =
    pullRequest?.snapshot == null
      ? null
      : resolvePullRequestState(
          { state: pullRequest.snapshot.state, isDraft: pullRequest.snapshot.isDraft },
          m,
        );
  const PullRequestIcon = pullRequestState?.Icon ?? PullRequestGlyph.pullRequest;

  return (
    <article
      ref={articleRef}
      className={cn(
        "relative flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 shadow-xs/5 transition-colors has-[>button:hover]:border-foreground/20",
        props.selected && "border-primary ring-1 ring-primary ring-inset",
      )}
    >
      {/* The whole card opens the thread; controls inside it sit above this button. */}
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={gt("Open {title}", { title: thread.title })}
        aria-pressed={props.selected}
        data-board-card={props.cardKey}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <div className="pointer-events-none flex min-w-0 items-center gap-1.5">
        <BoardStatusLabel card={card} />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          <BoardRelativeTime timestamp={card.activityAt} />
        </span>
      </div>
      <p className="pointer-events-none line-clamp-2 text-sm font-medium leading-snug">
        {thread.title}
      </p>
      {card.lane === "needs" ? (
        <BoardCardRequest
          card={card}
          threadRef={threadRef}
          pullRequestUrl={pullRequest?.url ?? null}
        />
      ) : null}
      {pullRequest === null ? null : (
        <div className="pointer-events-none flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex h-5 items-center gap-1 rounded-md border px-1.5">
            <PullRequestIcon
              aria-label={pullRequestState?.label}
              aria-hidden={pullRequestState === null}
              className={cn("size-3", pullRequestState?.toneClassName)}
            />
            #{pullRequest.number}
            {pullRequest.snapshot?.state === "open" &&
            pullRequest.snapshot.checksState === "pending" ? (
              <CircleDashedIcon
                aria-label={gt("Checks running")}
                className="size-3 text-info-foreground"
              />
            ) : null}
            {pullRequest.snapshot?.state === "open" &&
            pullRequest.snapshot.checksState === "passing" ? (
              <CircleCheckIcon
                aria-label={gt("Checks passed")}
                className="size-3 text-success-foreground"
              />
            ) : null}
          </span>
          {pullRequest.snapshot?.additions === undefined ||
          pullRequest.snapshot.deletions === undefined ? null : (
            <span className="inline-flex h-5 items-center gap-1 rounded-md border px-1.5 font-mono">
              <span className="text-diff-addition-foreground">
                +{pullRequest.snapshot.additions}
              </span>
              <span className="text-diff-deletion-foreground">
                −{pullRequest.snapshot.deletions}
              </span>
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** What the thread is waiting on, with the actions that answer it from the board. */
export function BoardCardRequest(props: {
  card: BoardCard;
  threadRef: ScopedThreadRef;
  pullRequestUrl: string | null;
}) {
  const { card, threadRef } = props;
  switch (card.status) {
    case "approval":
    case "input":
      return <BoardCardPendingRequest card={card} threadRef={threadRef} />;
    case "failed":
      return card.thread.runtime?.lastError ? (
        <RequestBox tone="error">
          <p className="line-clamp-3">{card.thread.runtime.lastError}</p>
        </RequestBox>
      ) : null;
    case "limited":
      return <UsageLimitRequest card={card} />;
    case "request":
      return (
        <RequestBox tone="guest">
          <p>
            <T>A guest message is waiting for you to send or dismiss.</T>
          </p>
        </RequestBox>
      );
    case "ready":
      return props.pullRequestUrl === null ? null : (
        <ChecksFailingRequest card={card} threadRef={threadRef} url={props.pullRequestUrl} />
      );
    default:
      return null;
  }
}

// Reading pending requests subscribes to this thread's detail; only Needs-you cards mount this.
function BoardCardPendingRequest(props: { card: BoardCard; threadRef: ScopedThreadRef }) {
  const { card, threadRef } = props;
  const gt = useGT();
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (result: Awaited<ReturnType<typeof respondToApproval>>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not send your answer."));
    }
    setResponding(false);
    return result;
  };

  const approval = card.status === "approval" ? (requests?.approvals[0] ?? null) : null;
  if (approval !== null) {
    const onRespond = async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      if (!canRespond || responding) return;
      setResponding(true);
      setError(null);
      return finish(
        await respondToApproval({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, requestId, decision },
        }),
      );
    };
    return (
      <RequestBox tone="warning" error={error}>
        <p className="line-clamp-2 font-mono text-2xs leading-relaxed">
          {approval.detail || approval.requestKind}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            isResponding={responding}
            canRespond={approval.responseCapability === "live"}
            disabled={!canRespond}
            options={approval.options}
            onRespondToApproval={onRespond}
          />
        </div>
      </RequestBox>
    );
  }

  const userInput = card.status === "input" ? (requests?.userInputs[0] ?? null) : null;
  if (userInput === null) return null;
  const [question] = userInput.questions;
  if (question === undefined) return null;
  // One single-choice question can be answered from the card; anything richer opens the thread.
  const quickAnswer =
    userInput.questions.length === 1 &&
    !question.multiSelect &&
    question.options.length > 0 &&
    userInput.responseCapability !== "not_resumable";
  const answer = async (value: string) => {
    if (!canRespond || responding) return;
    const answers = buildPendingUserInputAnswers(userInput.questions, {
      [question.id]: { selectedOptionValues: [value] },
    });
    if (answers === null) return;
    setResponding(true);
    setError(null);
    finish(
      await respondToUserInput({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId: userInput.requestId, answers },
      }),
    );
  };
  return (
    <RequestBox tone="input" error={error}>
      <p className="line-clamp-3">{question.question}</p>
      {quickAnswer ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <Button
              key={option.value ?? option.label}
              size="xs"
              variant="outline"
              disabled={!canRespond || responding}
              title={option.description}
              onClick={() => void answer(option.value ?? option.label)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
    </RequestBox>
  );
}

function UsageLimitRequest(props: { card: BoardCard }) {
  const resetAt = props.card.thread.runtime?.usageLimitResetAt ?? null;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const m = useMessages();
  return (
    <RequestBox tone="warning">
      <p>
        {resetAt === null ? (
          <T>Usage limit reached.</T>
        ) : (
          <T>
            Usage limit reached. Resets{" "}
            <Var>
              {formatUpcomingTimestamp(
                resetAt,
                timestampFormat,
                Date.parse(`${nowMinute}:00.000Z`),
                undefined,
                m,
              )}
            </Var>
            .
          </T>
        )}
      </p>
    </RequestBox>
  );
}

function ChecksFailingRequest(props: { card: BoardCard; threadRef: ScopedThreadRef; url: string }) {
  const openPullRequest = useOpenPrLink(props.threadRef);
  const link = resolveThreadCurrentPullRequestLink(props.card.thread.pullRequests);
  const failed = link?.watch?.failedChecks ?? [];
  return (
    <RequestBox tone="error">
      {failed.length > 0 ? (
        <p className="line-clamp-2 font-mono text-2xs leading-relaxed">{failed.join(", ")}</p>
      ) : null}
      <div className={cn("flex flex-wrap gap-1.5", failed.length > 0 && "mt-2")}>
        <Button
          size="xs"
          variant="outline"
          onClick={(event: MouseEvent<HTMLButtonElement>) =>
            openPullRequest(event, props.url, props.threadRef)
          }
        >
          <PullRequestGlyph.pullRequest aria-hidden />
          <T>Open pull request</T>
        </Button>
      </div>
    </RequestBox>
  );
}

const REQUEST_TONE_CLASS = {
  warning: "border-warning/25 bg-warning/8",
  input: "border-indigo-500/25 bg-indigo-500/8",
  error: "border-destructive/25 bg-destructive/8",
  guest: "border-guest/25 bg-guest/8",
} as const;

function RequestBox(props: {
  tone: keyof typeof REQUEST_TONE_CLASS;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    // Sits above the card's open button, so clicks here never open the thread.
    <div
      className={cn(
        "relative z-10 rounded-md border px-2.5 py-2 text-xs leading-relaxed text-foreground",
        REQUEST_TONE_CLASS[props.tone],
      )}
    >
      {props.children}
      {props.error ? (
        <p role="alert" className="mt-1.5 text-destructive-foreground">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

function WorkingDuration(props: {
  environmentId: ScopedThreadRef["environmentId"];
  startedAt: string;
}) {
  const nowMs = useNowSecond();
  const m = useMessages();
  const startedMs = Date.parse(props.startedAt);
  if (Number.isNaN(startedMs)) return null;
  return formatWorkingDurationLabel(toServerClock(props.environmentId, nowMs) - startedMs, m);
}

// Subscribes to the minute tick itself, so only the label re-renders each minute.
function BoardRelativeTime(props: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const m = useMessages();
  const parts = formatRelativeTime(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), m);
  if (parts === null) return null;
  return parts.suffix === null ? m(msg("now", { $context: "relative time" })) : parts.value;
}
