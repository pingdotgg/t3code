import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking } from "react-native";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  parseCodexFeedbackCommand,
  parsePiSessionCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { tryCopyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { shareTextFile } from "../lib/attachmentDownload";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { reportClientError } from "../lib/clientLogger";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { dispatchingQueuedMessageIdAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = getComposerDraftSnapshot(threadKey).text;
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments);
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
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

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const runThreadSessionCommand = useAtomCommand(threadEnvironment.sessionCommand, {
    reportFailure: false,
  });
  const sessionCommandsInFlight = useRef(new Set<string>());

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedDraft = useComposerDraft(selectedThreadKey);
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const feedbackSubmissions = useMemo(
    () => (selectedThreadKey ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? []) : []),
    [feedbackSubmissionsByThreadKey, selectedThreadKey],
  );
  const dismissFeedback = useCallback(
    (id: MessageId) => {
      if (!selectedThreadKey) return;
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [selectedThreadKey]: (current[selectedThreadKey] ?? []).filter((entry) => entry.id !== id),
      }));
    },
    [selectedThreadKey],
  );
  const selectedThreadMessages = selectedThreadDetail?.messages;
  const selectedThreadActivities = selectedThreadDetail?.activities;
  const selectedThreadFeed = useMemo(
    () =>
      selectedThreadMessages && selectedThreadActivities
        ? buildThreadFeed({
            messages: selectedThreadMessages,
            activities: selectedThreadActivities,
          })
        : [],
    [selectedThreadActivities, selectedThreadMessages],
  );

  const draftMessage = selectedDraft.text;
  const draftAttachments = selectedDraft.attachments;
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(
        selectedProvider,
        selectedDraft?.interactionMode ?? selectedThread.interactionMode,
      )
    : null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const isCompacting = useMemo(() => {
    const queuedMessage = selectedThreadQueuedMessages.findLast(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    const latestCompactMessage = selectedThreadDetail?.messages.findLast(
      (message) =>
        message.role === "user" &&
        message.text.trim().toLowerCase() === "/compact" &&
        !message.attachments?.length,
    );
    const compactRequestIsActive =
      latestCompactMessage !== undefined &&
      (latestCompactMessage.createdAt >
        (selectedThread?.latestTurn?.requestedAt ?? latestCompactMessage.createdAt) ||
        (selectedThread?.latestTurn?.state === "running" &&
          latestCompactMessage.createdAt === selectedThread.latestTurn.requestedAt));
    const compactionSettled = selectedThreadDetail?.activities.some((activity) => {
      if (!["context-compaction", "provider.turn.start.failed"].includes(activity.kind))
        return false;
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as { readonly requestId?: unknown })
          : null;
      return payload?.requestId === latestCompactMessage?.id;
    });
    return (
      queuedMessage !== undefined ||
      ((selectedThread?.session?.status === "starting" ||
        selectedThread?.session?.status === "running") &&
        compactRequestIsActive &&
        !compactionSettled)
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThread,
    selectedThreadDetail,
    selectedThreadQueuedMessages,
  ]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const onSendMessage = useCallback(
    async (providerCommand?: string) => {
      if (!selectedThreadShell) {
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      if (sessionCommandsInFlight.current.has(threadKey)) return null;
      const draft = getComposerDraftSnapshot(threadKey);
      const thread = selectedThreadDetail ?? selectedThreadShell;
      const text = providerCommand === undefined ? draft.text.trim() : `/${providerCommand}`;
      const attachments = draft.attachments;
      if (
        composerAttachmentUploadBlockReason({
          environmentId: selectedThreadShell.environmentId,
          attachments,
          connected: selectedEnvironmentRuntime?.connectionState === "connected",
          serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
          states: appAtomRegistry.get(composerAttachmentUploadsAtom),
        }) !== null
      )
        return null;
      if (text.length === 0 && attachments.length === 0) {
        return null;
      }
      // A send-failure restore appends with allowOverflow so it never drops the
      // user's files, which can leave the draft over the cap. Sending it anyway
      // would enqueue a message that outbox recovery rejects forever, so block
      // here until the user removes attachments.
      if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        Alert.alert(
          "Too many attachments",
          `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
        );
        return null;
      }

      const modelSelection = draft.modelSelection ?? thread.modelSelection;
      const serverConfig = selectedEnvironmentRuntime?.serverConfig;
      if (
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        isModelSelectionUnavailable(serverConfig, modelSelection)
      ) {
        Alert.alert(
          "Antigravity model unavailable",
          "Set up Antigravity on web or desktop, or choose another model.",
        );
        return null;
      }
      const provider = serverConfig?.providers.find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      );
      const piSessionCommand =
        provider?.driver === "pi" || thread.session?.providerName === "pi"
          ? parsePiSessionCommand(text)
          : null;
      if (piSessionCommand) {
        if ("error" in piSessionCommand || attachments.length > 0) {
          Alert.alert(
            "Invalid Pi command",
            "error" in piSessionCommand
              ? piSessionCommand.error
              : "Session commands do not accept attachments or context items.",
          );
          return null;
        }
        if (thread.session === null) {
          Alert.alert("Start a Pi thread first", "Send a message before using session commands.");
          return null;
        }
        sessionCommandsInFlight.current.add(threadKey);
        try {
          const response = await runThreadSessionCommand({
            environmentId: selectedThreadShell.environmentId,
            input: { threadId: selectedThreadShell.id, ...piSessionCommand },
          });
          if (response._tag === "Failure") {
            if (isAtomCommandInterrupted(response)) return null;
            throw squashAtomCommandFailure(response);
          }
          const result = response.value;
          if (result.command === "copy") {
            if (!(await tryCopyTextWithHaptic(result.text, { target: "Pi response" }))) {
              throw new Error("Could not copy the response to the clipboard.");
            }
          } else if (result.command === "export") {
            await shareTextFile({
              name: result.fileName,
              mimeType: "text/html",
              text: result.html,
            });
          } else {
            Alert.alert("Pi session shared", result.url, [
              { text: "Done", style: "cancel" },
              { text: "Copy link", onPress: () => void tryCopyTextWithHaptic(result.url) },
              { text: "Open", onPress: () => void Linking.openURL(result.url) },
            ]);
          }
          // Only clear a draft the command actually came from. A menu pick
          // already removed its trigger and passes the command separately,
          // so clearing here would discard remaining text that was never
          // part of the command.
          if (
            providerCommand === undefined &&
            getComposerDraftSnapshot(threadKey).text === draft.text
          ) {
            setComposerDraftText(threadKey, "");
          }
        } catch (error) {
          Alert.alert(
            `Could not ${piSessionCommand.command} Pi session`,
            error instanceof Error ? error.message : "An error occurred.",
          );
        } finally {
          sessionCommandsInFlight.current.delete(threadKey);
        }
        return null;
      }
      const feedbackCommand =
        attachments.length === 0 &&
        (provider?.driver === "codex" || thread.session?.providerName === "codex")
          ? parseCodexFeedbackCommand(text)
          : null;
      if (feedbackCommand) {
        if (serverConfig?.environment.capabilities.providerFeedback !== true) {
          Alert.alert(
            "Feedback is not supported",
            "This environment does not support provider feedback. Your draft has been kept.",
          );
          return null;
        }
        if (thread.session === null) {
          Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
          return null;
        }
        const metadata = makeQueuedMessageMetadata();
        await submitCodexFeedback({
          submission: {
            id: MessageId.make(metadata.messageId),
            command: text,
            createdAt: metadata.createdAt,
          },
          clearDraft: () => clearComposerDraftContent(threadKey),
          onUpdate: (submission) => {
            setFeedbackSubmissionsByThreadKey((current) => {
              const existing = current[threadKey] ?? [];
              const found = existing.some((entry) => entry.id === submission.id);
              return {
                ...current,
                [threadKey]: found
                  ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                  : [...existing, submission],
              };
            });
          },
          upload: () =>
            uploadThreadFeedback({
              environmentId: selectedThreadShell.environmentId,
              input: {
                threadId: selectedThreadShell.id,
                ...feedbackCommand,
              },
            }),
        });
        return null;
      }

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      // Enqueue publishes the queued atom synchronously (the durable write
      // happens behind it), so clearing the draft here gives send feedback on
      // the tap frame instead of after file I/O. If the write fails the message
      // is rolled out of the queue and the content is merged back into the
      // draft, preserving anything typed since.
      const enqueuePromise = enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: resolveProviderInteractionMode(
          provider,
          draft.interactionMode ?? thread.interactionMode,
        ),
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
      enqueuePromise.then(
        () => {
          // The queued message owns the files now; the sweep sees that and
          // spares them. Deferred to here so a failed write cannot roll the
          // message out of the queue mid-sweep and lose the bytes.
          scheduleUnusedComposerAttachmentCleanup(attachments);
        },
        (error: unknown) => {
          // Restore text via merge (idempotent) but attachments via the uncapped
          // append: the merge path slots existing attachments first and truncates
          // at the send limit, which would silently drop this message's images if
          // the user attached new ones while the write was in flight.
          void mergeComposerDraftContent(threadKey, { text, attachments: [] });
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setPendingConnectionError(
            error instanceof Error ? error.message : "Failed to save the queued message.",
          );
        },
      );
      return messageId;
    },
    [
      selectedEnvironmentRuntime?.connectionState,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadDetail,
      selectedThreadShell,
      uploadThreadFeedback,
      runThreadSessionCommand,
    ],
  );

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

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments);
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files);
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images);
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  }, [selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        reportClientError("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [selectedThreadShell],
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

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(provider?.showInteractionModeToggle === false
          ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
          : {}),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      const modelSelection =
        getComposerDraftSnapshot(selectedThreadKey).modelSelection ??
        selectedThread?.modelSelection;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection?.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        interactionMode: resolveProviderInteractionMode(provider, value),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThread?.modelSelection, selectedThreadKey],
  );

  return {
    feedbackSubmissions,
    dismissFeedback,
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    isCompacting,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
