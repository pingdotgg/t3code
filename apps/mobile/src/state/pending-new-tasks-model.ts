import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import type { QueuedThreadCreation, QueuedThreadMessage } from "./thread-outbox-model";
import type { ComposerDraft } from "./use-composer-drafts";

/**
 * Unsent work that will become a thread, shaped for thread-list presentation.
 * A `pending` task sits in the outbox and sends itself when its environment
 * reconnects; a `draft` is the project's new-task composer content, which
 * only sends when the user submits it. Both share the list slot so the user
 * can find everything they have written but not yet started in one place.
 */
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
  readonly branch: string | null;
  readonly title: string;
  /** Drafts have no creation timestamp; they sort as current work. */
  readonly createdAt: string;
  readonly draftKey: string;
  readonly draft: ComposerDraft;
}

const NEW_TASK_DRAFT_PREFIX = "new-task:";

/** Parses a `new-task:<environmentId>:<projectId>` composer draft key. */
export function parseNewTaskDraftKey(
  draftKey: string,
): { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null {
  if (!draftKey.startsWith(NEW_TASK_DRAFT_PREFIX)) {
    return null;
  }
  const scope = draftKey.slice(NEW_TASK_DRAFT_PREFIX.length);
  const separator = scope.lastIndexOf(":");
  if (separator <= 0 || separator === scope.length - 1) {
    return null;
  }
  return {
    environmentId: EnvironmentId.make(scope.slice(0, separator)),
    projectId: ProjectId.make(scope.slice(separator + 1)),
  };
}

/**
 * Settings-only drafts (a model pick with no text) are not work the user
 * would look for in the list; only text or attachments make a draft visible.
 */
export function composerDraftHasUserContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

function draftTitle(draft: ComposerDraft): string {
  if (draft.text.trim().length > 0) {
    return deriveThreadTitleFromPrompt(draft.text);
  }
  const count = draft.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

export function buildPendingNewTasks(input: {
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly drafts: Readonly<Record<string, ComposerDraft>>;
  /** ISO timestamp drafts sort by; they carry no creation time of their own. */
  readonly now: string;
}): ReadonlyArray<PendingNewTask> {
  const tasks: PendingNewTask[] = [];
  for (const message of input.queuedMessages) {
    if (!message.creation) {
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
    const ref = parseNewTaskDraftKey(draftKey);
    if (ref === null || !composerDraftHasUserContent(draft)) {
      continue;
    }
    tasks.push({
      kind: "draft",
      key: `draft-task:${draftKey}`,
      environmentId: ref.environmentId,
      projectId: ref.projectId,
      projectTitle: undefined,
      projectCwd: undefined,
      branch: draft.workspaceSelection?.branch ?? null,
      title: draftTitle(draft),
      createdAt: input.now,
      draftKey,
      draft,
    });
  }
  // Drafts are what the user is writing now, so they lead; queued tasks
  // follow newest-first.
  tasks.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "draft" ? -1 : 1;
    }
    return right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key);
  });
  return tasks;
}
