import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useState } from "react";

import {
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftOption(requestKey: string, questionId: string, label: string): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: {
        selectedOptionLabel: label,
      },
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  questionId: string,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: setPendingUserInputCustomAnswer(
        current[requestKey]?.[questionId],
        customAnswer,
      ),
    },
  });
}

/**
 * Pending approval / user-input requests for the selected thread.
 *
 * `activities` should be the FULL loaded set (lazy-loaded older pages + the
 * windowed live view, i.e. `useThreadComposerState().mergedActivities`): the
 * detail snapshot windows activities to the most recent page, so deriving from
 * `selectedThread.activities` alone would hide a prompt the user scrolled back
 * to load. Falls back to the live window when not provided. Deriving from the
 * merged set is sound — resolutions are always newer than their requests, so a
 * loaded request whose resolution exists always has that resolution loaded too.
 */
export function useSelectedThreadRequests(activities?: ReadonlyArray<OrchestrationThreadActivity>) {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );

  const requestActivities = activities ?? selectedThread?.activities ?? null;
  const activePendingApprovals = useMemo(
    () => (requestActivities ? derivePendingApprovals(requestActivities) : []),
    [requestActivities],
  );
  // The derivations sort ascending by createdAt; surface the NEWEST open
  // request. With lazy-loaded older pages in the set, index 0 could be an
  // ancient dangling request hijacking the prompt for the current one.
  const activePendingApproval = activePendingApprovals.at(-1) ?? null;
  const activePendingUserInputs = useMemo(
    () => (requestActivities ? derivePendingUserInputs(requestActivities) : []),
    [requestActivities],
  );
  const activePendingUserInput = activePendingUserInputs.at(-1) ?? null;
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? (userInputDraftsByRequestKey[
          scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
        ] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, questionId: string, label: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, questionId, label);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, questionId, customAnswer);
    },
    [selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput || !activePendingUserInputAnswers) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
      },
    });
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [
    activePendingUserInput,
    activePendingUserInputAnswers,
    respondToUserInput,
    selectedThreadShell,
  ]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
  };
}
