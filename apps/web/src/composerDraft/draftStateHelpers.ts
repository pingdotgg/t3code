import {
  ComposerContextInsertionHandler,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
  ComposerThreadTarget,
  DraftId,
  DraftSessionState,
  DraftThreadEnvMode,
  DraftThreadState,
  PersistedComposerDraftStoreState,
  PersistedComposerImageAttachment,
  ProjectDraftSession,
} from "./draftTypes";
import { ComposerDraftModelState } from "./modelSelectionNormalization";
import { composerFileAttachmentMimeType } from "../components/chat/composerAttachmentFiles";
import {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderDriverKind,
  type PreviewAnnotationPayload,
  RuntimeMode,
  ThreadContextRecord,
  EnvironmentContextRecord,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { readThreadPreviewState } from "../previewStateStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, videoMimeType } from "../types";
import { type TerminalContextDraft, normalizeTerminalContextText } from "../lib/terminalContext";
import { toComposerContextId } from "@t3tools/shared/composerContextReferences";
import { type ReviewCommentContext } from "../reviewCommentContext";

export const contextInsertionHandlers = new Map<string, ComposerContextInsertionHandler>();


export function clearStaleFileUploadMetadata(
  draft: ComposerThreadDraftState,
  environmentId: EnvironmentId,
): ComposerThreadDraftState {
  let changed = false;
  const files = draft.files.map((file) => {
    if (
      (file.uploadedAttachmentId === undefined && file.uploadEnvironmentId === undefined) ||
      file.uploadEnvironmentId === environmentId
    ) {
      return file;
    }

    changed = true;
    const nextFile = { ...file };
    delete nextFile.uploadedAttachmentId;
    delete nextFile.uploadEnvironmentId;
    return nextFile;
  });

  return changed ? { ...draft, files } : draft;
}
export const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyOptionsByModelByProvider: {},
  stickyActiveProvider: null,
});

export const EMPTY_IMAGES: ComposerImageAttachment[] = [];
export const EMPTY_FILES: ComposerFileAttachment[] = [];
export const EMPTY_IDS: string[] = [];
export const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
export const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
export const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = [];
export const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = [];
export const EMPTY_THREAD_CONTEXTS: ThreadContextRecord[] = [];
export const EMPTY_ENVIRONMENT_CONTEXTS: EnvironmentContextRecord[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_FILES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_PREVIEW_ANNOTATIONS);
Object.freeze(EMPTY_REVIEW_COMMENTS);
Object.freeze(EMPTY_THREAD_CONTEXTS);
Object.freeze(EMPTY_ENVIRONMENT_CONTEXTS);
export const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});
export const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  files: EMPTY_FILES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  threadContexts: EMPTY_THREAD_CONTEXTS,
  environmentContexts: EMPTY_ENVIRONMENT_CONTEXTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});
export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Hydrated images get fresh lastModified values, so exclude it from dedupe.
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function composerFileDedupKey(
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): string {
  return `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;
}

export function composerFileMatchesReattachMarker(
  marker: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): boolean {
  if (marker.name !== file.name || marker.sizeBytes !== file.sizeBytes) return false;
  if (marker.mimeType === file.mimeType) return true;
  const normalizedMarkerMimeType = composerFileAttachmentMimeType({
    name: marker.name,
    type: marker.mimeType,
  });
  if (
    normalizedMarkerMimeType === "image/x-adobe-dng" &&
    normalizedMarkerMimeType ===
      composerFileAttachmentMimeType({ name: file.name, type: file.mimeType })
  ) {
    return true;
  }
  const markerMimeType = marker.mimeType.toLowerCase();
  return (
    (markerMimeType === "" || markerMimeType === "application/octet-stream") &&
    videoMimeType(marker) !== null &&
    videoMimeType(file) !== null
  );
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    id: toComposerContextId(context.id),
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    draft.threadContexts.length === 0 &&
    draft.environmentContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}
export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}
export function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

export function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

export function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

export function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

export function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId;
  },
): string {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  if (parsedThreadRef) {
    return composerTargetKey(parsedThreadRef);
  }
  if (options?.environmentId) {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId));
  }
  return threadKeyOrId;
}

export function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

export type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

export function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();
    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }
  return target;
}

export function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);
    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }
    return scopedKey;
  }
  const threadKey = composerTargetKey(normalizedTarget);
  return threadKey.length > 0 ? threadKey : null;
}

export function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }
  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null;
}

export function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

export function draftThreadHasOpenPreview(draftThread: DraftThreadState | undefined): boolean {
  if (draftThread === undefined) return false;
  const ref = scopeThreadRef(draftThread.environmentId, draftThread.threadId);
  return Object.keys(readThreadPreviewState(ref).sessions).length > 0;
}

export function isComposerThreadKeyInUse(mappings: Record<string, string>, threadKey: string): boolean {
  return Object.values(mappings).includes(threadKey);
}

export function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

export function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: {
    threadId?: ThreadId;
    branch?: string | null;
    worktreePath?: string | null;
    createdAt?: string;
    envMode?: DraftThreadEnvMode;
    startFromOrigin?: boolean;
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
    environmentSelection?: "auto" | "manual";
    loadBalancedEnvironmentId?: EnvironmentId | null;
  },
): DraftThreadState {
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);
  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin;
  const environmentSelection =
    options?.environmentSelection ?? existingThread?.environmentSelection;
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    ...(environmentSelection ? { environmentSelection } : {}),
    ...(options?.loadBalancedEnvironmentId !== undefined
      ? { loadBalancedEnvironmentId: options.loadBalancedEnvironmentId }
      : existingThread?.loadBalancedEnvironmentId !== undefined
        ? {
            loadBalancedEnvironmentId: projectChanged
              ? null
              : existingThread.loadBalancedEnvironmentId,
          }
        : {}),
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    promotedTo: null,
  };
}

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

export function draftThreadsEqual(left: DraftThreadState | undefined, right: DraftThreadState): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.environmentSelection === right.environmentSelection &&
    left.loadBalancedEnvironmentId === right.loadBalancedEnvironmentId &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

export function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  >,
  threadKey: string,
  composerDestination?: ScopedThreadRef,
): Pick<
  ComposerDraftStoreState,
  | "draftThreadsByThreadKey"
  | "draftsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>;
  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey;
  const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
  if (composerDestination && removedComposerDraft) {
    restDraftsByThreadKey[composerTargetKey(composerDestination)] = removedComposerDraft;
  } else {
    revokeDraftThreadPreviewUrls(removedComposerDraft);
  }
  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  };
}
