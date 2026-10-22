import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ThreadId,
  type UserInputAttachments,
} from "@t3tools/contracts";
import {
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { getUploadedAttachments, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  pendingUserInputRequestKey,
  pruneResolvedUserInputDrafts,
  setPendingUserInputCustomAnswer,
  threadContextsReferencedByAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  clearQuestionAttachmentDraft,
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingUserInput,
} from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatComposerHandle } from "./ChatComposer";

const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const usePendingUserInputAnswers = create<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>(() => ({}));
const usePendingUserInputQuestionIndex = create<Record<string, number>>(() => ({}));
const NO_PENDING_REQUESTS = { approvals: [], userInputs: [] } as const;
const NO_PENDING_APPROVALS: ReturnType<typeof derivePendingApprovals> = [];
const NO_PENDING_USER_INPUTS: ReturnType<typeof derivePendingUserInputs> = [];

/** Writes the custom answer for a question of the pending user input the making render saw. */
function makePendingCustomAnswerSetter(input: {
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingRequestKey: string;
  readonly writePrompt: (prompt: string) => void;
  readonly setPendingUserInputAnswersByRequestId: (
    update: SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>,
  ) => void;
}) {
  return (questionId: string, value: string) => {
    const { activePendingUserInput, activePendingRequestKey } = input;
    if (!activePendingUserInput) {
      return;
    }
    const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
    if (!question || question.allowCustomAnswer === false) {
      return;
    }
    input.writePrompt(value);
    input.setPendingUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingRequestKey]: {
        ...existing[activePendingRequestKey],
        [questionId]: setPendingUserInputCustomAnswer(
          existing[activePendingRequestKey]?.[questionId],
          value,
          question,
        ),
      },
    }));
    // The editor owns this selection. Resetting it before the answer renders
    // can re-enter Lexical with offsets from the previous skill token.
  };
}

/**
 * Pending approvals and user-input questions for the active thread: what is
 * waiting, the user's in-progress answers, and the commands that respond.
 */
export function usePendingThreadRequests(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly activeThread: { readonly id: ThreadId } | undefined;
  readonly serverProjection: ThreadStructure | null;
  readonly supportsQuestionAttachments: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly setComposerDraftPrompt: (target: ScopedThreadRef | DraftId, prompt: string) => void;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
}) {
  const {
    environmentId,
    activeThreadId,
    activeThread,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError,
  } = input;
  const respondToThreadApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissThreadUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    RuntimeRequestId[]
  >([]);
  const setPendingUserInputAnswersByRequestId = usePendingUserInputAnswers.setState;
  const setPendingUserInputQuestionIndexByRequestId = usePendingUserInputQuestionIndex.setState;
  const projectedThreadId = serverProjection?.thread.id;
  const pendingRequests =
    serverProjection !== null && serverProjection.thread.id === activeThreadId
      ? derivePendingThreadRequests(serverProjection)
      : NO_PENDING_REQUESTS;
  // The projection changes on every streamed event, so shared empties keep the
  // composer and approval panel from re-rendering while nothing is pending.
  const pendingApprovals =
    pendingRequests.approvals.length === 0
      ? NO_PENDING_APPROVALS
      : derivePendingApprovals(pendingRequests.approvals);
  const pendingUserInputs =
    pendingRequests.userInputs.length === 0
      ? NO_PENDING_USER_INPUTS
      : derivePendingUserInputs(pendingRequests.userInputs);
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingRequestKey = pendingUserInputRequestKey(
    environmentId,
    activeThreadId,
    activePendingUserInput?.requestId,
  );
  const activePendingAnswerDrafts = usePendingUserInputAnswers(
    (state) => state[activePendingRequestKey] ?? EMPTY_PENDING_USER_INPUT_ANSWERS,
  );
  const activePendingQuestionIndex = usePendingUserInputQuestionIndex(
    (state) => state[activePendingRequestKey] ?? 0,
  );
  useLayoutEffect(() => {
    if (!activePendingUserInput) return;
    usePendingUserInputAnswers.setState((existing) => {
      const drafts = existing[activePendingRequestKey] ?? EMPTY_PENDING_USER_INPUT_ANSWERS;
      const seeded = seedUserInputDraftAnswers(activePendingUserInput.questions, drafts);
      return seeded === drafts ? existing : { ...existing, [activePendingRequestKey]: seeded };
    });
  }, [activePendingRequestKey, activePendingUserInput]);
  const pendingQuestionDraftKeys = activeThreadId
    ? pendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(environmentId, activeThreadId, request.requestId, question.id),
        ),
      )
    : [];
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => [key, state.draftsByThreadKey[key]]),
      ),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some((attachment) => {
              const upload = state.uploadsByImageId[attachment.id];
              return upload?.status !== "ready" || upload.environmentId !== environmentId;
            }),
          ];
        }),
      ),
    ),
  );
  const questionPreparations = useQuestionAttachmentPreparation(
    useShallow((state) =>
      Object.fromEntries(pendingQuestionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  useEffect(() => {
    // A thread shell can arrive before its requests; missing detail is not resolution.
    if (!activeThread || projectedThreadId !== activeThread.id) return;
    const questionThread = activeThread;
    const currentRequests = pendingUserInputs;
    const pendingRequestIds = currentRequests.map((request) => request.requestId);
    usePendingUserInputAnswers.setState(
      (existing) =>
        pruneResolvedUserInputDrafts(existing, environmentId, questionThread.id, pendingRequestIds),
      true,
    );
    usePendingUserInputQuestionIndex.setState(
      (existing) =>
        pruneResolvedUserInputDrafts(existing, environmentId, questionThread.id, pendingRequestIds),
      true,
    );
    const prefix = questionAttachmentDraftPrefix(environmentId, questionThread.id);
    const retained = new Set(
      currentRequests.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(
            environmentId,
            questionThread.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const keys = new Set([
      ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
      ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix) && !retained.has(DraftId.make(key)))
        clearQuestionAttachmentDraft(DraftId.make(key));
    }
  }, [environmentId, activeThread, projectedThreadId, pendingUserInputs]);
  const activePendingDraftAnswers =
    !activePendingUserInput || !activeThreadId
      ? EMPTY_PENDING_USER_INPUT_ANSWERS
      : Object.fromEntries(
          activePendingUserInput.questions.map((question) => {
            const key = questionAttachmentDraftId(
              environmentId,
              activeThreadId,
              activePendingUserInput.requestId,
              question.id,
            );
            const draft = questionComposerDrafts[key];
            const attachments = draft ? [...draft.images, ...draft.files] : [];
            return [
              question.id,
              {
                ...activePendingAnswerDrafts[question.id],
                attachmentCount: attachments.length,
                attachmentsBlocked:
                  (attachments.length > 0 && !supportsQuestionAttachments) ||
                  (questionPreparations[key] ?? 0) > 0 ||
                  questionUploadsBlocked[key] === true,
              },
            ];
          }),
        );
  const activePendingProgress = activePendingUserInput
    ? derivePendingUserInputProgress(
        activePendingUserInput.questions,
        activePendingDraftAnswers,
        activePendingQuestionIndex,
      )
    : null;
  const activePendingResolvedAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
    : null;
  const activePendingIsResponding = activePendingUserInput
    ? activePendingUserInput.responseCapability === "not_resumable" ||
      respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activePendingApproval = pendingApprovals[0] ?? null;

  const onRespondToApproval = async (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    if (
      pendingApprovals.find((approval) => approval.requestId === requestId)?.responseCapability !==
      "live"
    )
      return;

    setRespondingRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const result = await respondToThreadApproval({
      environmentId,
      input: {
        threadId: activeThreadId,
        requestId,
        decision,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to submit approval decision.",
      );
    }
    setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    return result;
  };
  const onRespondToApprovalStable = useStableCallback(onRespondToApproval);

  const onRespondToUserInput = async (
    requestId: RuntimeRequestId,
    answers: Record<string, unknown>,
  ) => {
    if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const pendingInput = pendingUserInputs.find((input) => input.requestId === requestId);
    if (!pendingInput || pendingInput.responseCapability === "not_resumable") return;
    const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<string, UserInputAttachments[string]>();
    const providerAnswers = { ...answers };
    for (const question of pendingInput.questions) {
      const target = questionAttachmentDraftId(
        environmentId,
        activeThreadId,
        requestId,
        question.id,
      );
      if ((useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0) return;
      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      providerAnswers[question.id] = projectPendingUserInputAnswer(
        answers[question.id],
        draft?.threadContexts ?? [],
      );
      const attachments = draft ? [...draft.images, ...draft.files] : [];
      if (attachments.length === 0) continue;
      const uploaded = getUploadedAttachments({ environmentId, images: attachments });
      if (!uploaded) {
        setThreadError(
          activeThreadId,
          "Wait for attachments to finish uploading, or remove failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(question.id, uploaded as UserInputAttachments[string]);
    }
    userInputResponsesInFlight.current.add(responseKey);

    setRespondingUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const result = await respondToThreadUserInput({
      environmentId,
      input: {
        threadId: activeThreadId,
        requestId,
        answers: providerAnswers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to submit user input.",
      );
    }
    userInputResponsesInFlight.current.delete(responseKey);
    setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    return result;
  };

  // Closes an async question without messaging the agent. The server records
  // the dismissal so every client releases the composer.
  const onDismissUserInput = async (requestId: RuntimeRequestId) => {
    if (!activeThreadId) return;

    setRespondingUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const result = await dismissThreadUserInput({
      environmentId,
      input: { threadId: activeThreadId, requestId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to dismiss the question.",
      );
    }
    setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    return result;
  };
  const onDismissUserInputStable = useStableCallback(onDismissUserInput);

  const setActivePendingUserInputQuestionIndex = (nextQuestionIndex: number) => {
    if (!activePendingUserInput) {
      return;
    }
    setPendingUserInputQuestionIndexByRequestId((existing) => ({
      ...existing,
      [activePendingRequestKey]: nextQuestionIndex,
    }));
  };

  const onSelectActivePendingUserInputOption = (questionId: string, optionValue: string) => {
    if (!activePendingUserInput) {
      return;
    }
    // The option replaces the custom answer. Anything typed there is the
    // user's text, so it goes back to the thread draft instead of vanishing.
    const displacedAnswer = activePendingAnswerDrafts[questionId]?.customAnswer;
    const currentPrompt =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displacedAnswer);
    if (nextPrompt !== currentPrompt) {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      if (activeThreadId) {
        const store = useComposerDraftStore.getState();
        const questionTarget = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          activePendingUserInput.requestId,
          questionId,
        );
        store.addThreadContexts(
          composerDraftTarget,
          threadContextsReferencedByAnswer(
            displacedAnswer ?? "",
            store.getComposerDraft(questionTarget)?.threadContexts ?? [],
          ),
          { appendReference: false },
        );
      }
    }
    setPendingUserInputAnswersByRequestId((existing) => {
      const question =
        (activePendingProgress?.activeQuestion?.id === questionId
          ? activePendingProgress.activeQuestion
          : undefined) ?? activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return existing;
      }

      return {
        ...existing,
        [activePendingRequestKey]: {
          ...existing[activePendingRequestKey],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[activePendingRequestKey]?.[questionId],
            optionValue,
          ),
        },
      };
    });
    promptRef.current = "";
    composerRef.current?.resetCursorState({ cursor: 0 });
  };
  const onSelectActivePendingUserInputOptionStable = useStableCallback(
    onSelectActivePendingUserInputOption,
  );

  const writePrompt = useStableCallback((prompt: string) => {
    promptRef.current = prompt;
  });
  const onChangeActivePendingUserInputCustomAnswer = makePendingCustomAnswerSetter({
    activePendingUserInput,
    activePendingRequestKey,
    writePrompt,
    setPendingUserInputAnswersByRequestId,
  });

  const onAdvanceActivePendingUserInput = () => {
    if (
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingProgress
    ) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  };
  const onAdvanceActivePendingUserInputStable = useStableCallback(onAdvanceActivePendingUserInput);

  const onPreviousActivePendingUserInputQuestion = () => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  };
  const onPreviousActivePendingUserInputQuestionStable = useStableCallback(
    onPreviousActivePendingUserInputQuestion,
  );

  return {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval: onRespondToApprovalStable,
    onDismissUserInput: onDismissUserInputStable,
    onSelectActivePendingUserInputOption: onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestion: onPreviousActivePendingUserInputQuestionStable,
  };
}
