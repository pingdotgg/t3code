import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type OrchestrationMessageContext,
  type ProjectId,
} from "@t3tools/contracts";
import { referencedComposerContext } from "../lib/composerContext";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { abortComposerDraftOperations, abortComposerDraftOperationsWhere } from "./composerDraftOperations";
import {
  EMPTY_DRAFT,
  getComposerDraftSnapshot,
  isEmptyDraft,
  newDraftId,
  normalizeDraft,
  withComposerDraft,
  restoreMissingComposerFileReferences,
  type ComposerDraft,
  type ComposerDraftContent,
  type ComposerDraftProject,
} from "./composer-drafts-model";
import { scheduleUnusedComposerAttachmentCleanup, releaseUnusedComposerAttachmentFiles } from "./composer-drafts-attachments";
import {
  cancelPendingComposerPersist,
  updateComposerDrafts,
  waitForComposerDraftsLoaded,
  writeComposerDraftsNow,
} from "./composer-drafts-persistence";
import { appAtomRegistry } from "./atom-registry";
import { composerDraftsAtom } from "./composer-drafts-model";
import { isNewTaskDraftKey, newTaskDraftKey } from "./new-task-draft-key";

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean;
    readonly clearWorkspaceSelection?: boolean;
  },
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const {
    importedShareIds: _importedShareIds,
    context: _context,
    modelSelection,
    workspaceSelection,
    project: _project,
    ...retained
  } = existing;
  const draft = {
    ...retained,
    ...(options?.clearModelSelection || modelSelection === undefined ? {} : { modelSelection }),
    ...(options?.clearWorkspaceSelection || workspaceSelection === undefined
      ? {}
      : { workspaceSelection }),
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

export function restoreComposerDraftSnapshotState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
): Record<string, ComposerDraft> {
  const next = { ...current };
  if (isEmptyDraft(snapshot)) {
    delete next[draftKey];
  } else {
    next[draftKey] = snapshot;
  }
  return next;
}

function stripAttachmentUploadReference(
  attachment: DraftComposerAttachment,
): DraftComposerAttachment {
  const { uploadedAttachmentId: _id, uploadEnvironmentId: _environmentId, ...rest } = attachment;
  return rest;
}

export function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export function mergeReferencedComposerContext(
  text: string,
  first?: OrchestrationMessageContext,
  second?: OrchestrationMessageContext,
) {
  const records = new Map((first?.records ?? []).map((record) => [record.contextId, record]));
  for (const record of second?.records ?? []) records.set(record.contextId, record);
  if (records.size === 0) return undefined;
  return referencedComposerContext(text, { version: 1, records: [...records.values()] });
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (content.sourceShareId && existing.importedShareIds?.includes(content.sourceShareId)) {
    return current;
  }
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id));
  const incomingAttachments = content.attachments.filter((attachment) => {
    if (attachmentIds.has(attachment.id)) {
      return false;
    }
    attachmentIds.add(attachment.id);
    return true;
  });
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
  const text = mergeComposerDraftText(existing.text, content.text);
  const context = mergeReferencedComposerContext(text, existing.context, content.context);
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    content.context === undefined &&
    importedShareIds === existing.importedShareIds
  ) {
    return current;
  }
  return {
    ...current,
    // The composer shows non-image files only as inline chips, so a shared file
    // merged without one would be attached but invisible until sent. Other
    // merges carry their own text, and appending chips to it would defeat
    // mergeComposerDraftText's duplicate check on a retried merge.
    [draftKey]: restoreMissingComposerFileReferences(
      {
        ...existing,
        text,
        attachments,
        context,
        ...(importedShareIds ? { importedShareIds } : {}),
      },
      content.sourceShareId ? attachments.slice(existing.attachments.length) : [],
    ),
  };
}

/** Persists before the share inbox item can be acknowledged. */
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }> {
  await waitForComposerDraftsLoaded();
  cancelPendingComposerPersist();
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = mergeComposerDraftContentState(current, draftKey, content);
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length;
  // Publish content and receipt before awaiting disk; concurrent typing then preserves the receipt in later serialized writes.
  if (next !== current) {
    appAtomRegistry.set(composerDraftsAtom, next);
  }
  await writeComposerDraftsNow(next);
  return { skippedAttachmentCount };
}

export function sameComposerDraftState(a: ComposerDraft, b: ComposerDraft): boolean {
  return (
    a.text === b.text &&
    a.attachments === b.attachments &&
    a.context === b.context &&
    a.importedShareIds === b.importedShareIds &&
    a.modelSelection === b.modelSelection &&
    a.runtimeMode === b.runtimeMode &&
    a.interactionMode === b.interactionMode &&
    a.workspaceSelection === b.workspaceSelection
  );
}

/** Restore untouched drafts exactly; after concurrent edits, remove only merged text and attachments. */
export function undoComposerDraftMergeState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (sameComposerDraftState(existing, merged)) {
    return restoreComposerDraftSnapshotState(current, draftKey, snapshot);
  }
  const insertedText = merged.text.startsWith(snapshot.text)
    ? merged.text.slice(snapshot.text.length)
    : "";
  const snapshotAttachmentIds = new Set(snapshot.attachments.map((attachment) => attachment.id));
  const insertedAttachmentIds = new Set(
    merged.attachments
      .filter((attachment) => !snapshotAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id),
  );
  const undoSetting = <
    K extends "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection",
  >(
    key: K,
  ): ComposerDraft[K] => (existing[key] === merged[key] ? snapshot[key] : existing[key]);
  const text =
    insertedText.length > 0 && existing.text.startsWith(merged.text)
      ? snapshot.text + existing.text.slice(merged.text.length)
      : insertedText.length > 0 && existing.text.endsWith(insertedText)
        ? existing.text.slice(0, existing.text.length - insertedText.length)
        : existing.text;
  const draft = {
    ...existing,
    text,
    context: referencedComposerContext(text, existing.context),
    attachments: existing.attachments.filter(
      (attachment) => !insertedAttachmentIds.has(attachment.id),
    ),
    modelSelection: undoSetting("modelSelection"),
    runtimeMode: undoSetting("runtimeMode"),
    interactionMode: undoSetting("interactionMode"),
    workspaceSelection: undoSetting("workspaceSelection"),
  };
  return withComposerDraft(current, draftKey, draft);
}

export async function undoComposerDraftMerge(
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  cancelPendingComposerPersist();
  const next = undoComposerDraftMergeState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
    merged,
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  await writeComposerDraftsNow(next);
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean;
    readonly clearWorkspaceSelection?: boolean;
    // Defer sweeping during enqueue; rollback can briefly remove ownership before restoring attachments.
    readonly deferAttachmentCleanup?: boolean;
  },
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => clearComposerDraftContentState(current, draftKey, options));
  if (!options?.deferAttachmentCleanup) {
    scheduleUnusedComposerAttachmentCleanup(previousAttachments);
  }
}

export function clearComposerDraft(
  draftKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  abortComposerDraftOperations(draftKey);
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => {
    if (!current[draftKey]) {
      return current;
    }
    const next = { ...current };
    delete next[draftKey];
    return next;
  });
  if (!options?.deferAttachmentCleanup) {
    scheduleUnusedComposerAttachmentCleanup(previousAttachments);
  }
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey, draft]) =>
        !draftKey.startsWith(environmentPrefix) && draft.project?.environmentId !== environmentId,
    ),
  );
}

export function createNewTaskDraft(project: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): string {
  const draftKey = newTaskDraftKey(newDraftId());
  const stamp: ComposerDraftProject = {
    environmentId: project.environmentId,
    projectId: project.projectId,
    createdAt: new Date().toISOString(),
  };
  updateComposerDrafts((current) => ({
    ...current,
    [draftKey]: { ...EMPTY_DRAFT, project: stamp },
  }));
  return draftKey;
}

export function retargetNewTaskDraft(
  draftKey: string,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): void {
  updateComposerDrafts((current) => {
    const existing = current[draftKey];
    const stamp = existing?.project;
    if (
      stamp !== undefined &&
      stamp.environmentId === project.environmentId &&
      stamp.projectId === project.projectId
    ) {
      return current;
    }
    const { workspaceSelection: _workspaceSelection, ...retained } = normalizeDraft(existing);
    // Keep bytes across environment moves but drop server-specific upload stamps.
    const attachments = retained.attachments.map((attachment) =>
      attachment.uploadEnvironmentId !== undefined &&
      attachment.uploadEnvironmentId !== project.environmentId
        ? stripAttachmentUploadReference(attachment)
        : attachment,
    );
    return {
      ...current,
      [draftKey]: {
        ...retained,
        attachments,
        project: {
          environmentId: project.environmentId,
          projectId: project.projectId,
          createdAt: stamp?.createdAt ?? new Date().toISOString(),
        },
      },
    };
  });
}

export function findNewTaskDraftKeys(
  drafts: Readonly<Record<string, ComposerDraft>>,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): ReadonlyArray<string> {
  return Object.entries(drafts)
    .filter(
      ([key, draft]) =>
        isNewTaskDraftKey(key) &&
        draft.project?.environmentId === project.environmentId &&
        draft.project.projectId === project.projectId,
    )
    .sort(([, left], [, right]) =>
      (right.project?.createdAt ?? "").localeCompare(left.project?.createdAt ?? ""),
    )
    .map(([key]) => key);
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  await waitForComposerDraftsLoaded();

  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = removeComposerDraftsForEnvironment(current, environmentId);
  const removedAttachments = Object.entries(current)
    .filter(([draftKey]) => next[draftKey] === undefined)
    .flatMap(([, draft]) => draft.attachments);
  // Keys with no stored draft yet (an empty thread composer) can still have a pick running.
  const environmentPrefix = `${environmentId}:`;
  abortComposerDraftOperationsWhere(
    (draftKey) =>
      draftKey.startsWith(environmentPrefix) ||
      (current[draftKey] !== undefined && next[draftKey] === undefined),
  );

  cancelPendingComposerPersist();
  appAtomRegistry.set(composerDraftsAtom, next);
  await writeComposerDraftsNow(next);
  await releaseUnusedComposerAttachmentFiles(removedAttachments);
}
