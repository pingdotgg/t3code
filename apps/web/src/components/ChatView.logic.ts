import {
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { type FollowUpBehavior } from "@t3tools/contracts/settings";
import { type ChatMessage, type QueuedFollowUp, type Thread } from "../types";
import { randomUUID } from "~/lib/utils";
import {
  type ComposerImageAttachment,
  type DraftThreadState,
  type PersistedComposerImageAttachment,
} from "../composerDraftStore";
import { Schema } from "effect";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const WORKTREE_BRANCH_PREFIX = "t3code";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    queuedFollowUps: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    lastVisitedAt: draftThread.createdAt,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
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

export type SendPhase = "idle" | "preparing-worktree" | "sending-turn";

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

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
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

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
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

export function resolveFollowUpBehavior(
  followUpBehavior: FollowUpBehavior,
  invert: boolean,
): FollowUpBehavior {
  if (!invert) {
    return followUpBehavior;
  }
  return followUpBehavior === "queue" ? "steer" : "queue";
}

export function shouldInvertFollowUpBehaviorFromKeyEvent(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
): boolean {
  if (!event.shiftKey || event.altKey) {
    return false;
  }
  if (isMacPlatform(platform)) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}

export function followUpBehaviorShortcutLabel(platform = navigator.platform): string {
  return isMacPlatform(platform) ? "Cmd+Shift+Enter" : "Ctrl+Shift+Enter";
}

export interface QueuedFollowUpDraftSnapshot {
  id: string;
  createdAt: string;
  prompt: string;
  attachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

export function buildQueuedFollowUpDraft(input: {
  prompt: string;
  attachments: ReadonlyArray<PersistedComposerImageAttachment>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  createdAt: string;
}): QueuedFollowUpDraftSnapshot {
  return {
    id: randomUUID(),
    createdAt: input.createdAt,
    prompt: input.prompt,
    attachments: [...input.attachments],
    terminalContexts: input.terminalContexts.map((context) => ({ ...context })),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
  };
}

export function canAutoDispatchQueuedFollowUp(input: {
  phase: "disconnected" | "connecting" | "ready" | "running";
  queuedFollowUpCount: number;
  queuedHeadHasError: boolean;
  isConnecting: boolean;
  isSendBusy: boolean;
  isRevertingCheckpoint: boolean;
  hasThreadError: boolean;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
}): boolean {
  return (
    input.phase === "ready" &&
    input.queuedFollowUpCount > 0 &&
    !input.queuedHeadHasError &&
    !input.isConnecting &&
    !input.isSendBusy &&
    !input.isRevertingCheckpoint &&
    !input.hasThreadError &&
    !input.hasPendingApproval &&
    !input.hasPendingUserInput
  );
}

export function describeQueuedFollowUp(
  followUp: Pick<QueuedFollowUp, "attachments" | "prompt" | "terminalContexts">,
): string {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(followUp.prompt).trim();
  if (trimmedPrompt.length > 0) {
    return trimmedPrompt;
  }
  if (followUp.attachments.length > 0) {
    return followUp.attachments.length === 1
      ? "1 image attached"
      : `${followUp.attachments.length} images attached`;
  }
  if (followUp.terminalContexts.length > 0) {
    return followUp.terminalContexts.length === 1
      ? (followUp.terminalContexts[0]?.terminalLabel ?? "1 terminal context")
      : `${followUp.terminalContexts.length} terminal contexts`;
  }
  return "Follow-up";
}
