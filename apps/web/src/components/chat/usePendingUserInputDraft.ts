import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import {
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  collectPendingUserInputCustomAnswers,
  type PendingUserInputRequestSnapshot,
  mergeComposerDraftPromptWithPendingAnswer,
  resolveComposerDraftPromptAfterReturningPendingAnswer,
  resolveComposerDraftToCarryIntoPendingUserInput,
  shouldRescueCancelledPendingUserInput,
  pendingUserInputRequestKey,
} from "../ChatView.logic";

type AnswersByRequest = Record<string, Record<string, PendingUserInputDraftAnswer>>;

/** Keeps persisted composer text through question transitions, navigation and failed responses. */
export function usePendingUserInputDraft({
  composerDraftTarget,
  activePendingUserInput,
  pendingUserInputAnswersByRequestId,
  setPendingUserInputAnswersByRequestId,
}: {
  composerDraftTarget: ScopedThreadRef | DraftId;
  activePendingUserInput: {
    requestId: string;
    questions: ReadonlyArray<{ id: string; allowCustomAnswer?: boolean | undefined }>;
  } | null;
  pendingUserInputAnswersByRequestId: AnswersByRequest;
  setPendingUserInputAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequest>>;
}) {
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const activePendingRequestKey = pendingUserInputRequestKey(
    composerDraftTarget,
    activePendingUserInput?.requestId ?? null,
  );
  // The pending question seen on the previous render; see the rescue effect
  // below.
  const prevPendingUserInputRef = useRef<PendingUserInputRequestSnapshot<
    ScopedThreadRef | DraftId
  > | null>(null);
  // Request ids with an answer submitted via onRespondToUserInput. A submitted
  // question also disappears from pendingUserInputs, but that's the answer
  // being sent, not the question being cancelled, so the effect below must
  // not rescue its text. Unmarked when the submit fails.
  const submittedPendingUserInputRequestIdsRef = useRef<Set<string>>(new Set());
  // Persisted answer copies, initially carried from the composer and refreshed
  // on submission failure. Retain the unrelated draft separately so replacing
  // or removing the answer copy never consumes that draft.
  const carriedComposerDraftByRequestIdRef = useRef(
    new Map<string, { text: string; unrelatedText: string }>(),
  );
  // Text typed in the composer is never dropped: it is sent, or it stays in
  // the draft. Appends text that is leaving a request's answer slot unsent to
  // the thread's composer draft, replacing the persisted copy of text that
  // was carried in from the draft.
  const returnTextToComposerDraft = useCallback(
    (
      requestId: string,
      text: string,
      draftTarget: ScopedThreadRef | DraftId,
      discardEmptyCarriedDraft = false,
    ) => {
      const requestKey = pendingUserInputRequestKey(draftTarget, requestId);
      // The request key already includes the draft owner; object identity changes on navigation.
      const carried = carriedComposerDraftByRequestIdRef.current.get(requestKey);
      const draftPrompt =
        useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
      const nextDraftPrompt = resolveComposerDraftPromptAfterReturningPendingAnswer({
        draftPrompt,
        carriedDraftPrompt: carried?.text ?? null,
        unrelatedDraftPrompt: carried?.unrelatedText ?? "",
        pendingCustomAnswer: text,
        discardEmptyCarriedDraft,
      });
      if (nextDraftPrompt === null) {
        return;
      }
      carriedComposerDraftByRequestIdRef.current.delete(requestKey);
      if (nextDraftPrompt !== draftPrompt) {
        setComposerDraftPrompt(draftTarget, nextDraftPrompt);
      }
    },
    [setComposerDraftPrompt],
  );
  // An option returns only one question's text. Move it into the unrelated
  // draft while retaining tracking for the other answers; the following answer
  // state update synchronizes their complete remaining set in the layout effect.
  const returnQuestionTextToComposerDraft = useCallback(
    (requestId: string, text: string, draftTarget: ScopedThreadRef | DraftId) => {
      if (text.trim().length === 0) return;
      const requestKey = pendingUserInputRequestKey(draftTarget, requestId);
      const carried = carriedComposerDraftByRequestIdRef.current.get(requestKey);
      const draftPrompt =
        useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
      const unrelatedText =
        carried && draftPrompt === carried.text ? carried.unrelatedText : draftPrompt;
      carriedComposerDraftByRequestIdRef.current.set(requestKey, {
        text: draftPrompt,
        unrelatedText:
          mergeComposerDraftPromptWithPendingAnswer(unrelatedText, text) ?? unrelatedText,
      });
    },
    [],
  );
  // Merges a request's typed custom answers into a thread's composer draft.
  // Answers by request id are never pruned, so they stay readable after the
  // request itself has disappeared.
  const rescuePendingUserInputAnswers = useCallback(
    (requestId: string, draftTarget: ScopedThreadRef | DraftId) => {
      const text = collectPendingUserInputCustomAnswers(
        pendingUserInputAnswersByRequestId[pendingUserInputRequestKey(draftTarget, requestId)],
      );
      if (text !== null) {
        returnTextToComposerDraft(requestId, text, draftTarget);
      }
    },
    [pendingUserInputAnswersByRequestId, returnTextToComposerDraft],
  );
  const activePendingFirstQuestionId = activePendingUserInput?.questions[0]?.id ?? null;
  const activePendingFirstQuestionAllowsCustomAnswer =
    activePendingUserInput?.questions[0]?.allowCustomAnswer !== false;
  const activePendingHasAnswerState =
    activePendingUserInput !== null &&
    pendingUserInputAnswersByRequestId[activePendingRequestKey] !== undefined;
  // Moves composer text across the pending-question boundary (issue #8963).
  // A question that just appeared takes over the composer, so the draft is
  // carried into its first question's free-form answer and stays visible;
  // a question that disappears without being answered has its typed answers
  // rescued back into the draft. Both run in a layout effect so the composer
  // never paints a frame without the text. `prevPendingUserInputRef` is
  // written only here, so "previous" is always the state before this
  // transition.
  useLayoutEffect(() => {
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const previous = prevPendingUserInputRef.current;
    // A thread switch only hides the question, so it neither rescues nor
    // consumes the submitted mark; the real resolve may arrive after the user
    // returns and must still read as an answer, not a cancel.
    if (
      previous &&
      previous.requestId !== nextRequestId &&
      pendingUserInputRequestKey(previous.draftTarget, null) ===
        pendingUserInputRequestKey(composerDraftTarget, null)
    ) {
      const previousKey = pendingUserInputRequestKey(previous.draftTarget, previous.requestId);
      const wasSubmitted = submittedPendingUserInputRequestIdsRef.current.has(previousKey);
      submittedPendingUserInputRequestIdsRef.current.delete(previousKey);
      if (
        shouldRescueCancelledPendingUserInput({
          previous,
          nextRequestId,
          currentDraftTarget: composerDraftTarget,
          wasSubmitted,
        })
      ) {
        rescuePendingUserInputAnswers(previous.requestId, previous.draftTarget);
      }
    }
    // Runs after the rescue so text from a question replaced in the same
    // render follows the user into the new one.
    if (
      nextRequestId !== null &&
      activePendingFirstQuestionId !== null &&
      (previous?.requestId !== nextRequestId ||
        pendingUserInputRequestKey(previous.draftTarget, null) !==
          pendingUserInputRequestKey(composerDraftTarget, null))
    ) {
      const draftToCarry = resolveComposerDraftToCarryIntoPendingUserInput({
        hasAnswerState: activePendingHasAnswerState,
        allowCustomAnswer: activePendingFirstQuestionAllowsCustomAnswer,
        draftPrompt:
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "",
      });
      if (draftToCarry !== null) {
        carriedComposerDraftByRequestIdRef.current.set(activePendingRequestKey, {
          text: draftToCarry,
          unrelatedText: "",
        });
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingRequestKey]: {
            ...existing[activePendingRequestKey],
            [activePendingFirstQuestionId]: setPendingUserInputCustomAnswer(
              existing[activePendingRequestKey]?.[activePendingFirstQuestionId],
              draftToCarry,
            ),
          },
        }));
      }
    }
    prevPendingUserInputRef.current = nextRequestId
      ? { requestId: nextRequestId, draftTarget: composerDraftTarget }
      : null;
  }, [
    activePendingFirstQuestionId,
    activePendingFirstQuestionAllowsCustomAnswer,
    activePendingHasAnswerState,
    activePendingRequestKey,
    activePendingUserInput?.requestId,
    composerDraftTarget,
    rescuePendingUserInputAnswers,
    setPendingUserInputAnswersByRequestId,
  ]);
  // Persist the full current answer set after edits. A failed submission can
  // contain several answers, so clearing one must retain the others even if
  // this thread is hidden before the request disappears.
  useLayoutEffect(() => {
    const carried = carriedComposerDraftByRequestIdRef.current.get(activePendingRequestKey);
    const answers = pendingUserInputAnswersByRequestId[activePendingRequestKey];
    if (!activePendingUserInput || !carried || !answers) {
      return;
    }
    const draftPrompt =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const unrelatedText = draftPrompt === carried.text ? carried.unrelatedText : draftPrompt;
    const text =
      mergeComposerDraftPromptWithPendingAnswer(
        unrelatedText,
        collectPendingUserInputCustomAnswers(answers) ?? "",
      ) ?? unrelatedText;
    carriedComposerDraftByRequestIdRef.current.set(activePendingRequestKey, {
      text,
      unrelatedText,
    });
    if (text !== draftPrompt) {
      setComposerDraftPrompt(composerDraftTarget, text);
    }
  }, [
    activePendingRequestKey,
    activePendingUserInput,
    composerDraftTarget,
    pendingUserInputAnswersByRequestId,
    setComposerDraftPrompt,
  ]);
  const beginSubmission = useCallback(
    (requestId: string) => {
      // Marked before the round trip: the resolved activity can arrive over the
      // socket before this RPC settles, and the rescue effect must already know
      // the question was answered rather than cancelled. Unmarked on failure so
      // a later real Stop of the still-open question can rescue the text.
      const requestKey = pendingUserInputRequestKey(composerDraftTarget, requestId);
      submittedPendingUserInputRequestIdsRef.current.add(requestKey);
      // The answer is what gets sent, so the persisted copy of text carried in
      // from the draft goes now, before the resolve can bring the draft back
      // on screen.
      const carried = carriedComposerDraftByRequestIdRef.current.get(requestKey);
      carriedComposerDraftByRequestIdRef.current.delete(requestKey);
      const draftPrompt =
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
      if (carried && draftPrompt === carried.text) {
        setComposerDraftPrompt(composerDraftTarget, carried.unrelatedText);
      }
      // Capture what was submitted, rather than the original composer carry.
      // Failure may arrive while a different thread or environment is visible.
      const submittedText = collectPendingUserInputCustomAnswers(
        pendingUserInputAnswersByRequestId[requestKey],
      );
      return () => {
        submittedPendingUserInputRequestIdsRef.current.delete(requestKey);
        if (submittedText === null) {
          return;
        }
        const unrelatedText =
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
        const restoredText = mergeComposerDraftPromptWithPendingAnswer(
          unrelatedText,
          submittedText,
        );
        if (restoredText === null) {
          return;
        }
        // Keep the unrelated draft separate so editing, erasing or retrying the
        // answer replaces only its persisted copy, even after navigation.
        carriedComposerDraftByRequestIdRef.current.set(requestKey, {
          text: restoredText,
          unrelatedText,
        });
        setComposerDraftPrompt(composerDraftTarget, restoredText);
      };
    },
    [composerDraftTarget, pendingUserInputAnswersByRequestId, setComposerDraftPrompt],
  );
  return { returnQuestionTextToComposerDraft, beginSubmission };
}
