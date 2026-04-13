import {
  type EnvironmentId,
  type MessageId,
  ProjectId,
  type ModelSelection,
  type ProviderKind,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@marcode/contracts";
import {
  type ChatImageAttachment,
  type ChatMessage,
  type SessionPhase,
  type Thread,
} from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import { selectThreadByRef, selectThreadsAcrossEnvironments, useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { INLINE_JIRA_CONTEXT_PLACEHOLDER, type JiraTaskDraft } from "../lib/jiraContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "marcode:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
  additionalDirectories: readonly string[] = [],
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    additionalDirectories: [...additionalDirectories],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

function stripInlineJiraContextPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_JIRA_CONTEXT_PLACEHOLDER, "");
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  jiraTaskContexts?: ReadonlyArray<JiraTaskDraft>;
  quotedContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineJiraContextPlaceholders(
    stripInlineTerminalContextPlaceholders(options.prompt),
  ).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const jiraTaskContexts = options.jiraTaskContexts ?? [];
  const quotedContextCount = options.quotedContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      jiraTaskContexts.length > 0 ||
      quotedContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: ProviderKind | null;
  threadProvider: ProviderKind | null;
}): ProviderKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  return input.thread?.session?.provider ?? input.threadProvider ?? input.selectedProvider ?? null;
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const latestTurnCompletedAt = latestTurn?.completedAt ?? null;
  if (latestTurnCompletedAt === null) {
    return false;
  }
  return (
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== latestTurnCompletedAt
  );
}

export const EDIT_REVERT_SYNC_TIMEOUT_MS = 15_000;

export type RevertOutcome =
  | { ok: true }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "revert-failed"; detail: string };

export async function waitForRevertOutcome(
  threadId: ThreadId,
  messageId: MessageId,
  timeoutMs = EDIT_REVERT_SYNC_TIMEOUT_MS,
): Promise<RevertOutcome> {
  const getThread = () =>
    selectThreadsAcrossEnvironments(useStore.getState()).find((thread) => thread.id === threadId);

  const initialActivityCount = getThread()?.activities.length ?? 0;

  const threadContainsMessage = () => {
    const thread = getThread();
    return thread
      ? thread.messages.some((m: Thread["messages"][number]) => m.id === messageId)
      : false;
  };

  const detectRevertFailure = (): string | null => {
    const thread = getThread();
    if (!thread) return null;
    const newActivities = thread.activities.slice(initialActivityCount);
    const failure = newActivities.find(
      (a: Thread["activities"][number]) => a.kind === "checkpoint.revert.failed",
    );
    if (!failure) return null;
    const payload = failure.payload as Record<string, unknown> | null;
    return (typeof payload?.detail === "string" ? payload.detail : null) ?? failure.summary;
  };

  if (!threadContainsMessage()) {
    return { ok: true };
  }

  return await new Promise<RevertOutcome>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: RevertOutcome) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe(() => {
      if (!threadContainsMessage()) {
        finish({ ok: true });
        return;
      }
      const failureDetail = detectRevertFailure();
      if (failureDetail !== null) {
        finish({ ok: false, reason: "revert-failed", detail: failureDetail });
      }
    });

    if (!threadContainsMessage()) {
      finish({ ok: true });
      return;
    }
    const immediateFailure = detectRevertFailure();
    if (immediateFailure !== null) {
      finish({ ok: false, reason: "revert-failed", detail: immediateFailure });
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}

export async function materializeMessageImageAttachmentForEdit(
  attachment: ChatImageAttachment,
): Promise<ComposerImageAttachment | null> {
  if (!attachment.previewUrl) {
    return null;
  }
  try {
    const response = await fetch(attachment.previewUrl);
    const blob = await response.blob();
    const file = new File([blob], attachment.name, { type: attachment.mimeType });
    const previewUrl = URL.createObjectURL(file);
    return {
      type: "image" as const,
      id: attachment.id,
      file,
      name: attachment.name,
      previewUrl,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  } catch {
    return null;
  }
}
