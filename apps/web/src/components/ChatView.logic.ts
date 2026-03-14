import { ProjectId, type GitBranch, type ProviderKind, type ThreadId } from "@t3tools/contracts";
import { type ChatMessage, type Thread } from "../types";
import { randomUUID } from "~/lib/utils";
import { getAppModelOptions } from "../appSettings";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type DraftThreadState,
} from "../composerDraftStore";
import { Schema } from "effect";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const WORKTREE_BRANCH_PREFIX = "t3code";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModel: string,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    model: fallbackModel,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
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

export type InitialWorktreeCreation =
  | { type: "none" }
  | { type: "open-worktree"; branch: string }
  | { type: "new-worktree"; branch: string; newBranch: string };

export function resolvePendingWorktreeBranchForSend(input: {
  envMode: DraftThreadEnvMode;
  isFirstMessage: boolean;
  branch: string | null;
  currentGitBranch: string | null;
  worktreePath: string | null;
}): string | null {
  const { envMode, isFirstMessage, branch, currentGitBranch, worktreePath } = input;

  if (branch) {
    return branch;
  }

  if (!isFirstMessage || worktreePath) {
    return null;
  }

  if (envMode === "worktree" || envMode === "open-worktree") {
    return currentGitBranch;
  }

  return null;
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

export function resolveInitialWorktreeCreation(input: {
  envMode: DraftThreadEnvMode;
  isFirstMessage: boolean;
  branch: string | null;
  worktreePath: string | null;
  buildNewBranchName: () => string;
}): InitialWorktreeCreation {
  const { envMode, isFirstMessage, branch, worktreePath, buildNewBranchName } = input;

  if (!isFirstMessage || worktreePath || !branch) {
    return { type: "none" };
  }

  if (envMode === "worktree") {
    return {
      type: "new-worktree",
      branch,
      newBranch: buildNewBranchName(),
    };
  }

  if (envMode === "open-worktree") {
    return {
      type: "open-worktree",
      branch,
    };
  }

  return { type: "none" };
}

export function resolveOpenWorktreeReuseCandidate(input: {
  activeProjectCwd: string;
  branches: ReadonlyArray<GitBranch>;
  branchName: string;
}): { branch: string; worktreePath: string | null } | null {
  const matchingBranch = input.branches.find(
    (branch) => !branch.isRemote && branch.name === input.branchName && branch.worktreePath,
  );
  if (!matchingBranch?.worktreePath) {
    return null;
  }

  return {
    branch: matchingBranch.name,
    worktreePath:
      matchingBranch.worktreePath === input.activeProjectCwd ? null : matchingBranch.worktreePath,
  };
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

export function getCustomModelOptionsByProvider(settings: {
  customCodexModels: readonly string[];
}): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  return {
    codex: getAppModelOptions("codex", settings.customCodexModels),
  };
}
