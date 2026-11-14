import type { EnvironmentId } from "@t3tools/contracts";
import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { appAtomRegistry } from "./atom-registry";
import {
  composerCloudDraftsAtom,
  composerDraftsAtom,
  type ComposerDraft,
} from "./composer-drafts-model";
import {
  flushComposerDrafts,
  schedulePersistComposerState,
  updateComposerDrafts,
  waitForComposerDraftsLoaded,
} from "./composer-drafts-persistence";
import { mergeComposerDraftText, mergeReferencedComposerContext } from "./composer-drafts-merge";
import { flushThreadOutbox, threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { DraftComposerAttachment } from "../lib/composerImages";

export async function getComposerCloudAccountId(): Promise<string | null> {
  await waitForComposerDraftsLoaded();
  return appAtomRegistry.get(composerCloudDraftsAtom).accountId;
}

export async function archiveCloudComposerDrafts(
  accountId: string | null,
  environmentIds: ReadonlySet<EnvironmentId>,
  knownEnvironmentIds: Iterable<EnvironmentId>,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  if (!(await threadOutboxManager.load())) throw new Error("Could not preserve queued messages.");
  await flushThreadOutbox();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const owner = accountId ?? cloud.accountId;
  if (owner === null) return;
  const queued = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  const current = appAtomRegistry.get(composerDraftsAtom);
  const remaining = { ...current };
  const savedDrafts = { ...cloud.signedOut[owner]?.drafts };
  for (const [key, draft] of Object.entries(current)) {
    const environmentId = composerDraftEnvironmentId(key, knownEnvironmentIds, queued, draft);
    if (environmentId !== null && environmentIds.has(environmentId)) {
      savedDrafts[key] = draft;
      delete remaining[key];
    }
  }
  const savedMessages = new Map(
    (cloud.signedOut[owner]?.queuedMessages ?? []).map((message) => [message.messageId, message]),
  );
  for (const message of queued) {
    if (environmentIds.has(message.environmentId)) savedMessages.set(message.messageId, message);
  }
  appAtomRegistry.set(composerDraftsAtom, remaining);
  appAtomRegistry.set(composerCloudDraftsAtom, {
    // Retain the owner through removal so cold-start cleanup can retry before another account activates.
    accountId: owner,
    signedOut: {
      ...cloud.signedOut,
      [owner]: { drafts: savedDrafts, queuedMessages: [...savedMessages.values()] },
    },
  });
  schedulePersistComposerState();
  await flushComposerDrafts();
}

function sameDraftAttachmentIds(
  left: ReadonlyArray<DraftComposerAttachment>,
  right: ReadonlyArray<DraftComposerAttachment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

/** An in-flight delivery can finish after sign-out took its snapshot. */
export async function removeDeliveredCloudQueuedMessage(
  message: QueuedThreadMessage,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const signedOut = { ...cloud.signedOut };
  let changed = false;
  for (const [accountId, saved] of Object.entries(signedOut)) {
    const archived = saved.queuedMessages.find(
      (candidate) =>
        candidate.environmentId === message.environmentId &&
        candidate.messageId === message.messageId,
    );
    if (
      !archived ||
      archived.commandId !== message.commandId ||
      archived.threadId !== message.threadId ||
      archived.text !== message.text ||
      !sameDraftAttachmentIds(archived.attachments, message.attachments)
    )
      continue;
    if (
      JSON.stringify([
        archived.modelSelection,
        archived.runtimeMode,
        archived.interactionMode,
        archived.creation,
      ]) !==
      JSON.stringify([
        message.modelSelection,
        message.runtimeMode,
        message.interactionMode,
        message.creation,
      ])
    )
      continue;
    const editorKey = `pending-task:${message.messageId}`;
    const editor = saved.drafts[editorKey];
    if (
      editor &&
      (editor.text !== message.text ||
        !sameDraftAttachmentIds(editor.attachments, message.attachments) ||
        (editor.modelSelection !== undefined &&
          JSON.stringify(editor.modelSelection) !== JSON.stringify(message.modelSelection)) ||
        (editor.runtimeMode !== undefined && editor.runtimeMode !== message.runtimeMode) ||
        (editor.interactionMode !== undefined &&
          editor.interactionMode !== message.interactionMode) ||
        (editor.workspaceSelection !== undefined &&
          (editor.workspaceSelection.mode !== message.creation?.workspaceMode ||
            editor.workspaceSelection.branch !== message.creation?.branch ||
            editor.workspaceSelection.worktreePath !== message.creation?.worktreePath ||
            editor.workspaceSelection.pullRequestReference !==
              message.creation?.pullRequestReference ||
            (editor.workspaceSelection.startFromOrigin ?? false) !==
              (message.creation?.startFromOrigin ?? false))))
    )
      continue;
    const drafts = { ...saved.drafts };
    delete drafts[editorKey];
    signedOut[accountId] = {
      drafts,
      queuedMessages: saved.queuedMessages.filter((candidate) => candidate !== archived),
    };
    changed = true;
  }
  if (!changed) return;
  appAtomRegistry.set(composerCloudDraftsAtom, { ...cloud, signedOut });
  schedulePersistComposerState();
  try {
    await flushComposerDrafts();
  } catch (error) {
    // Keep archive updates pending after failure; live outbox removal can still require a later successful flush.
    schedulePersistComposerState();
    throw error;
  }
}

export async function restoreCloudComposerDrafts(accountId: string): Promise<void> {
  await waitForComposerDraftsLoaded();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const saved = cloud.signedOut[accountId];
  if (saved) {
    if (!(await threadOutboxManager.load())) throw new Error("Could not restore queued messages.");
    for (const message of saved.queuedMessages) {
      const alreadyQueued = Object.values(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )
        .flat()
        .some((current) => current.messageId === message.messageId);
      if (!alreadyQueued) await threadOutboxManager.enqueue(message);
    }
    updateComposerDrafts((current) => {
      const restored = { ...current };
      for (const [key, draft] of Object.entries(saved.drafts)) {
        const existing = current[key];
        const attachmentIds = new Set(existing?.attachments.map((attachment) => attachment.id));
        restored[key] = existing
          ? {
              ...draft,
              ...existing,
              text: mergeComposerDraftText(existing.text, draft.text),
              context: mergeReferencedComposerContext(
                mergeComposerDraftText(existing.text, draft.text),
                draft.context,
                existing.context,
              ),
              // A concurrent import must not lose files, even above the send limit.
              attachments: [
                ...existing.attachments,
                ...draft.attachments.filter((attachment) => !attachmentIds.has(attachment.id)),
              ],
              importedShareIds: [
                ...new Set([
                  ...(existing.importedShareIds ?? []),
                  ...(draft.importedShareIds ?? []),
                ]),
              ],
            }
          : draft;
      }
      return restored;
    });
  }
  const signedOut = { ...cloud.signedOut };
  delete signedOut[accountId];
  appAtomRegistry.set(composerCloudDraftsAtom, { accountId, signedOut });
  schedulePersistComposerState();
  await flushComposerDrafts();
}
