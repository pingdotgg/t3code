import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";

import { EnvironmentScopedThreadShell } from "@t3tools/client-runtime";
import { CommandId, MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";
import { Atom } from "effect/unstable/reactivity";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed, type QueuedThreadMessage } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraft,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  removeComposerDraftAttachment,
  setComposerDraftText,
  useComposerDraft,
} from "./use-composer-drafts";
import { getEnvironmentClient } from "./environment-session-registry";
import type { ConnectedEnvironmentSummary } from "../state/remote-runtime-types";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "../state/use-remote-environment-registry";
import { useRemoteCatalog } from "../state/use-remote-catalog";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";

const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-composer:dispatching-message-id"),
);

const queuedMessagesByThreadKeyAtom = Atom.make<Record<string, ReadonlyArray<QueuedThreadMessage>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-composer:queued-messages"));

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
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

function useQueueDrain(input: {
  readonly dispatchingQueuedMessageId: MessageId | null;
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
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const queuedMessagesByThreadKey = useAtomValue(queuedMessagesByThreadKeyAtom);

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
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

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
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
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
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
    const draft = composerDrafts[threadKey];
    const text = (draft?.text ?? "").trim();
    const attachments = draft?.attachments ?? [];
    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const metadata = makeQueuedMessageMetadata();
    enqueueQueuedMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      createdAt: metadata.createdAt,
    });
    clearComposerDraft(threadKey);
  }, [composerDrafts, selectedThreadShell]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", error);
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
  };
}
