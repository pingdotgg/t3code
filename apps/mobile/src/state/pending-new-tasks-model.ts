import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId, ProjectId } from "@t3tools/contracts";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import {
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { isNewTaskDraftKey } from "./new-task-draft-key";
import type { ComposerDraft } from "./use-composer-drafts";
import { resolveNewTaskDraftWorkspace } from "../features/threads/new-task-context-presentation";

export type PendingNewTask = PendingQueuedTask | PendingDraftTask;

export interface PendingQueuedTask {
  readonly kind: "pending";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string | undefined;
  readonly projectCwd: string | undefined;
  readonly branch: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
}

export interface PendingDraftTask {
  readonly kind: "draft";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: undefined;
  readonly projectCwd: undefined;
  readonly title: string;
  readonly createdAt: string;
  readonly draftKey: string;
  readonly draft: ComposerDraft;
}

function composerDraftHasUserContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

function draftTitle(draft: ComposerDraft): string {
  if (draft.text.trim().length > 0) {
    return deriveThreadTitleFromPrompt(draft.text);
  }
  const count = draft.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

/** A project's new-task defaults, as useNewTaskProjectDefaults resolves them. */
export interface PendingDraftProjectDefaults {
  readonly canChooseWorkspace: boolean;
  readonly defaultMode: "local" | "worktree";
  readonly defaultModeSettled: boolean;
}

/**
 * True when the draft's branch is derived from refs rather than stored, so the list must load
 * refs to show it.
 */
export function pendingDraftBranchNeedsRefs(
  draft: ComposerDraft,
  defaults: PendingDraftProjectDefaults,
): boolean {
  const selection = defaults.canChooseWorkspace ? draft.workspaceSelection : undefined;
  return selection === undefined ? defaults.defaultMode === "worktree" : selection.branch === null;
}

/** The branch a draft will start on, derived the same way the new-task flow and send path do. */
export function resolvePendingDraftBranch(input: {
  readonly draft: ComposerDraft;
  readonly defaults: PendingDraftProjectDefaults;
  readonly isGitRepo: boolean;
  readonly branches: Parameters<typeof resolveNewTaskDraftWorkspace>[0]["branches"];
  readonly projectCwd: string | null;
}): string | null {
  return resolveNewTaskDraftWorkspace({
    selection: input.draft.workspaceSelection,
    canChooseWorkspace: input.defaults.canChooseWorkspace,
    defaultMode: input.defaults.defaultMode,
    defaultModeSettled: input.defaults.defaultModeSettled,
    isGitRepo: input.isGitRepo,
    branches: input.branches,
    projectCwd: input.projectCwd,
  }).branch;
}

export interface ThreadOutboxSendGate {
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly operableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly shellStatuses: ReadonlyMap<EnvironmentId, EnvironmentShellStatus>;
  readonly retryingMessageIds: Readonly<Partial<Record<MessageId, true>>>;
}

/** The outbox drain's gate for a creation: sendable, connected, shell live, operate granted, not backing off. */
export function isQueuedCreationSending(
  message: QueuedThreadMessage,
  gate: ThreadOutboxSendGate,
): boolean {
  const environmentId = message.environmentId;
  return (
    isQueuedThreadCreationSendable(message) &&
    gate.retryingMessageIds[message.messageId] !== true &&
    gate.operableEnvironmentIds.has(environmentId) &&
    resolveThreadOutboxDeliveryAction({
      isCreation: true,
      threadExists: false,
      shellStatus: gate.shellStatuses.get(environmentId) ?? "empty",
      environmentConnected: gate.connectedEnvironmentIds.has(environmentId),
    }) === "send"
  );
}

export function buildPendingNewTasks(input: {
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly drafts: Readonly<Record<string, ComposerDraft>>;
  readonly sendGate: ThreadOutboxSendGate;
}): ReadonlyArray<PendingNewTask> {
  const tasks: PendingNewTask[] = [];
  for (const message of input.queuedMessages) {
    // Listing a creation already being sent would flash an "Unsent" row.
    if (!message.creation || isQueuedCreationSending(message, input.sendGate)) {
      continue;
    }
    tasks.push({
      kind: "pending",
      key: `pending-task:${message.messageId}`,
      environmentId: message.environmentId,
      projectId: message.creation.projectId,
      projectTitle: message.creation.projectTitle,
      projectCwd: message.creation.projectCwd,
      branch: message.creation.branch,
      title: deriveThreadTitleFromPrompt(message.text),
      createdAt: message.createdAt,
      message,
      creation: message.creation,
    });
  }
  for (const [draftKey, draft] of Object.entries(input.drafts)) {
    if (!isNewTaskDraftKey(draftKey) || !draft.project || !composerDraftHasUserContent(draft)) {
      continue;
    }
    tasks.push({
      kind: "draft",
      key: `draft-task:${draftKey}`,
      environmentId: draft.project.environmentId,
      projectId: draft.project.projectId,
      projectTitle: undefined,
      projectCwd: undefined,
      title: draftTitle(draft),
      createdAt: draft.project.createdAt,
      draftKey,
      draft,
    });
  }
  tasks.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "draft" ? -1 : 1;
    }
    return right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key);
  });
  return tasks;
}
