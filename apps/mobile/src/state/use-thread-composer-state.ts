import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";

import { EnvironmentScopedThreadShell } from "@t3tools/client-runtime";
import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";
import { Atom } from "effect/unstable/reactivity";

import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedRequestKey, scopedThreadKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
  type QueuedThreadMessage,
} from "../lib/threadActivity";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "../state/atom-registry";
import { getEnvironmentClient } from "./environment-session-registry";
import type { ConnectedEnvironmentSummary } from "../state/remote-runtime-types";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "../state/use-remote-environment-registry";
import { useRemoteCatalog } from "../state/use-remote-catalog";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";

const draftMessageByThreadKeyAtom = Atom.make<Record<string, string>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-composer:draft-message"),
);

const draftAttachmentsByThreadKeyAtom = Atom.make<
  Record<string, ReadonlyArray<DraftComposerImageAttachment>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-composer:draft-attachments"));

const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-composer:dispatching-message-id"),
);

const queuedMessagesByThreadKeyAtom = Atom.make<Record<string, ReadonlyArray<QueuedThreadMessage>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-composer:queued-messages"));

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setDraftMessage(threadKey: string, value: string): void {
  const current = appAtomRegistry.get(draftMessageByThreadKeyAtom);
  appAtomRegistry.set(draftMessageByThreadKeyAtom, {
    ...current,
    [threadKey]: value,
  });
}

function appendDraftAttachments(
  threadKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  const current = appAtomRegistry.get(draftAttachmentsByThreadKeyAtom);
  appAtomRegistry.set(draftAttachmentsByThreadKeyAtom, {
    ...current,
    [threadKey]: [...(current[threadKey] ?? []), ...attachments],
  });
}

function appendDraftMessage(threadKey: string, value: string): void {
  const current = appAtomRegistry.get(draftMessageByThreadKeyAtom);
  appAtomRegistry.set(draftMessageByThreadKeyAtom, {
    ...current,
    [threadKey]: `${current[threadKey] ?? ""}${value}`,
  });
}

export function appendReviewCommentToDraft(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(
    EnvironmentId.make(input.environmentId),
    ThreadId.make(input.threadId),
  );
  const current = appAtomRegistry.get(draftMessageByThreadKeyAtom);
  const existing = current[threadKey] ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  appAtomRegistry.set(draftMessageByThreadKeyAtom, {
    ...current,
    [threadKey]: `${existing}${separator}${input.text}`,
  });
  if (input.attachments && input.attachments.length > 0) {
    appendDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
}) {
  const draftMessageByThreadKey = useAtomValue(draftMessageByThreadKeyAtom);
  const draftAttachmentsByThreadKey = useAtomValue(draftAttachmentsByThreadKeyAtom);
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(EnvironmentId.make(input.environmentId), ThreadId.make(input.threadId))
      : null;

  return {
    draftMessage: threadKey ? (draftMessageByThreadKey[threadKey] ?? "") : "",
    draftAttachments: threadKey ? (draftAttachmentsByThreadKey[threadKey] ?? []) : [],
  };
}

function clearDraft(threadKey: string): void {
  const draftMessages = appAtomRegistry.get(draftMessageByThreadKeyAtom);
  const draftAttachments = appAtomRegistry.get(draftAttachmentsByThreadKeyAtom);
  appAtomRegistry.set(draftMessageByThreadKeyAtom, {
    ...draftMessages,
    [threadKey]: "",
  });
  appAtomRegistry.set(draftAttachmentsByThreadKeyAtom, {
    ...draftAttachments,
    [threadKey]: [],
  });
}

function removeDraftImage(threadKey: string, imageId: string): void {
  const current = appAtomRegistry.get(draftAttachmentsByThreadKeyAtom);
  appAtomRegistry.set(draftAttachmentsByThreadKeyAtom, {
    ...current,
    [threadKey]: (current[threadKey] ?? []).filter((image) => image.id !== imageId),
  });
}

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function enqueueQueuedMessage(message: QueuedThreadMessage): void {
  const current = appAtomRegistry.get(queuedMessagesByThreadKeyAtom);
  const threadKey = scopedThreadKey(message.environmentId, message.threadId);
  appAtomRegistry.set(queuedMessagesByThreadKeyAtom, {
    ...current,
    [threadKey]: [...(current[threadKey] ?? []), message],
  });
}

function removeQueuedMessage(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  queuedMessageId: MessageId,
): void {
  const current = appAtomRegistry.get(queuedMessagesByThreadKeyAtom);
  const threadKey = scopedThreadKey(environmentId, threadId);
  const existing = current[threadKey];
  if (!existing) {
    return;
  }

  const nextQueue = existing.filter((entry) => entry.messageId !== queuedMessageId);
  const next = { ...current };
  if (nextQueue.length === 0) {
    delete next[threadKey];
  } else {
    next[threadKey] = nextQueue;
  }

  appAtomRegistry.set(queuedMessagesByThreadKeyAtom, next);
}

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

function useQueueDrain(input: {
  readonly dispatchingQueuedMessageId: string | null;
  readonly queuedMessagesByThreadKey: Record<string, ReadonlyArray<QueuedThreadMessage>>;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
  readonly environments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly sendQueuedMessage: (message: QueuedThreadMessage) => Promise<void>;
}) {
  const {
    dispatchingQueuedMessageId,
    environments,
    queuedMessagesByThreadKey,
    sendQueuedMessage,
    threads,
  } = input;

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }

      const thread = threads.find(
        (candidate) => scopedThreadKey(candidate.environmentId, candidate.id) === threadKey,
      );
      if (!thread) {
        continue;
      }

      const environment = environments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      if (!environment || environment.connectionState !== "ready") {
        continue;
      }

      const threadStatus = thread.session?.status;
      if (threadStatus === "running" || threadStatus === "starting") {
        continue;
      }

      void sendQueuedMessage(nextQueuedMessage);
      return;
    }
  }, [
    dispatchingQueuedMessageId,
    environments,
    queuedMessagesByThreadKey,
    sendQueuedMessage,
    threads,
  ]);
}

export function useThreadComposerState() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { threads } = useRemoteCatalog();
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const draftMessageByThreadKey = useAtomValue(draftMessageByThreadKeyAtom);
  const draftAttachmentsByThreadKey = useAtomValue(draftAttachmentsByThreadKeyAtom);
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const queuedMessagesByThreadKey = useAtomValue(queuedMessagesByThreadKeyAtom);
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedRequestKey = selectedThreadShell
    ? (requestId: ApprovalRequestId) =>
        scopedRequestKey(selectedThreadShell.environmentId, requestId)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );

  const selectedThreadFeed = useMemo(
    () =>
      selectedThread
        ? buildThreadFeed(selectedThread, selectedThreadQueuedMessages, dispatchingQueuedMessageId)
        : [],
    [dispatchingQueuedMessageId, selectedThread, selectedThreadQueuedMessages],
  );

  const draftMessage = selectedThreadKey ? (draftMessageByThreadKey[selectedThreadKey] ?? "") : "";
  const draftAttachments = selectedThreadKey
    ? (draftAttachmentsByThreadKey[selectedThreadKey] ?? [])
    : [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;

  const selectedThreadSessionActivity = useMemo(() => {
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThread]);

  const queuedSendStartedAt = selectedThreadQueuedMessages[0]?.createdAt ?? null;
  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      queuedSendStartedAt,
    );
  }, [queuedSendStartedAt, selectedThread, selectedThreadSessionActivity]);

  const activePendingApprovals = useMemo(
    () => (selectedThread ? derivePendingApprovals(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;

  const activePendingUserInputs = useMemo(
    () => (selectedThread ? derivePendingUserInputs(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedRequestKey
      ? (userInputDraftsByRequestKey[selectedRequestKey(activePendingUserInput.requestId)] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage) => {
      const client = getEnvironmentClient(queuedMessage.environmentId);
      const thread = threads.find(
        (candidate) =>
          candidate.environmentId === queuedMessage.environmentId &&
          candidate.id === queuedMessage.threadId,
      );
      if (!client || !thread) {
        return;
      }

      beginDispatchingQueuedMessage(queuedMessage.messageId);
      try {
        await client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(queuedMessage.commandId),
          threadId: ThreadId.make(queuedMessage.threadId),
          message: {
            messageId: MessageId.make(queuedMessage.messageId),
            role: "user",
            text: queuedMessage.text,
            attachments: queuedMessage.attachments,
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: queuedMessage.createdAt,
        });

        removeQueuedMessage(
          queuedMessage.environmentId,
          queuedMessage.threadId,
          queuedMessage.messageId,
        );
      } catch (error) {
        removeQueuedMessage(
          queuedMessage.environmentId,
          queuedMessage.threadId,
          queuedMessage.messageId,
        );
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to send message.",
        );
      } finally {
        finishDispatchingQueuedMessage(queuedMessage.messageId);
      }
    },
    [threads],
  );

  useQueueDrain({
    dispatchingQueuedMessageId,
    queuedMessagesByThreadKey,
    threads,
    environments: connectedEnvironments,
    sendQueuedMessage,
  });

  const onSendMessage = useCallback(() => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const text = (draftMessageByThreadKey[threadKey] ?? "").trim();
    const attachments = draftAttachmentsByThreadKey[threadKey] ?? [];
    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const createdAt = new Date().toISOString();
    enqueueQueuedMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId: MessageId.make(uuidv4()),
      commandId: CommandId.make(uuidv4()),
      text,
      attachments,
      createdAt,
    });
    clearDraft(threadKey);
  }, [draftAttachmentsByThreadKey, draftMessageByThreadKey, selectedThreadShell]);

  const onSelectUserInputOption = useCallback(
    (requestId: string, questionId: string, label: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(
        selectedThreadShell.environmentId,
        requestId as ApprovalRequestId,
      );
      setUserInputDraftOption(requestKey, questionId, label);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: string, questionId: string, customAnswer: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(
        selectedThreadShell.environmentId,
        requestId as ApprovalRequestId,
      );
      setUserInputDraftCustomAnswer(requestKey, questionId, customAnswer);
    },
    [selectedThreadShell],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setDraftMessage(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
    });
    if (result.images.length > 0) {
      appendDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [draftAttachmentsByThreadKey, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
    });
    if (result.images.length > 0) {
      appendDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendDraftMessage(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [draftAttachmentsByThreadKey, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
        });
        if (images.length > 0) {
          appendDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", error);
      }
    },
    [draftAttachmentsByThreadKey, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeDraftImage(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    draftMessage,
    draftAttachments,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
  };
}
