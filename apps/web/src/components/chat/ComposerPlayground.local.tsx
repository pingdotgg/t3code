import { OrchestrationProposedPlanId, ApprovalRequestId } from "@t3tools/contracts";
import { GitBranchIcon, InfoIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { usePromptStashStore } from "../../promptStashStore";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { Button } from "../ui/button";
import type { ChatComposerProps } from "./ChatComposer";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerServerUpdateIcon, ComposerServerUpdateStatus } from "./ComposerServerUpdateStatus";
import type { ComposerTaskStep } from "./ComposerTasksBadge";

// Local review fixtures only. Actions never update the server or switch a checkout.
export const BANNER_PLAYGROUND_CASES = [
  ["working-tasks", "01 Working with tasks"],
  ["working-without-tasks", "02 Working without tasks"],
  ["completed-tasks", "03 Completed tasks"],
  ["long-tasks-stash", "04 Long tasks and stash"],
  ["update-idle", "05 Update while idle"],
  ["update-tasks", "06 Update with running tasks"],
  ["update-without-tasks", "07 Update during a turn"],
  ["stack-tasks", "08 Multiple notices during a turn"],
  ["stack-idle", "09 Multiple notices while idle"],
  ["updating-tasks", "10 Update in progress during a turn"],
  ["update-failed-tasks", "11 Failed update during a turn"],
  ["restarting", "12 Server restarting"],
  ["loading-tasks-update", "13 Loading hides tasks"],
  ["syncing-tasks-update", "14 Syncing hides tasks"],
  ["loading-without-tasks", "15 Loading without tasks"],
  ["syncing-without-tasks", "16 Syncing without tasks"],
  ["background-working", "17 Background work after a turn"],
  ["monitoring-update", "18 Monitoring with an update"],
  ["approval", "19 Command approval"],
  ["approval-update", "20 Approval and update notice"],
  ["plan", "21 Plan ready to implement"],
  ["question", "22 Questions and choices"],
  ["connection-error", "23 Connection error"],
  ["manual-update", "24 Manual server update"],
  ["desktop-update", "25 Desktop server update"],
  ["idle-stash", "26 Idle with stash"],
  ["thinking", "27 Thinking before the first response"],
  ["short-tasks", "28 Short turn with timeline timer and tasks"],
  ["short-without-tasks-update", "29 Short turn with timer and update"],
] as const;

const startedAt = new Date(Date.now() - 13 * 60_000).toISOString();
const shortSteps: readonly ComposerTaskStep[] = [
  { step: "Inspect activity grouping and running status", status: "completed" },
  { step: "Verify the restored activity grouping and composer banners", status: "inProgress" },
  { step: "Verify task expansion, scrolling, and completion", status: "pending" },
];

export function useComposerPlayground(original: ChatComposerProps): ChatComposerProps {
  const threadId = original.activeThreadId;
  const reviewCase = import.meta.env.DEV
    ? new URLSearchParams(location.search).get("reviewCase")
    : null;
  const scenario =
    import.meta.env.DEV && threadId?.startsWith("banner-playground-")
      ? (reviewCase ?? threadId.slice("banner-playground-".length))
      : null;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const [updating, setUpdating] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);

  useEffect(() => {
    if (!scenario?.includes("stash")) return;
    const store = usePromptStashStore.getState();
    for (const [index, prompt] of [
      "Check narrow composer spacing after the task list finishes.",
      "Review tasks and stash together, then clear the last stashed draft.",
    ].entries()) {
      const id = `banner-playground-stash-${index}`;
      if (!store.entries.some((entry) => entry.id === id)) {
        store.stashEntry({
          id,
          prompt,
          createdAt: startedAt,
          attachments: [],
          droppedImageNames: [],
        });
      }
    }
  }, [scenario]);

  if (!scenario || !threadId) return original;
  const dismiss = (key: string) => setDismissed((previous) => new Set([...previous, key]));
  const stop = () => setStopped((previous) => new Set([...previous, threadId]));
  const ended = stopped.has(threadId);
  const items: ComposerBannerStackItem[] = [];
  const updateId = `${threadId}:update`;
  const isUpdating =
    scenario.startsWith("updating") || scenario === "restarting" || updating.has(updateId);
  const failed = scenario.includes("failed") && !isUpdating;
  if (/update|updating|restarting|stack/.test(scenario) && !dismissed.has(updateId)) {
    items.push({
      id: updateId,
      variant: failed ? "error" : "default",
      priority: isUpdating ? "urgent" : "notice",
      icon: (
        <ComposerServerUpdateIcon status={failed ? "failed" : isUpdating ? "running" : "idle"} />
      ),
      title:
        isUpdating || failed ? (
          <ComposerServerUpdateStatus
            state={
              failed
                ? {
                    status: "failed",
                    stage: "downloading",
                    fromVersion: "0.0.35",
                    targetVersion: "0.0.36",
                    message: "Download failed. The server is still running the previous version.",
                  }
                : {
                    status: "running",
                    stage: scenario === "restarting" ? "resuming" : "downloading",
                    fromVersion: "0.0.35",
                    targetVersion: "0.0.36",
                  }
            }
          />
        ) : (
          "Server update available"
        ),
      description:
        scenario === "desktop-update"
          ? "Update the desktop app on that machine to update this server."
          : undefined,
      actions:
        !isUpdating && scenario !== "desktop-update" ? (
          <Button
            size="xs"
            onClick={() => {
              if (scenario === "manual-update") dismiss(updateId);
              else setUpdating((previous) => new Set([...previous, updateId]));
            }}
          >
            {failed ? "Retry" : scenario === "manual-update" ? "Copy update command" : "Update"}
          </Button>
        ) : undefined,
      ...(!isUpdating
        ? { dismissLabel: "Dismiss update notice", onDismiss: () => dismiss(updateId) }
        : {}),
    });
  }
  if (scenario.includes("stack")) {
    items.push(
      {
        id: `${threadId}:branch`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: "Branch changed. Previously main",
        actions: (
          <Button size="xs" variant="ghost" onClick={() => dismiss(`${threadId}:branch`)}>
            Restore branch
          </Button>
        ),
        onDismiss: () => dismiss(`${threadId}:branch`),
        dismissLabel: "Dismiss branch change notice",
      },
      {
        id: `${threadId}:resumed`,
        variant: "default",
        icon: <InfoIcon />,
        title: "Thread resumed after being snoozed",
        onDismiss: () => dismiss(`${threadId}:resumed`),
        dismissLabel: "Dismiss resumed thread notice",
      },
    );
  }
  if (scenario === "connection-error" && !ended) {
    items.push({
      id: `${threadId}:connection`,
      variant: "error",
      icon: <WifiOffIcon />,
      title: "Review server: connection lost",
      description:
        "The server is unreachable. Reconnect this environment before sending messages or running actions.",
      actions: (
        <Button size="xs" onClick={stop}>
          Reconnect
        </Button>
      ),
    });
  }
  if ((scenario === "background-working" || scenario.includes("monitoring")) && !ended) {
    items.push({
      id: `${threadId}:background`,
      variant: "default",
      priority: "activity",
      icon: <span className="size-1.5 rounded-full bg-muted-foreground" />,
      title: scenario === "background-working" ? "Background work" : "Monitoring",
      actions: (
        <Button size="xs" variant="ghost" onClick={stop}>
          Stop
        </Button>
      ),
    });
  }
  if (scenario === "readonly-stack") {
    items.splice(
      0,
      items.length,
      {
        id: "front",
        variant: "default",
        priority: "activity",
        icon: <InfoIcon />,
        title: "Monitoring",
      },
      {
        id: "progress",
        variant: "default",
        icon: <InfoIcon />,
        title: "Finishing background work",
      },
    );
  }
  const bannerItems = items.filter((item) => !dismissed.has(item.id));

  const syncPhase = scenario.startsWith("loading")
    ? "loading"
    : scenario.startsWith("syncing")
      ? "syncing"
      : null;
  // Supply stale task data so loading and syncing can verify that it stays hidden.
  // Every other case uses the real turn's task state, including completion.
  const staleSteps =
    (syncPhase || (reviewCase?.includes("tasks") && !reviewCase.includes("without-tasks"))) &&
    !scenario.includes("without-tasks")
      ? shortSteps
      : null;
  const props: ChatComposerProps = {
    ...original,
    ...(reviewCase
      ? {
          environmentUnavailable: null,
          isConnecting: false,
          isSendBusy: false,
          sendDisabledReason: null,
          onSend: () => {},
          onInterrupt: stop,
        }
      : {}),
    bannerItems,
    threadSyncPhase: syncPhase,
    activeTasksProgress: staleSteps
      ? {
          step: staleSteps.find((step) => step.status === "inProgress")!.step,
          completedSteps: staleSteps.filter((step) => step.status === "completed").length,
          totalSteps: staleSteps.length,
        }
      : reviewCase
        ? null
        : original.activeTasksProgress,
    activeTaskSteps: staleSteps ?? (reviewCase ? null : original.activeTaskSteps),
    onImplementPlanInNewThread: stop,
  };
  if (scenario.startsWith("approval") && !ended) {
    const approval = {
      requestId: ApprovalRequestId.make("banner-playground-approval"),
      requestKind: "command" as const,
      createdAt: startedAt,
      detail: "git diff --stat",
    };
    props.activePendingApproval = approval;
    props.pendingApprovals = [approval];
    props.onRespondToApproval = async () => {
      stop();
    };
  }
  if (scenario === "plan" && !ended) {
    props.showPlanFollowUpPrompt = true;
    props.activeProposedPlan = {
      id: OrchestrationProposedPlanId.make("banner-playground-plan"),
      createdAt: startedAt,
      updatedAt: startedAt,
      turnId: null,
      implementedAt: null,
      implementationThreadId: null,
      planMarkdown: "# Unify composer banner layout\n\nReview tasks, stash, and update states.",
    };
  }
  if (scenario === "question" && !ended) {
    const questions = [
      {
        id: "approach",
        header: "Approach",
        question: "Which part should we verify first?",
        multiSelect: false,
        options: [
          { label: "Notice states", description: "Updates, failures, and stacked notices." },
          { label: "Task states", description: "Running, expanded, and completed tasks." },
        ],
      },
      {
        id: "screen",
        header: "Screen size",
        question: "Which screen size should we check?",
        multiSelect: false,
        options: [
          { label: "Desktop", description: "Wide composer with inline actions." },
          { label: "Narrow", description: "Compact composer with wrapping actions." },
        ],
      },
    ];
    const question = questions[questionIndex] ?? questions[0]!;
    props.pendingUserInputs = [
      {
        requestId: ApprovalRequestId.make("banner-playground-question"),
        createdAt: startedAt,
        questions,
      },
    ];
    props.activePendingQuestionIndex = questionIndex;
    props.activePendingDraftAnswers = answers;
    props.activePendingProgress = {
      questionIndex,
      isLastQuestion: questionIndex === 1,
      canAdvance: Boolean(
        answers[question.id]?.selectedOptionLabels?.length || answers[question.id]?.customAnswer,
      ),
      customAnswer: answers[question.id]?.customAnswer ?? "",
      activeQuestion: question,
    };
    props.onSelectActivePendingUserInputOption = (id, label) =>
      setAnswers((previous) => ({ ...previous, [id]: { selectedOptionLabels: [label] } }));
    props.onChangeActivePendingUserInputCustomAnswer = (id, value) =>
      setAnswers((previous) => ({ ...previous, [id]: { customAnswer: value } }));
    props.onAdvanceActivePendingUserInput = () => {
      if (questionIndex === 1) stop();
      else setQuestionIndex(1);
    };
    props.onPreviousActivePendingUserInputQuestion = () => setQuestionIndex(0);
  }
  return props;
}
