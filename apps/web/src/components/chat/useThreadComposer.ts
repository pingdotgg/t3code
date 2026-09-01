import {
  type ApprovalRequestId,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type PreviewAnnotationPayload,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { parseCodexFeedbackCommand } from "@t3tools/client-runtime/state/threads";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  type PendingUserInput,
} from "../../session-logic.ts";
import { useEnvironmentSettings } from "../../hooks/useSettings.ts";
import { parseStandaloneComposerSlashCommand } from "../../composer-logic.ts";
import { newMessageId } from "../../lib/utils.ts";
import { primaryServerKeybindingsAtom } from "../../state/server.ts";
import { useProject, useServerConfigs } from "../../state/entities.ts";
import { useEnvironmentQuery } from "../../state/query.ts";
import { vcsEnvironment } from "../../state/vcs.ts";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SidebarThreadSummary,
  type ChatMessage,
  type Thread,
} from "../../types.ts";
import { isImageAttachment } from "../../types.ts";
import {
  deriveLockedProvider,
  buildThreadTurnInterruptInput,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  buildExpiredTerminalContextToastCopy,
  getStartedThreadModelChangeBlockReason,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  resolveThreadMetadataUpdateForNextTurn,
  deriveComposerSendState,
  formatOutgoingPrompt,
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
} from "../ChatView.logic.ts";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic.ts";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
} from "../../composerDraftStore.ts";
import { useAssetUrls } from "../../assets/assetUrls.ts";
import { resolveAppModelSelectionForInstance } from "../../modelSelection.ts";
import {
  appendTerminalContextsToPrompt,
  type TerminalContextDraft,
} from "../../lib/terminalContext.ts";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue.ts";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
} from "../../lib/elementContext.ts";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation.ts";
import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext.ts";
import type { ChatComposerProps } from "./ChatComposer.tsx";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";
import { toastManager } from "../ui/toast.tsx";
import { useUiStateStore } from "../../uiStateStore.ts";

// Hoisted so `thread?.activities ?? []` doesn't allocate a fresh array (and
// bust the memos keyed on it) on every render when a thread has no activities.
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS = {} as const;

// Board composer never surfaces inline approvals/user-input prompts (that UI
// lives on the route only), so these are always-empty by construction. Hoisted
// so `ChatComposer`'s `memo` sees a stable reference for them across renders.
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProvider[] = [];
const EMPTY_CHAT_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_COMPOSER_BANNER_ITEMS = [] as const;
// Shared no-op for the handful of board composer callbacks that are inert
// (plan sidebar, focus scheduling, etc. don't apply to embedded cards). A
// zero-arg function is structurally assignable to every callback prop type
// below regardless of its arity, so one constant covers all of them.
const NOOP = () => {};

export function buildBoardComposerMessageText(input: {
  readonly prompt: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
}): string {
  const withTerminalContexts = appendTerminalContextsToPrompt(input.prompt, input.terminalContexts);
  const withElementContexts = appendElementContextsToPrompt(
    withTerminalContexts,
    input.elementContexts,
  );
  const withPreviewAnnotations = input.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    withElementContexts,
  );
  return appendReviewCommentsToPrompt(withPreviewAnnotations, input.reviewComments);
}

export function boardComposerDraftCanBeRestored(
  draft:
    | (Pick<ComposerThreadDraftState, "prompt" | "images"> &
        Partial<
          Pick<
            ComposerThreadDraftState,
            | "files"
            | "terminalContexts"
            | "elementContexts"
            | "previewAnnotations"
            | "reviewComments"
          >
        >)
    | null,
): boolean {
  return (
    draft === null ||
    (draft.prompt.length === 0 &&
      draft.images.length === 0 &&
      (draft.files?.length ?? 0) === 0 &&
      (draft.terminalContexts?.length ?? 0) === 0 &&
      (draft.elementContexts?.length ?? 0) === 0 &&
      (draft.previewAnnotations?.length ?? 0) === 0 &&
      (draft.reviewComments?.length ?? 0) === 0)
  );
}

export function parseBoardCodexFeedbackCommand(input: {
  readonly provider: string;
  readonly prompt: string;
  readonly hasAttachments: boolean;
  readonly hasContexts: boolean;
}): { readonly reason?: string } | null {
  if (input.provider !== "codex" || input.hasAttachments || input.hasContexts) {
    return null;
  }
  return parseCodexFeedbackCommand(input.prompt);
}

export function parseBoardStandaloneComposerSlashCommand(input: {
  readonly planModeEnabled: boolean;
  readonly prompt: string;
  readonly hasAttachments: boolean;
  readonly hasContexts: boolean;
}) {
  if (!input.planModeEnabled || input.hasAttachments || input.hasContexts) {
    return null;
  }
  return parseStandaloneComposerSlashCommand(input.prompt);
}

export function resolveBoardExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  hasSendableContent: boolean,
): { title: string; description: string } | null {
  if (expiredTerminalContextCount <= 0) return null;
  return buildExpiredTerminalContextToastCopy(
    expiredTerminalContextCount,
    hasSendableContent ? "omitted" : "empty",
  );
}

export function resolveBoardAttachmentUploadCapabilities(
  config:
    | {
        readonly environment: {
          readonly capabilities: { readonly attachmentUploads?: boolean };
        };
      }
    | null
    | undefined,
): {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
} {
  return {
    attachmentUploadsCapabilityKnown: config !== null && config !== undefined,
    supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
  };
}

export function resolveBoardLocalCheckoutStatusGuard(input: {
  readonly activeWorktreePath: string | null;
  readonly activeBranch: string | null;
  readonly gitCwd: string | null;
  readonly statusData: unknown | null;
  readonly statusError: string | null;
}): "pending" | null {
  if (input.activeWorktreePath !== null || input.activeBranch === null || input.gitCwd === null) {
    return null;
  }
  if (input.statusData !== null) return null;
  return input.statusError === null ? "pending" : null;
}

export function resolveBoardComposerModes(input: {
  readonly planModeEnabled: boolean;
  readonly draftRuntimeMode: RuntimeMode | null | undefined;
  readonly draftInteractionMode: ProviderInteractionMode | null | undefined;
  readonly summaryRuntimeMode: RuntimeMode | null | undefined;
  readonly summaryInteractionMode: ProviderInteractionMode | null | undefined;
}): { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode } {
  return {
    runtimeMode: input.draftRuntimeMode ?? input.summaryRuntimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.planModeEnabled
      ? (input.draftInteractionMode ?? input.summaryInteractionMode ?? DEFAULT_INTERACTION_MODE)
      : DEFAULT_INTERACTION_MODE,
  };
}

export function mergeBoardTimelineMessages(
  serverMessages: ReadonlyArray<ChatMessage>,
  optimisticUserMessages: ReadonlyArray<ChatMessage>,
  attachmentPreviewHandoffByMessageId: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<ChatMessage> {
  const serverMessagesWithPreviewHandoff = serverMessages.map((message) => {
    const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
    if (
      message.role !== "user" ||
      !handoffPreviewUrls ||
      !message.attachments ||
      message.attachments.length === 0
    ) {
      return message;
    }
    let imageIndex = 0;
    let changed = false;
    const attachments = message.attachments.map((attachment) => {
      if (!isImageAttachment(attachment)) return attachment;
      const previewUrl = handoffPreviewUrls[imageIndex];
      imageIndex += 1;
      if (!previewUrl || attachment.previewUrl === previewUrl) return attachment;
      changed = true;
      return { ...attachment, previewUrl };
    });
    return changed ? { ...message, attachments } : message;
  });
  if (optimisticUserMessages.length === 0) return serverMessagesWithPreviewHandoff;
  const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
  const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
  return pendingMessages.length === 0
    ? serverMessagesWithPreviewHandoff
    : [...serverMessagesWithPreviewHandoff, ...pendingMessages];
}

export function removeBoardAttachmentPreviewHandoff(
  handoffs: Readonly<Record<string, ReadonlyArray<string>>>,
  messageId: string,
): {
  readonly next: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly previewUrls: ReadonlyArray<string>;
} | null {
  const previewUrls = handoffs[messageId];
  if (!previewUrls) return null;
  const next = { ...handoffs };
  delete next[messageId];
  return { next, previewUrls };
}

export function canBeginBoardComposerSend(
  connection: EnvironmentConnectionPresentation,
  sendInFlight: boolean,
): boolean {
  return connection.phase === "connected" && !sendInFlight;
}

export function resolveBoardTimelineWorkingState(input: {
  readonly serverIsWorking: boolean;
  readonly serverActiveTurnStartedAt: string | null;
  readonly isLocalSendBusy: boolean;
  readonly localSendStartedAt: string | null;
}): { readonly isWorking: boolean; readonly activeTurnStartedAt: string | null } {
  const localStartedAt = input.isLocalSendBusy ? input.localSendStartedAt : null;
  return {
    isWorking: input.serverIsWorking || input.isLocalSendBusy,
    activeTurnStartedAt: input.serverIsWorking
      ? (input.serverActiveTurnStartedAt ?? localStartedAt)
      : localStartedAt,
  };
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
  readonly onFileOpen: ChatComposerProps["onFileOpen"];
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
    onFileOpen,
  } = input;
  const environmentId = threadRef.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfigs = useServerConfigs();

  const composerRef = useRef<import("./ChatComposer.tsx").ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
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
  const { attachmentUploadsCapabilityKnown, supportsAttachmentUploads } =
    resolveBoardAttachmentUploadCapabilities(serverConfigs.get(environmentId));

  const project = useProject(scopeProjectRef(summary.environmentId, summary.projectId));
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: summary.worktreePath ?? null,
      })
    : null;
  const gitStatusQuery = useEnvironmentQuery(
    summary.worktreePath === null && summary.branch !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const localCheckoutStatusGuard = resolveBoardLocalCheckoutStatusGuard({
    activeWorktreePath: summary.worktreePath,
    activeBranch: summary.branch,
    gitCwd,
    statusData: gitStatusQuery.data,
    statusError: gitStatusQuery.error,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: summary.worktreePath,
        activeThreadBranch: summary.branch,
        currentGitBranch: gitStatusQuery.data?.refName ?? null,
      }),
    [gitStatusQuery.data?.refName, summary.branch, summary.worktreePath],
  );

  const lockedProvider = deriveLockedProvider({
    thread,
    selectedProvider: null,
    threadProvider: summary.modelSelection.instanceId,
  });

  const { pendingApprovals, activePendingApproval } = useThreadComposerRouteState(thread);
  const phase = derivePhase(thread?.session ?? summary.session ?? null);
  const isConnecting = phase === "connecting";
  const sendInFlightRef = useRef(false);
  const [isSendBusy, setIsSendBusy] = useState(false);
  const [localSendStartedAt, setLocalSendStartedAt] = useState<string | null>(null);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  const attachmentPreviewHandoffByMessageIdRef = useRef(attachmentPreviewHandoffByMessageId);
  attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  const [timelineAnchorMessageId, setTimelineAnchorMessageId] = useState<MessageId | null>(null);
  const clearTimelineAnchor = useCallback(() => setTimelineAnchorMessageId(null), []);

  const serverMessages = thread?.messages ?? EMPTY_CHAT_MESSAGES;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages) {
      for (const attachment of message.attachments ?? []) {
        if (isImageAttachment(attachment)) attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(
    () =>
      serverMessages.map((message) => {
        if (!message.attachments || message.attachments.length === 0) return message;
        return {
          ...message,
          attachments: message.attachments.map((attachment) => {
            const previewUrl = serverAttachmentUrlById.get(attachment.id);
            return previewUrl ? { ...attachment, previewUrl } : attachment;
          }),
        };
      }),
    [serverAttachmentUrlById, serverMessages],
  );

  const timelineMessages = useMemo(
    () =>
      mergeBoardTimelineMessages(
        displayServerMessages,
        optimisticUserMessages,
        attachmentPreviewHandoffByMessageId,
      ),
    [attachmentPreviewHandoffByMessageId, displayServerMessages, optimisticUserMessages],
  );

  useEffect(() => {
    const serverIds = new Set(serverMessages.map((message) => message.id));
    if (serverIds.size === 0) return;
    const projectedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (projectedMessages.length === 0) return;
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const additions: Record<string, ReadonlyArray<string>> = {};
      for (const message of projectedMessages) {
        const previewUrls = collectUserMessageBlobPreviewUrls(message);
        if (previewUrls.length === 0) {
          revokeUserMessagePreviewUrls(message);
          continue;
        }
        additions[message.id] = previewUrls;
      }
      return Object.keys(additions).length === 0 ? existing : { ...existing, ...additions };
    });
    setOptimisticUserMessages((existing) =>
      existing.filter((message) => !serverIds.has(message.id)),
    );
  }, [optimisticUserMessages, serverMessages]);

  useEffect(() => {
    if (typeof Image === "undefined") return;
    const cleanups: Array<() => void> = [];
    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      const serverMessage = displayServerMessages.find((message) => message.id === messageId);
      const serverPreviewUrls = (serverMessage?.attachments ?? []).flatMap((attachment) =>
        isImageAttachment(attachment) && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }
      let cancelled = false;
      const images: HTMLImageElement[] = [];
      const promoteHandoff = () => {
        if (cancelled) return;
        const removed = removeBoardAttachmentPreviewHandoff(
          attachmentPreviewHandoffByMessageIdRef.current,
          messageId,
        );
        if (!removed) return;
        attachmentPreviewHandoffByMessageIdRef.current = removed.next;
        setAttachmentPreviewHandoffByMessageId(removed.next);
        for (const previewUrl of removed.previewUrls) revokeBlobPreviewUrl(previewUrl);
      };
      void Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              images.push(image);
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => reject(), { once: true });
              image.src = previewUrl;
            }),
        ),
      ).then(
        promoteHandoff,
        // A failed server preview must not revoke the blob URL: it is still
        // the only usable preview for this message. The unmount cleanup owns
        // revocation when the handoff can no longer be displayed.
        () => undefined,
      );
      cleanups.push(() => {
        cancelled = true;
        for (const image of images) image.src = "";
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [attachmentPreviewHandoffByMessageId, displayServerMessages]);

  useEffect(
    () => () => {
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
      for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
        for (const previewUrl of previewUrls) revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );

  const composerRuntimeMode = useComposerDraftStore(
    (state) => state.getComposerDraft(threadRef)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (state) => state.getComposerDraft(threadRef)?.interactionMode ?? null,
  );
  const { runtimeMode, interactionMode } = resolveBoardComposerModes({
    planModeEnabled: settings.planModeEnabled,
    draftRuntimeMode: composerRuntimeMode,
    draftInteractionMode: composerInteractionMode,
    summaryRuntimeMode: summary.runtimeMode,
    summaryInteractionMode: summary.interactionMode,
  });

  const onSend = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      if (!canBeginBoardComposerSend(environmentConnection, sendInFlightRef.current)) return;
      if (localCheckoutStatusGuard === "pending") {
        toastManager.add({
          type: "warning",
          title: "Checking local checkout",
          description: "Wait for the local checkout status, then try again.",
        });
        return;
      }

      sendInFlightRef.current = true;
      const sendStartedAt = new Date().toISOString();
      setIsSendBusy(true);
      setLocalSendStartedAt(sendStartedAt);
      let optimisticMessageId: MessageId | null = null;
      let sentDraft: {
        readonly prompt: string;
        readonly images: ComposerImageAttachment[];
        readonly terminalContexts: TerminalContextDraft[];
        readonly elementContexts: ElementContextDraft[];
        readonly previewAnnotations: PreviewAnnotationPayload[];
        readonly reviewComments: ReviewCommentContext[];
      } | null = null;
      let sendSucceeded = false;
      let sendError: unknown = null;
      try {
        const draft = composerRef.current?.getSendContext();
        if (!draft?.providerAvailable) return;
        // Generic files stay attached to the durable draft for the full-thread
        // composer. The board's inline sender only serializes images, so it
        // must never clear or partially send a draft that still owns files.
        if (draft.files.length > 0) return;
        const sendState = deriveComposerSendState({
          prompt: draft.prompt,
          imageCount: draft.images.length,
          terminalContexts: draft.terminalContexts,
          elementContextCount:
            draft.elementContexts.length +
            draft.previewAnnotations.length +
            draft.reviewComments.length,
        });
        const feedbackCommand = parseBoardCodexFeedbackCommand({
          provider: draft.selectedProvider,
          prompt: sendState.trimmedPrompt,
          hasAttachments: draft.images.length > 0,
          hasContexts:
            sendState.sendableTerminalContexts.length > 0 ||
            draft.elementContexts.length > 0 ||
            draft.previewAnnotations.length > 0 ||
            draft.reviewComments.length > 0,
        });
        if (feedbackCommand !== null) {
          toastManager.add({
            type: "warning",
            title: "Submit feedback from the full thread",
            description:
              "Open this thread to use the Codex feedback flow instead of sending it as a message.",
          });
          return;
        }
        const standaloneSlashCommand = parseBoardStandaloneComposerSlashCommand({
          planModeEnabled: settings.planModeEnabled,
          prompt: sendState.trimmedPrompt,
          hasAttachments: draft.images.length > 0 || draft.files.length > 0,
          hasContexts:
            sendState.sendableTerminalContexts.length > 0 ||
            draft.elementContexts.length > 0 ||
            draft.previewAnnotations.length > 0 ||
            draft.reviewComments.length > 0,
        });
        if (standaloneSlashCommand !== null) {
          const draftStore = useComposerDraftStore.getState();
          draftStore.setInteractionMode(threadRef, standaloneSlashCommand);
          promptRef.current = "";
          composerImagesRef.current = [];
          draftStore.clearComposerContent(threadRef);
          composerRef.current?.resetCursorState();
          return;
        }
        const expiredTerminalContextToast = resolveBoardExpiredTerminalContextToastCopy(
          sendState.expiredTerminalContextCount,
          sendState.hasSendableContent,
        );
        if (!sendState.hasSendableContent) {
          if (expiredTerminalContextToast !== null) {
            toastManager.add({
              type: "warning",
              title: expiredTerminalContextToast.title,
              description: expiredTerminalContextToast.description,
            });
          }
          return;
        }
        const messageTextWithContexts = buildBoardComposerMessageText({
          prompt: draft.prompt,
          terminalContexts: sendState.sendableTerminalContexts,
          elementContexts: draft.elementContexts,
          previewAnnotations: draft.previewAnnotations,
          reviewComments: draft.reviewComments,
        });
        const outgoingMessageText = formatOutgoingPrompt({
          provider: draft.selectedProvider,
          model: draft.selectedModel,
          models: draft.selectedProviderModels,
          effort: draft.selectedPromptEffort,
          text: messageTextWithContexts || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        });
        if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) return;
        const requestedModelSelection = draft.selectedModelSelection;
        const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
          providers: providerStatuses,
          hasStartedSession: summary.session !== null,
          currentModelSelection: summary.modelSelection,
          currentProviderInstanceId: summary.session?.providerInstanceId ?? null,
          nextModelSelection: requestedModelSelection,
        });
        if (modelChangeBlockReason) {
          toastManager.add({
            type: "warning",
            title: modelChangeBlockReason.title,
            description: modelChangeBlockReason.description,
          });
          return;
        }
        const modelSelection = requestedModelSelection;
        const messageId = newMessageId();
        const createdAt = sendStartedAt;
        const optimisticAttachments = draft.images.map((image) => ({
          type: "image" as const,
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          previewUrl: image.previewUrl,
        }));
        optimisticMessageId = messageId;
        sentDraft = {
          prompt: draft.prompt,
          images: [...draft.images],
          terminalContexts: [...draft.terminalContexts],
          elementContexts: [...draft.elementContexts],
          previewAnnotations: [...draft.previewAnnotations],
          reviewComments: [...draft.reviewComments],
        };
        setTimelineAnchorMessageId(messageId);
        setOptimisticUserMessages((existing) => [
          ...existing,
          {
            id: messageId,
            role: "user",
            text: outgoingMessageText,
            ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
            turnId: null,
            createdAt,
            updatedAt: createdAt,
            streaming: false,
          },
        ]);
        promptRef.current = "";
        composerImagesRef.current = [];
        useComposerDraftStore.getState().clearComposerContent(threadRef);
        composerRef.current?.resetCursorState();

        const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
          currentModelSelection: summary.modelSelection,
          ...(localCheckoutBranchMismatch
            ? { nextBranch: localCheckoutBranchMismatch.currentBranch }
            : {}),
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
              sendError = squashAtomCommandFailure(metadataResult);
            }
            return;
          }
        }
        if (runtimeMode !== (summary.runtimeMode ?? DEFAULT_RUNTIME_MODE)) {
          const runtimeModeResult = await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: threadRef.threadId,
              runtimeMode,
              createdAt,
            },
          });
          if (runtimeModeResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(runtimeModeResult)) {
              sendError = squashAtomCommandFailure(runtimeModeResult);
            }
            return;
          }
        }
        if (interactionMode !== (summary.interactionMode ?? DEFAULT_INTERACTION_MODE)) {
          const interactionModeResult = await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: threadRef.threadId,
              interactionMode,
              createdAt,
            },
          });
          if (interactionModeResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(interactionModeResult)) {
              sendError = squashAtomCommandFailure(interactionModeResult);
            }
            return;
          }
        }
        const images = [...draft.images];
        let attachments;
        if (supportsAttachmentUploads && images.length > 0) {
          for (const image of images) {
            // ChatComposer normally starts this when the image enters the
            // draft. Repeating it closes the add-to-send race; the queue is
            // idempotent for an existing job or ready upload.
            startAttachmentUpload({
              environmentId,
              image,
              draftTarget: threadRef,
            });
          }
          await awaitAttachmentUploads(images.map((image) => image.id));
          attachments = getUploadedAttachments({ environmentId, images });
          if (attachments === null) {
            throw new Error("Retry or remove failed uploads before sending.");
          }
        } else {
          attachments = await Promise.all(
            images.map(async (image) => ({
              type: "image" as const,
              name: image.name,
              mimeType: image.mimeType,
              sizeBytes: image.sizeBytes,
              dataUrl: await readFileAsDataUrl(image.file),
            })),
          );
        }
        const result = await startThreadTurn({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            message: {
              messageId,
              role: "user",
              text: outgoingMessageText,
              attachments,
            },
            modelSelection,
            titleSeed: summary.title,
            runtimeMode,
            interactionMode,
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            sendError = squashAtomCommandFailure(result);
          }
          return;
        }
        const wokeAt = threadWokeAt(summary, { now: createdAt });
        if (wokeAt !== null) {
          useUiStateStore.getState().markThreadVisited(scopedThreadKey(threadRef), wokeAt);
        }
        sendSucceeded = true;
        // A ready upload can outlive a capability change while this send is
        // in flight. Release any queue state only after the turn owns the
        // message, whether the message used upload references or data URLs.
        releaseDraftAttachments(images);
        if (expiredTerminalContextToast !== null) {
          toastManager.add({
            type: "warning",
            title: expiredTerminalContextToast.title,
            description: expiredTerminalContextToast.description,
          });
        }
      } catch (error) {
        sendError = error;
      } finally {
        if (!sendSucceeded && optimisticMessageId !== null && sentDraft !== null) {
          const currentDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
          const canRestoreDraft = boardComposerDraftCanBeRestored(currentDraft);
          if (canRestoreDraft) {
            setOptimisticUserMessages((existing) => {
              const removed = existing.filter((message) => message.id === optimisticMessageId);
              for (const message of removed) revokeUserMessagePreviewUrls(message);
              return existing.filter((message) => message.id !== optimisticMessageId);
            });
            setTimelineAnchorMessageId((current) =>
              current === optimisticMessageId ? null : current,
            );
            const retryImages = sentDraft.images.map(cloneComposerImageForRetry);
            promptRef.current = sentDraft.prompt;
            composerImagesRef.current = retryImages;
            composerTerminalContextsRef.current = sentDraft.terminalContexts;
            composerElementContextsRef.current = sentDraft.elementContexts;
            const draftStore = useComposerDraftStore.getState();
            draftStore.setPrompt(threadRef, sentDraft.prompt);
            draftStore.addImages(threadRef, retryImages);
            draftStore.setTerminalContexts(threadRef, sentDraft.terminalContexts);
            draftStore.setElementContexts(threadRef, sentDraft.elementContexts);
            draftStore.setPreviewAnnotations(threadRef, sentDraft.previewAnnotations);
            draftStore.setReviewComments(threadRef, sentDraft.reviewComments);
            composerRef.current?.resetCursorState({
              prompt: sentDraft.prompt,
              cursor: sentDraft.prompt.length,
              detectTrigger: true,
            });
          }
          if (sendError !== null) {
            toastManager.add({
              type: "error",
              title: "Failed to send message",
              description:
                sendError instanceof Error
                  ? sendError.message
                  : canRestoreDraft
                    ? "The message was restored."
                    : "The failed message remains in the timeline; try again from the full thread.",
            });
          }
        }
        sendInFlightRef.current = false;
        setIsSendBusy(false);
        setLocalSendStartedAt(null);
      }
    },
    [
      environmentConnection.phase,
      environmentId,
      interactionMode,
      localCheckoutBranchMismatch,
      localCheckoutStatusGuard,
      providerStatuses,
      runtimeMode,
      settings.planModeEnabled,
      supportsAttachmentUploads,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startThreadTurn,
      summary,
      threadRef,
      updateThreadMetadata,
    ],
  );

  const onInterrupt = useCallback(async () => {
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(summary),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Failed to interrupt current turn",
        description: error instanceof Error ? error.message : "Try again from the full thread.",
      });
    }
  }, [environmentId, interruptThreadTurn, summary]);

  const setThreadError = useCallback<ChatComposerProps["setThreadError"]>((_threadId, error) => {
    if (error === null) return;
    toastManager.add({
      type: "error",
      title: "Attachment not added",
      description: error,
    });
  }, []);

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to submit approval",
          description: error instanceof Error ? error.message : "Try again from the full thread.",
        });
      }
      return result;
    },
    [environmentId, respondToThreadApproval, threadRef],
  );

  const setComposerDraftModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((state) => state.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (state) => state.setInteractionMode,
  );
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

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadRef, mode);
    },
    [runtimeMode, setComposerDraftRuntimeMode, threadRef],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (!settings.planModeEnabled && mode === "plan") return;
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadRef, mode);
    },
    [interactionMode, setComposerDraftInteractionMode, settings.planModeEnabled, threadRef],
  );

  const toggleInteractionMode = useCallback(() => {
    const next: ProviderInteractionMode =
      interactionMode === "plan" ? DEFAULT_INTERACTION_MODE : "plan";
    handleInteractionModeChange(next);
  }, [handleInteractionModeChange, interactionMode]);

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
      attachmentUploadsCapabilityKnown,
      supportsAttachmentUploads,
      allowGenericFileAttachments: false,
      // Generic files stay visible in retained drafts, but require the full
      // thread route to send them instead of silently dropping them.
      maxFileAttachmentBytes: null,
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
      sendDisabledReason: summary.hasPendingUserInput
        ? "Answer requested input in the full thread"
        : null,
      isPreparingWorktree: false,
      bannerItems: EMPTY_COMPOSER_BANNER_ITEMS,
      environmentUnavailable:
        environmentConnection.phase === "connected"
          ? null
          : { label: environmentLabel, connection: environmentConnection },
      activePendingApproval,
      pendingApprovals,
      pendingUserInputs: EMPTY_PENDING_USER_INPUTS,
      activePendingProgress: null,
      activePendingResolvedAnswers: null,
      activePendingIsResponding: false,
      activePendingDraftAnswers: EMPTY_PENDING_USER_INPUT_DRAFT_ANSWERS,
      activePendingQuestionIndex: 0,
      respondingRequestIds,
      // Plan implementation is owned by the full-thread route: the embedded
      // sender cannot carry sourceProposedPlan safely. Plan Ready cards expose
      // an explicit link to that route instead of rendering a misleading
      // inline Implement action.
      showPlanFollowUpPrompt: false,
      activeProposedPlan: null,
      activeTasksProgress: null,
      activeTaskSteps: null,
      threadSyncPhase: null,
      runtimeMode,
      interactionMode,
      lockedProvider,
      providerStatuses,
      activeProjectDefaultModelSelection: project?.defaultModelSelection,
      activeThreadModelSelection: summary.modelSelection,
      activeContextWindow: null,
      compactDisabled: false,
      compactDisabledReason: null,
      resolvedTheme,
      settings,
      keybindings,
      terminalOpen: false,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerFilesRef,
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
      focusComposer,
      scheduleComposerFocus: focusComposer,
      setThreadError,
      onExpandImage,
      onFileOpen,
      openingVideoAttachmentId: null,
      embedded: true,
    }),
    [
      composerRef,
      threadRef,
      environmentId,
      attachmentUploadsCapabilityKnown,
      supportsAttachmentUploads,
      thread,
      phase,
      isConnecting,
      isSendBusy,
      activePendingApproval,
      pendingApprovals,
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
      respondingRequestIds,
      onProviderModelSelect,
      getModelDisabledReason,
      toggleInteractionMode,
      handleRuntimeModeChange,
      handleInteractionModeChange,
      focusComposer,
      setThreadError,
      onExpandImage,
      onFileOpen,
    ],
  );

  return {
    chatComposerProps,
    composerRef,
    localSendStartedAt,
    hasRetainedOptimisticMessages: optimisticUserMessages.length > 0,
    timelineMessages,
    timelineAnchorMessageId,
    clearTimelineAnchor,
  };
}
