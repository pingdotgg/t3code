import {
  type ApprovalRequestId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type OrchestrationSessionStatus,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  type PendingApproval,
  type PendingUserInput,
} from "../../session-logic.ts";
import { useEnvironmentSettings } from "../../hooks/useSettings.ts";
import { newMessageId } from "../../lib/utils.ts";
import { primaryServerKeybindingsAtom } from "../../state/server.ts";
import { useProject, useServerConfigs } from "../../state/entities.ts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SessionPhase,
  type SidebarThreadSummary,
  type Thread,
} from "../../types.ts";
import {
  deriveLockedProvider,
  buildThreadTurnInterruptInput,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  resolveThreadMetadataUpdateForNextTurn,
} from "../ChatView.logic.ts";
import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore.ts";
import { resolveAppModelSelectionForInstance } from "../../modelSelection.ts";
import type { TerminalContextDraft } from "../../lib/terminalContext.ts";
import type { ElementContextDraft } from "../../lib/elementContext.ts";
import type { ChatComposerProps } from "./ChatComposer.tsx";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";
import { toastManager } from "../ui/toast.tsx";

// Hoisted so `thread?.activities ?? []` doesn't allocate a fresh array (and
// bust the memos keyed on it) on every render when a thread has no activities.
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS = {} as const;

// Board composer never surfaces inline approvals/user-input prompts (that UI
// lives on the route only), so these are always-empty by construction. Hoisted
// so `ChatComposer`'s `memo` sees a stable reference for them across renders.
const EMPTY_PENDING_APPROVALS: PendingApproval[] = [];
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_RESPONDING_REQUEST_IDS: ApprovalRequestId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProvider[] = [];
// Shared no-op for the handful of board composer callbacks that are inert
// (plan sidebar, focus scheduling, etc. don't apply to embedded cards). A
// zero-arg function is structurally assignable to every callback prop type
// below regardless of its arity, so one constant covers all of them.
const NOOP = () => {};

export type ThreadComposerSurface = "route" | "board";

export function resolveBoardComposerSubmission(input: {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly prompt: string;
  readonly imageCount: number;
}): { readonly text: string } | null {
  if (input.sessionStatus === "starting" || input.sessionStatus === "running") {
    return null;
  }
  const text = input.prompt.trim();
  if (text.length === 0 && input.imageCount === 0) return null;
  return { text };
}

export function canBeginBoardComposerSend(
  connection: EnvironmentConnectionPresentation,
  sendInFlight: boolean,
): boolean {
  return connection.phase === "connected" && !sendInFlight;
}

export function resolveBoardComposerModelSelection(
  draft: {
    readonly activeProvider: ProviderInstanceId | null;
    readonly modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  },
  fallback: ModelSelection,
): ModelSelection {
  return (draft.activeProvider && draft.modelSelectionByProvider[draft.activeProvider]) || fallback;
}

export function useThreadComposerRouteState(thread: Thread | null | undefined) {
  const threadActivities = thread?.activities ?? EMPTY_ACTIVITIES;
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const phase = derivePhase(thread?.session ?? null);
  return {
    pendingApprovals,
    pendingUserInputs,
    phase,
    activePendingApproval: pendingApprovals[0] ?? null,
    activePendingUserInput: pendingUserInputs[0] ?? null,
  };
}

export type UseBoardThreadComposerInput = {
  readonly threadRef: ScopedThreadRef;
  readonly thread: Thread | null | undefined;
  readonly summary: SidebarThreadSummary;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly resolvedTheme: "light" | "dark";
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
};

export function useBoardThreadComposer(input: UseBoardThreadComposerInput) {
  const {
    threadRef,
    thread,
    summary,
    environmentLabel,
    environmentConnection,
    resolvedTheme,
    onExpandImage,
  } = input;
  const environmentId = threadRef.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfigs = useServerConfigs();

  const composerRef = useRef<import("./ChatComposer.tsx").ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  // Board composer doesn't support inline terminal/element context chips, so
  // these start empty; typed explicitly rather than inferred as `never[]` to
  // match what ChatComposerProps expects. Each card gets its own array — a
  // ref is a mutable cell, so seeding several from one shared array would let
  // a future in-place write leak across every card on the board.
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, []);

  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });

  const providerStatuses = useMemo<ServerProvider[]>(
    () => [...(serverConfigs.get(environmentId)?.providers ?? EMPTY_PROVIDER_STATUSES)],
    [environmentId, serverConfigs],
  );

  const project = useProject(scopeProjectRef(summary.environmentId, summary.projectId));
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: summary.worktreePath ?? null,
      })
    : null;

  const lockedProvider = deriveLockedProvider({
    thread,
    selectedProvider: null,
    threadProvider: summary.modelSelection.instanceId,
  });

  const phase: SessionPhase = derivePhase(summary.session ?? null);
  const isConnecting = phase === "connecting";
  const sendInFlightRef = useRef(false);
  const [isSendBusy, setIsSendBusy] = useState(false);

  const runtimeMode = summary.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = summary.interactionMode ?? DEFAULT_INTERACTION_MODE;

  const onSend = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      if (!canBeginBoardComposerSend(environmentConnection, sendInFlightRef.current)) return;

      sendInFlightRef.current = true;
      setIsSendBusy(true);
      try {
        const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
        if (!draft) return;
        const submission = resolveBoardComposerSubmission({
          sessionStatus: summary.session?.status ?? null,
          prompt: draft.prompt,
          imageCount: draft.images.length,
        });
        if (submission === null) return;
        const requestedModelSelection = resolveBoardComposerModelSelection(
          draft,
          summary.modelSelection,
        );
        const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
          providers: providerStatuses,
          hasStartedSession: summary.session !== null,
          currentModelSelection: summary.modelSelection,
          currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
          nextModelSelection: requestedModelSelection,
        });
        const modelSelection = modelChangeBlockReason
          ? summary.modelSelection
          : requestedModelSelection;
        const attachments = await Promise.all(
          draft.images.map(async (image) => ({
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          })),
        );
        const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
          currentModelSelection: summary.modelSelection,
          nextModelSelection: modelSelection,
          currentBranch: summary.branch,
        });
        if (metadataUpdate !== null) {
          const metadataResult = await updateThreadMetadata({
            environmentId,
            input: {
              threadId: threadRef.threadId,
              ...metadataUpdate,
            },
          });
          if (metadataResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(metadataResult)) {
              console.error(squashAtomCommandFailure(metadataResult));
            }
            return;
          }
        }
        const result = await startThreadTurn({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: submission.text,
              attachments,
            },
            modelSelection,
            titleSeed: summary.title,
            runtimeMode: summary.runtimeMode,
            interactionMode: summary.interactionMode,
            createdAt: new Date().toISOString(),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            console.error(squashAtomCommandFailure(result));
          }
          return;
        }
        useComposerDraftStore.getState().clearComposerContent(threadRef);
        composerRef.current?.resetCursorState();
      } finally {
        sendInFlightRef.current = false;
        setIsSendBusy(false);
      }
    },
    [
      environmentConnection.phase,
      environmentId,
      providerStatuses,
      startThreadTurn,
      summary,
      threadRef,
      updateThreadMetadata,
    ],
  );

  const onInterrupt = useCallback(async () => {
    await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(summary),
    });
  }, [environmentId, interruptThreadTurn, summary]);

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      await respondToThreadApproval({
        environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
    },
    [environmentId, respondToThreadApproval, threadRef],
  );

  const setComposerDraftModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        focusComposer();
        return;
      }
      if (lockedProvider !== null && summary.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === summary.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          focusComposer();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        focusComposer();
        return;
      }
      const nextModelSelection: ModelSelection = { instanceId, model: resolvedModel };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: summary.session !== null,
        currentModelSelection: summary.modelSelection,
        currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        focusComposer();
        return;
      }
      setComposerDraftModelSelection(threadRef, nextModelSelection);
      focusComposer();
    },
    [
      focusComposer,
      lockedProvider,
      providerStatuses,
      setComposerDraftModelSelection,
      settings,
      summary,
      threadRef,
    ],
  );

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: summary.session !== null,
        currentModelSelection: summary.modelSelection,
        currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [providerStatuses, summary],
  );

  const toggleInteractionMode = useCallback(() => {
    const next: ProviderInteractionMode =
      interactionMode === "plan" ? DEFAULT_INTERACTION_MODE : "plan";
    void setThreadInteractionMode({
      environmentId,
      input: { threadId: threadRef.threadId, interactionMode: next },
    });
  }, [environmentId, interactionMode, setThreadInteractionMode, threadRef]);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      void setThreadRuntimeMode({
        environmentId,
        input: { threadId: threadRef.threadId, runtimeMode: mode },
      });
    },
    [environmentId, setThreadRuntimeMode, threadRef],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      void setThreadInteractionMode({
        environmentId,
        input: { threadId: threadRef.threadId, interactionMode: mode },
      });
    },
    [environmentId, setThreadInteractionMode, threadRef],
  );

  // `ChatComposer` is wrapped in `React.memo`, and a board renders one live
  // instance of it per card, so this object must not be rebuilt on every
  // render — that would hand every field a fresh reference and defeat the
  // memo for every card on every board tick. Deps list only values that can
  // actually vary; the ~30 always-empty/no-op fields above are inlined here
  // straight from module-level constants so recomputation (when it does
  // happen) doesn't reallocate them either.
  const chatComposerProps = useMemo<ChatComposerProps>(
    () => ({
      composerRef,
      composerDraftTarget: threadRef,
      environmentId,
      routeKind: "server",
      routeThreadRef: threadRef,
      draftId: null,
      activeThreadId: summary.id,
      activeThreadEnvironmentId: environmentId,
      activeThread: thread ?? undefined,
      isServerThread: true,
      isLocalDraftThread: false,
      forceExpandedOnMobile: false,
      projectSelectionRequired: false,
      phase,
      isConnecting,
      isSendBusy,
      // Board cards mount their own timeline rather than the route's thread
      // detail, so there is no loading gate to report here.
      sendDisabledReason: null,
      isPreparingWorktree: false,
      environmentUnavailable:
        environmentConnection.phase === "connected"
          ? null
          : { label: environmentLabel, connection: environmentConnection },
      activePendingApproval: null,
      pendingApprovals: EMPTY_PENDING_APPROVALS,
      pendingUserInputs: EMPTY_PENDING_USER_INPUTS,
      activePendingProgress: null,
      activePendingResolvedAnswers: null,
      activePendingIsResponding: false,
      activePendingDraftAnswers: EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS,
      activePendingQuestionIndex: 0,
      respondingRequestIds: EMPTY_RESPONDING_REQUEST_IDS,
      showPlanFollowUpPrompt: false,
      activeProposedPlan: null,
      activePlan: null,
      sidebarProposedPlan: null,
      planSidebarLabel: "",
      planSidebarOpen: false,
      runtimeMode,
      interactionMode,
      lockedProvider,
      providerStatuses,
      activeProjectDefaultModelSelection: project?.defaultModelSelection,
      activeThreadModelSelection: summary.modelSelection,
      activeThreadActivities: thread?.activities,
      resolvedTheme,
      settings,
      keybindings,
      terminalOpen: false,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      onSend,
      onInterrupt,
      onImplementPlanInNewThread: NOOP,
      onRespondToApproval,
      onSelectActivePendingUserInputOption: NOOP,
      onAdvanceActivePendingUserInput: NOOP,
      onPreviousActivePendingUserInputQuestion: NOOP,
      onChangeActivePendingUserInputCustomAnswer: NOOP,
      onProviderModelSelect,
      getModelDisabledReason,
      toggleInteractionMode,
      handleRuntimeModeChange,
      handleInteractionModeChange,
      togglePlanSidebar: NOOP,
      focusComposer,
      scheduleComposerFocus: focusComposer,
      setThreadError: NOOP,
      onExpandImage,
      density: "compact",
    }),
    [
      composerRef,
      threadRef,
      environmentId,
      thread,
      phase,
      isConnecting,
      isSendBusy,
      environmentConnection,
      environmentLabel,
      runtimeMode,
      interactionMode,
      lockedProvider,
      providerStatuses,
      project,
      summary,
      resolvedTheme,
      settings,
      keybindings,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      onSend,
      onInterrupt,
      onRespondToApproval,
      onProviderModelSelect,
      getModelDisabledReason,
      toggleInteractionMode,
      handleRuntimeModeChange,
      handleInteractionModeChange,
      focusComposer,
      onExpandImage,
    ],
  );

  return { chatComposerProps, composerRef };
}
