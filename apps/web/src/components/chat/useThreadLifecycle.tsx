import { msg, useGT, useMessages } from "gt-react";
import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { Dispatch } from "react";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import {
  isThreadWokeUnseen,
  branchMismatchKey,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  chatActionErrorMessage,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useDeadlinePassed, useNowAfter } from "../../hooks/useDeadline";
import type { usePendingThreadRequests } from "./usePendingThreadRequests";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  effectiveSnoozed,
  isIndefiniteSnooze,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  BACKGROUND_WORK_STOP_RETRY_AFTER_MS,
  type BackgroundWorkStopRequest,
  isBackgroundWorkStopPending,
} from "@t3tools/client-runtime/state/thread-execution";
import { useAcknowledgeThreadWoke, useThreadActions } from "../../hooks/useThreadActions";
import { settleAndAdvance } from "../../settleAndAdvance";
import type { ChatShortcutCommands } from "./useChatShortcuts";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type SetStateAction, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useUiStateStore } from "../../uiStateStore";
import { type ChatMessage } from "../../types";
import { AlarmClockIcon, CheckCircle2Icon } from "lucide-react";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { titleRegenerationToast } from "../threadTitleRegenerationToast";
import { newMessageId } from "~/lib/utils";
import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentScope, useEnvironmentScopeDenied } from "~/state/session";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { isSeatedSeatThread } from "@t3tools/client-runtime/state/thread-group";
import { useChildThreadInputs } from "../../state/entities";
import { ThreadStatusLine } from "./ThreadStatusLine";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  threadTriagePermitted,
  useOrchestrationCommand,
} from "../../state/use-orchestration-command";
import {
  backgroundWorkNowItem,
  childInputNowItem,
  goalNowItem,
  runStopNowItem,
} from "./ThreadActivityBanners";
import { useForceStopThread } from "./useForceStopThread";
import { useAtomValue } from "@effect/atom-react";
import type { RunStopPresentation } from "@t3tools/client-runtime/state/thread-execution";
import { Atom } from "effect/reactivity";
import { environmentThreadDetails } from "../../state/threads";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import { useOpenRelatedThread } from "./useOpenRelatedThread";

function actionErrorMessage(error: unknown): string {
  return errorDisplayMessage(error, m) ?? chatActionErrorMessage(error, m);
}
const NO_RUN_STOP_ATOM = Atom.make<RunStopPresentation | null>(null).pipe(
  Atom.withLabel("web-thread-run-stop:empty"),
);

type PendingThreadRequests = ReturnType<typeof usePendingThreadRequests>;
type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;

interface ThreadLifecycleInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly canOperateThread: boolean;
  readonly clientSettingsHydrated: boolean;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  readonly threadDetailRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly activeThreadShell: EnvironmentThreadShell | null;
  /** The usage-limit recovery banner shows this snooze and its Wake now. */
  readonly limitRecoveryHoldsSnooze: boolean;
  readonly activeLatestRun: EnvironmentThreadShell["latestRun"];
  readonly activeProjectCwd: string | null;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly runtimeMode: RuntimeMode;
  readonly isWorking: boolean;
  /** Also true while the server prepares, starts, or queues a run this client did not send. */
  readonly runIsLive: boolean;
  readonly pendingBackgroundTasks: Parameters<typeof backgroundWorkNowItem>[0]["tasks"];
  readonly turnItems: Parameters<typeof backgroundWorkNowItem>[0]["turnItems"];
  readonly activePendingApproval: PendingThreadRequests["activePendingApproval"];
  readonly activePendingUserInput: PendingThreadRequests["activePendingUserInput"];
  readonly localCheckoutBranchMismatch: {
    readonly threadBranch: string;
    readonly currentBranch: string;
  } | null;
  readonly gitStatusQuery: { readonly refresh: () => void };
  readonly nowMinute: string;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly sendInFlightRef: { current: boolean };
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly clearUsageLimitsFor: (threadKey: string) => void;
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly scrollToEnd: (animated?: boolean) => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Thread state the chat shows and changes outside a normal send: snooze and settle with
 * their status line, the local checkout's branch, background work, child-thread and goal
 * banners, opening related threads, and standalone slash commands.
 */
export function useThreadLifecycle(input: ThreadLifecycleInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    canOperateThread,
    clientSettingsHydrated,
    activeThread,
    activeThreadId,
    activeThreadRef,
    threadDetailRef,
    activeThreadKey,
    activeThreadShell,
    activeLatestRun,
    limitRecoveryHoldsSnooze,
    activeProjectCwd,
    serverConfig,
    runtimeMode,
    isWorking,
    runIsLive,
    pendingBackgroundTasks,
    turnItems,
    activePendingApproval,
    activePendingUserInput,
    localCheckoutBranchMismatch,
    gitStatusQuery,
    nowMinute,
    composerRef,
    composerDraftTarget,
    sendInFlightRef,
    setOptimisticUserMessages,
    setThreadError,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    scrollToEnd,
    persistThreadSettingsForNextTurn,
  } = input;
  const gt = useGT();
  const messages = useMessages();
  const { settleThread, pinThread, confirmAndUnpinThread } = useThreadActions();
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canTriageThread = !useEnvironmentScopeDenied(environmentId, AuthOrchestrationOperateScope);
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const regenerateThreadTitle = useOrchestrationCommand(threadEnvironment.regenerateTitle, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const serverConfigLoaded = serverConfig !== null;
  const activeThreadPinned = serverConfigLoaded && activeThreadShell?.pinnedAt != null;
  // A clock read in render would stay frozen in the compiler's cache, so the
  // snooze checks read a snapshot that moves when the wake time changes or passes.
  const snoozeClock = new Date(
    useNowAfter(Date.parse(activeThreadShell?.snoozedUntil ?? "") || null),
  ).toISOString();
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    serverConfigLoaded &&
    effectiveSnoozed(activeThreadShell, { now: snoozeClock });
  const activeThreadWokeAt =
    activeThreadShell !== null && serverConfigLoaded
      ? threadWokeAt(activeThreadShell, { now: snoozeClock })
      : null;
  const acknowledgeThreadWoke = useAcknowledgeThreadWoke();
  const acknowledgeActiveThreadWoke = () => {
    if (activeThreadRef === null || activeThreadWokeAt === null) return;
    acknowledgeThreadWoke(activeThreadRef, activeThreadWokeAt);
  };
  const acknowledgeActiveThreadWokeStable = useStableCallback(acknowledgeActiveThreadWoke);
  const activeThreadLocalVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadLastVisitedAt = resolveThreadLastVisitedAt(
    activeThreadShell?.lastVisitedAt,
    activeThreadLocalVisitedAt,
  );
  const activeThreadWokeVisible = isThreadWokeUnseen({
    wokeAt: activeThreadWokeAt,
    settled: activeThreadShell?.settledOverride === "settled",
    lastVisitedAt: activeThreadLastVisitedAt,
    latestRunCompletedAt: activeLatestRun?.completedAt ?? null,
  });
  const activeThreadSettled =
    serverConfigLoaded && activeThreadShell?.settledOverride === "settled";
  const unsettleThreadMutation = useOrchestrationCommand(
    threadEnvironment.unsettle,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = async () => {
    if (!activeThreadRef || !threadTriagePermitted(activeThreadRef.environmentId)) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    // Commands settle into a result, so this always runs.
    const result = await unsettleThreadMutation({
      environmentId: activeThreadRef.environmentId,
      input: { threadId: activeThreadRef.threadId, reason: "user" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to un-settle thread")),
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        }),
      );
    }
    setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
  };
  const handleUnsettleActiveThreadStable = useStableCallback(handleUnsettleActiveThread);
  const unsnoozeThreadMutation = useOrchestrationCommand(
    threadEnvironment.unsnooze,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = async () => {
    if (!activeThreadRef || !threadTriagePermitted(activeThreadRef.environmentId)) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    // Commands settle into a result, so this always runs.
    const recovery = activeThreadShell?.limitRecovery;
    const recoveryOwnsSnooze =
      recovery?.snooze === true &&
      recovery.runId === activeThreadShell?.latestRun?.runId &&
      activeThreadShell?.snoozedUntil != null &&
      Date.parse(activeThreadShell.snoozedUntil) === Date.parse(recovery.resetAt);
    const result = recoveryOwnsSnooze
      ? await updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            limitRecovery: { runId: recovery.runId, resetAt: recovery.resetAt, snooze: false },
          },
        })
      : await unsnoozeThreadMutation({
          environmentId: activeThreadRef.environmentId,
          input: { threadId: activeThreadRef.threadId, reason: "user" },
        });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to wake thread")),
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        }),
      );
    }
    setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
  };
  const handleUnsnoozeActiveThreadStable = useStableCallback(handleUnsnoozeActiveThread);
  const [restoringBranchThreadKeys, setRestoringBranchThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isRestoringThreadBranch =
    activeThreadKey !== null && restoringBranchThreadKeys.has(activeThreadKey);
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(composerDraftTarget)),
  );
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  const nextRevealedBranchMismatchKey = showBranchMismatchBanner
    ? activeBranchMismatchKey
    : revealedBranchMismatchKey !== activeBranchMismatchKey
      ? null
      : revealedBranchMismatchKey;
  if (nextRevealedBranchMismatchKey !== revealedBranchMismatchKey) {
    setRevealedBranchMismatchKey(nextRevealedBranchMismatchKey);
  }
  const handleSwitchCheckoutToThread = async () => {
    if (!canWriteSourceControl) return;
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, activeThread.id));
    const finishRestore = () =>
      setRestoringBranchThreadKeys((current) => {
        const next = new Set(current);
        next.delete(threadKey);
        return next;
      });
    setRestoringBranchThreadKeys((current) => new Set(current).add(threadKey));
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      finishRestore();
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Failed to switch checkout")),
            description: actionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
      finishRestore();
      return;
    }
    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        finishRestore();
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: m(msg("Checkout switched, but the thread could not be updated")),
              description: actionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    finishRestore();
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      window.requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const handleSwitchCheckoutToThreadStable = useStableCallback(() => {
    void handleSwitchCheckoutToThread();
  });
  const activeBackgroundTasks = activeThread ? pendingBackgroundTasks : [];
  const [backgroundWorkStops, setBackgroundWorkStops] = useState<
    Record<string, BackgroundWorkStopRequest | undefined>
  >({});
  const backgroundWorkStop = backgroundWorkStops[`${environmentId}:${activeThreadId}`] ?? null;
  const isStoppingBackgroundWork = isBackgroundWorkStopPending(
    backgroundWorkStop,
    `${environmentId}:${activeThreadId}`,
    pendingBackgroundTasks,
    useDeadlinePassed(backgroundWorkStop?.retryAt ?? null),
  );
  const handleStopBackgroundWork = async () => {
    if (
      isStoppingBackgroundWork ||
      !activeThread ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const request: BackgroundWorkStopRequest = {
      threadKey: `${environmentId}:${activeThread.id}`,
      taskIds: pendingBackgroundTasks.map((task) => task.taskId),
      retryAt: null,
    };
    setBackgroundWorkStops((current) => ({ ...current, [request.threadKey]: request }));
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    setBackgroundWorkStops((current) =>
      current[request.threadKey] !== request
        ? current
        : {
            ...current,
            [request.threadKey]:
              result._tag === "Failure"
                ? undefined
                : { ...request, retryAt: Date.now() + BACKGROUND_WORK_STOP_RETRY_AFTER_MS },
          },
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          thrownErrorMessage(error, m) ?? m(msg("Failed to stop background work.")),
        );
      }
    }
  };
  const handleStopBackgroundWorkStable = useStableCallback(handleStopBackgroundWork);
  const onOpenRelatedThread = useOpenRelatedThread({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    panelRef: activeThreadRef,
    parentThreadId: activeThread?.lineage.parentThreadId ?? null,
  });
  const onOpenRelatedThreadStable = useStableCallback(onOpenRelatedThread);
  // A seat's own row already says it is waiting, and it is not a side chat to the user.
  const childThreadInputs = useChildThreadInputs(activeThreadRef).filter(
    (child) => !isSeatedSeatThread(activeThreadShell?.group, child.id),
  );
  const childInputNow = childInputNowItem(
    {
      childThreadInputs,
      parentAwaitingUser: Boolean(
        activePendingApproval || activePendingUserInput || activeThreadShell?.hasPendingUserInput,
      ),
      onOpenThread: onOpenRelatedThreadStable,
    },
    messages,
  );

  const sendStandaloneCommand = async (
    text: string,
    failureMessage: string,
    dispatchMode?: "queue",
  ) => {
    if (!activeThread || !clientSettingsHydrated || sendInFlightRef.current) return;
    const context = composerRef.current?.getSendContext();
    if (!context?.providerAvailable) return;

    const threadId = activeThread.id;
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    sendInFlightRef.current = true;
    beginLocalDispatch();
    setThreadError(threadId, null);
    setOptimisticUserMessages((messages) => [
      ...messages,
      {
        id: messageId,
        role: "user",
        text,
        runId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    ]);
    scrollToEnd();
    // Commands settle into a result, so this always runs.
    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId,
      createdAt,
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
      runtimeMode,
      interactionMode: context.interactionMode,
    });
    const result =
      settingsResult._tag === "Failure"
        ? settingsResult
        : await startThreadTurn({
            environmentId,
            input: {
              threadId,
              message: { messageId, role: "user", text, attachments: [] },
              modelSelection: context.selectedModelSelection,
              runtimeMode,
              interactionMode: context.interactionMode,
              createdAt,
              ...(dispatchMode === undefined ? {} : { dispatchMode }),
            },
          });
    if (result._tag === "Failure") {
      setOptimisticUserMessages((messages) =>
        messages.filter((message) => message.id !== messageId),
      );
      resetLocalDispatch();
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(threadId, thrownErrorMessage(error, m) ?? failureMessage);
      }
    } else {
      clearUsageLimitsFor(routeThreadKey);
    }
    sendInFlightRef.current = false;
  };
  const sendStandaloneCommandStable = useStableCallback(sendStandaloneCommand);
  const activeGoal = activeThreadShell?.goal ?? null;
  const goalNow =
    activeThread && activeGoal !== null
      ? goalNowItem(
          {
            threadId: activeThread.id,
            goal: activeGoal,
            isWorking,
            onSendCommand: sendStandaloneCommandStable,
          },
          messages,
        )
      : null;

  const forceStop = useForceStopThread(environmentId);
  const anyRunStop = useAtomValue(
    threadDetailRef ? environmentThreadDetails.runStopAtom(threadDetailRef) : NO_RUN_STOP_ATOM,
  );
  // A background Stop matters only while that work is still pending.
  const runStop = anyRunStop?.background && activeBackgroundTasks.length === 0 ? null : anyRunStop;
  const runStopNow =
    activeThread && runStop !== null
      ? runStopNowItem({
          threadId: activeThread.id,
          stop: runStop,
          canForceStop: forceStop.canForceStop,
          forceStopping: forceStop.stoppingThreadId === activeThread.id,
          onForceStop: () => void forceStop.forceStopThread(activeThread.id, runStop.runId),
        })
      : null;
  const backgroundWorkNow = activeThread
    ? backgroundWorkNowItem(
        {
          environmentId,
          threadId: activeThread.id,
          tasks: activeBackgroundTasks,
          turnItems,
          // Interrupt stops the active run first, not this work; the composer owns that Stop.
          stopDisabled: runIsLive || !canOperateThread || isStoppingBackgroundWork,
          stopping: isStoppingBackgroundWork,
          onStop: handleStopBackgroundWorkStable,
          onOpenThread: onOpenRelatedThreadStable,
        },
        messages,
      )
    : null;
  // The relative times read the clock; nowMinute re-renders them on the minute.
  const snoozedUntil = activeThreadShell?.snoozedUntil ?? null;
  const settledAt = activeThreadShell?.settledAt ?? null;
  // Same rounding as the sidebar's snoozed shelf, so both read the same hour.
  const snoozeNow = `${nowMinute}:00.000Z`;
  const snoozeWake =
    snoozedUntil &&
    !isIndefiniteSnooze(snoozedUntil) &&
    Date.parse(snoozedUntil) > Date.parse(snoozeNow)
      ? snoozeWakeLabel(snoozedUntil, { now: snoozeNow }, messages)
      : null;
  const threadStatusLine = activeThreadSnoozed ? (
    limitRecoveryHoldsSnooze ? null : (
      <ThreadStatusLine
        icon={<AlarmClockIcon />}
        label={
          snoozeWake
            ? gt("Snoozed, {remaining} left", { remaining: snoozeWake })
            : gt("Snoozed", { $context: "thread status" })
        }
        clockMinute={nowMinute}
        actionLabel={isUnsnoozing ? gt("Waking...") : gt("Wake now")}
        actionDisabled={!canTriageThread || isUnsnoozing}
        onAction={() => void handleUnsnoozeActiveThreadStable()}
      />
    )
  ) : activeThreadSettled ? (
    <ThreadStatusLine
      icon={<CheckCircle2Icon />}
      label={
        settledAt
          ? gt("Settled {time}", { time: formatRelativeTimeLabel(settledAt, undefined, messages) })
          : gt("Settled", { $context: "thread status" })
      }
      clockMinute={nowMinute}
      actionLabel={isUnsettling ? gt("Un-settling...") : gt("Un-settle")}
      actionDisabled={!canTriageThread || isUnsettling}
      onAction={() => void handleUnsettleActiveThreadStable()}
    />
  ) : activeThreadWokeVisible ? (
    <ThreadStatusLine
      icon={<AlarmClockIcon />}
      label={gt("Woke from snooze")}
      actionLabel={gt("Dismiss")}
      onAction={acknowledgeActiveThreadWokeStable}
    />
  ) : null;
  const toastThreadActionFailure =
    (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        }),
      );
    };
  const shortcuts = {
    "thread.settle": () => {
      if (!threadTriagePermitted(environmentId)) return false;
      if (!activeThreadShell || !activeThreadRef || !serverConfigLoaded) return;
      if (activeThreadSettled) {
        void handleUnsettleActiveThread();
        return;
      }
      if (settleAndAdvance(activeThreadRef)) return;
      void settleThread(activeThreadRef).then(
        toastThreadActionFailure(m(msg("Failed to settle thread"))),
      );
    },
    "thread.pin": ({ event }) => {
      // An open project list pins its highlighted project with this key instead.
      if (
        event.target instanceof Element &&
        event.target.closest('[role="combobox"][aria-expanded="true"]') !== null
      ) {
        return false;
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
      if (!activeThreadShell || !activeThreadRef || !serverConfigLoaded) return;
      void (
        activeThreadPinned ? confirmAndUnpinThread(activeThreadRef) : pinThread(activeThreadRef)
      ).then(
        toastThreadActionFailure(
          activeThreadPinned ? m(msg("Failed to unpin thread")) : m(msg("Failed to pin thread")),
        ),
      );
    },
    "thread.regenerateTitle": () => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
      if (!activeThreadShell || !activeThreadRef || !serverConfigLoaded) return;
      if (activeThreadShell.titleRegeneration != null) return;
      void regenerateThreadTitle({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId },
      }).then((result) => {
        const toast = titleRegenerationToast([result]);
        if (toast) toastManager.add(toast);
      });
    },
  } satisfies ChatShortcutCommands;
  return {
    shortcuts,
    acknowledgeActiveThreadWoke,
    activeBranchMismatchKey,
    // A Stop that went unanswered needs the user; one in progress is the thread's work.
    attentionNow: runStop?.state === "unresponsive" ? runStopNow : childInputNow,
    workNow: runStop?.state === "stopping" ? runStopNow : backgroundWorkNow,
    childInputNow,
    goalNow,
    handleSwitchCheckoutToThread,
    handleSwitchCheckoutToThreadStable,
    isRestoringThreadBranch,
    onOpenRelatedThread,
    onOpenRelatedThreadStable,
    sendStandaloneCommand,
    setBranchMismatchDismissTick,
    showBranchMismatchBanner,
    threadStatusLine,
  };
}
