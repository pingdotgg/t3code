import { stripInlineContextReferences } from "./lib/composerContextReferences";
import { composerFileAttachmentMimeType } from "./components/chat/composerAttachmentFiles";
import { elementContextToPreviewAnnotation } from "./lib/elementContext";
import {
  ElementContextDetails,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderOptionSelections,
  PreviewAnnotationPayloadSchema,
  PastedTextAttachmentSource,
  type PreviewAnnotationPayload,
  RuntimeMode,
  ThreadContextRecord,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
  SnapShotSource,
} from "@t3tools/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import { DeepMutable } from "effect/Types";
import {
  createModelSelection,
  draftModelPickMatchesThread,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { readThreadPreviewState } from "./previewStateStore";
import { resolveAppModelSelection, resolveAppModelSelectionForInstance } from "./modelSelection";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatFileAttachment,
  type ChatImageAttachment,
  videoMimeType,
} from "./types";
import {
  type TerminalContextDraft,
  migrateLegacyTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import {
  appendInlineContextReference,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  removeInlineContextReference,
} from "./lib/composerContextReferences";
import {
  fileContextReference,
  previewAnnotationContextId,
  previewAnnotationContextReference,
  reviewCommentContextId,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
} from "./lib/composerContextRecords";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { createDeferredStorage, createMemoryStorage } from "./lib/storage";
import { getDefaultServerModel } from "./providerModels";
import {
  replaceComposerContextReferences,
  toComposerContextId,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { UnifiedSettings } from "@t3tools/contracts/settings";

const isElementContextDetails = Schema.is(ElementContextDetails);
import { ReviewCommentContextSchema, type ReviewCommentContext } from "./reviewCommentContext";
const isRuntimeMode = Schema.is(RuntimeMode);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);
const isThreadContextRecord = Schema.is(ThreadContextRecord);
const isSnapShotSource = Schema.is(SnapShotSource);
const isPreviewAnnotationPayload = Schema.is(PreviewAnnotationPayloadSchema);

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 9;
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  (value) =>
    JSON.stringify({
      state:
        "capturedState" in value.state
          ? partializeComposerDraftStoreState(value.state.capturedState)
          : value.state,
      version: value.version,
    }),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

const composerPersistStorage: PersistStorage<ComposerPersistState> = {
  getItem: (name) => {
    const raw = composerDebouncedStorage.getItem(name);
    if (typeof raw !== "string") {
      return null;
    }
    return JSON.parse(raw) as StorageValue<ComposerPersistState>;
  },
  setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
  removeItem: (name) => composerDebouncedStorage.removeItem(name),
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(SnapShotSource),
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export interface ComposerFileAttachment extends Omit<ChatFileAttachment, "previewUrl"> {
  file: File | null;
  uploadedAttachmentId?: string;
  uploadEnvironmentId?: EnvironmentId;
}

export function composerFileNeedsReattach(file: ComposerFileAttachment): boolean {
  return file.file === null && file.uploadedAttachmentId === undefined;
}

function clearStaleFileUploadMetadata(
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

export const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.String,
  environmentId: EnvironmentId,
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerFileAttachment = typeof PersistedComposerFileAttachment.Type;

/** File handles cannot serialize; metadata-only markers hydrate as needs-reattach rows. */
export const PersistedComposerDraftFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(EnvironmentId),
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerDraftFileAttachment = typeof PersistedComposerDraftFileAttachment.Type;
const isPersistedComposerDraftFileAttachment = Schema.is(PersistedComposerDraftFileAttachment);

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.optionalKey(Schema.String),
});
type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerDraftFileAttachment)),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  reviewComments: Schema.optionalKey(Schema.Array(ReviewCommentContextSchema)),
  threadContexts: Schema.optionalKey(Schema.Array(ThreadContextRecord)),
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  modelSelectionExplicit: Schema.optionalKey(Schema.Boolean),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

type LegacyCodexFields = {
  effort?: unknown;
  codexFastMode?: unknown;
  serviceTier?: unknown;
};

type LegacyThreadModelFields = {
  provider?: unknown;
  model?: unknown;
  modelOptions?: unknown;
};

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: unknown;
};

type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

type LegacyStickyModelFields = {
  stickyProvider?: unknown;
  stickyModel?: unknown;
  stickyModelOptions?: unknown;
};

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: unknown;
  projectDraftThreadIdByProjectId?: Record<string, string> | null;
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadIdByProjectKey?: Record<string, string> | null;
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null;
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null;
};

type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

const PersistedDraftThreadState = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  environmentSelection: Schema.optionalKey(Schema.Literals(["auto", "manual"])),
  loadBalancedEnvironmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  startFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
});
type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftState),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadState),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyOptionsByModelByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, Schema.Record(Schema.String, ProviderOptionSelections)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
});
type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export interface ComposerContextAddOptions {
  appendReference?: boolean;
  allowDuplicateReference?: boolean;
  /** `false` to append synchronously instead of asking a mounted editor for its current caret. */
  insertAtCaret?: boolean;
}

export type ComposerContextInsertionHandler = (
  references: ReadonlyArray<ComposerContextReference>,
) => boolean;
const contextInsertionHandlers = new Map<string, ComposerContextInsertionHandler>();

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  threadContexts: ThreadContextRecord[];
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
  modelSelectionExplicit?: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.threadContexts.length > 0
  );
}

export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  environmentSelection?: "auto" | "manual";
  loadBalancedEnvironmentId?: EnvironmentId | null;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

export type ComposerThreadTarget = ScopedThreadRef | DraftId;

interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  rewindingThreadKeys: ReadonlySet<string>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyOptionsByModelByProvider: Partial<
    Record<ProviderInstanceId, Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
  >;
  stickyActiveProvider: ProviderInstanceId | null;
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftIdByRef: (threadRef: ScopedThreadRef) => DraftId | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
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
  ) => void;
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
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
  ) => void;
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      explicit?: boolean;
      /** Replace existing options even when the incoming selection has none. */
      replaceOptions?: boolean;
    },
  ) => void;
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      | Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>
      | null
      | undefined,
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => boolean;
  addImages: (
    threadRef: ComposerThreadTarget,
    images: ComposerImageAttachment[],
    options?: { allowDuplicates?: boolean },
  ) => string[];
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  /** Returns the ids of files appended; a re-pick that replaces a marker is not listed. */
  addFiles: (
    threadRef: ComposerThreadTarget,
    files: ComposerFileAttachment[],
    options?: { allowDuplicates?: boolean; appendReference?: boolean },
  ) => string[];
  removeFile: (threadRef: ComposerThreadTarget, fileId: string) => void;
  setFileUpload: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => void;
  markFileUploadMissing: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => boolean;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void;
  addTerminalContexts: (
    threadRef: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
    options?: ComposerContextAddOptions,
  ) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
    options?: ComposerContextAddOptions,
  ) => void;
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void;
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void;
  addReviewComment: (
    threadRef: ComposerThreadTarget,
    comment: ReviewCommentContext,
    options?: ComposerContextAddOptions,
  ) => void;
  setContextInsertionHandler: (
    threadRef: ComposerThreadTarget,
    handler: ComposerContextInsertionHandler | null,
  ) => (() => void) | undefined;
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  addThreadContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<ThreadContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setThreadContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<ThreadContextRecord>,
  ) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<void>;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  /** Clears text and attachments, preserving terminal/element contexts, preview annotations, and review comments. */
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void;
  /** Keeps attachments over destination limits, other environments' uploads, terminal/element contexts, annotations, and review comments in source. */
  moveComposerPromptAndImages: (from: ComposerThreadTarget, to: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

function providerSelectionsFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection) {
    return null;
  }
  const options = modelSelection.options;
  if (!options || options.length === 0) {
    return null;
  }
  return { [modelSelection.instanceId]: options };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  return {
    ...selection,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  } as DeepMutable<ModelSelection>;
}

function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  const entries: Array<[string, DeepMutable<ModelSelection>]> = [];
  for (const [provider, selection] of Object.entries(selections)) {
    if (selection !== undefined) {
      entries.push([provider, cloneModelSelection(selection)]);
    }
  }
  return Object.fromEntries(entries) as DeepMutable<Record<ProviderInstanceId, ModelSelection>>;
}

function compactStickyOptionsByModel(
  optionsByModelByProvider: ComposerDraftStoreState["stickyOptionsByModelByProvider"],
): NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]> {
  const result: Record<string, Record<string, ReadonlyArray<ProviderOptionSelection>>> = {};
  for (const [instanceId, optionsByModel] of Object.entries(optionsByModelByProvider)) {
    for (const [modelSlug, options] of Object.entries(optionsByModel ?? {})) {
      if (options === undefined || options.length === 0) continue;
      result[instanceId] ??= {};
      result[instanceId][modelSlug] = options;
    }
  }
  return result as NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]>;
}

function seedStickyOptionsByModel(
  stickySelections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]> {
  const result: Record<string, Record<string, ReadonlyArray<ProviderOptionSelection>>> = {};
  for (const [instanceId, selection] of Object.entries(stickySelections)) {
    if (
      selection === undefined ||
      selection.options === undefined ||
      selection.options.length === 0
    ) {
      continue;
    }
    result[instanceId] = { [selection.model]: selection.options };
  }
  return result as NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]>;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyOptionsByModelByProvider: {},
  stickyActiveProvider: null,
});

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_FILES: ComposerFileAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = [];
const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = [];
const EMPTY_THREAD_CONTEXTS: ThreadContextRecord[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_FILES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_PREVIEW_ANNOTATIONS);
Object.freeze(EMPTY_REVIEW_COMMENTS);
Object.freeze(EMPTY_THREAD_CONTEXTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});
const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  files: EMPTY_FILES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  threadContexts: EMPTY_THREAD_CONTEXTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

function createEmptyThreadDraft(): ComposerThreadDraftState {
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
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
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

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function normalizeTerminalContextForThread(
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

function normalizeTerminalContextsForThread(
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

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    draft.threadContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

/** The schema owns validation; this permissive pattern keeps Effect Schema off the hot path. */
const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  if (typeof value !== "string") return null;
  if (!PROVIDER_INSTANCE_ID_PATTERN.test(value)) return null;
  return value as ProviderInstanceId;
}

function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const optionValue = record.value;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        out.push({ id, value: optionValue });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: ProviderOptionSelection[] = [];
    for (const [id, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "boolean") {
        out.push({ id, value: raw });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderDriverKind | null,
  legacy?: LegacyCodexFields,
): ProviderOptionSelectionsByProvider | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const providerKey of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);
    if (selections) {
      result[providerKey] = selections;
    }
  }

  if (provider === "codex" && legacy) {
    const codexExtras: ProviderOptionSelection[] = [];
    if (typeof legacy.effort === "string" && legacy.effort.length > 0) {
      codexExtras.push({ id: "reasoningEffort", value: legacy.effort });
    }
    const fastMode =
      legacy.codexFastMode === true ||
      (typeof legacy.serviceTier === "string" && legacy.serviceTier === "fast");
    if (fastMode) {
      codexExtras.push({ id: "fastMode", value: true });
    }
    if (codexExtras.length > 0) {
      const existing = result.codex ?? [];
      const existingIds = new Set(existing.map((entry) => entry.id));
      const merged = [...existing];
      for (const extra of codexExtras) {
        if (!existingIds.has(extra.id)) merged.push(extra);
      }
      result.codex = merged;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): NormalizedModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );
  if (instanceId === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("codex");
  const model = normalizeModelSlug(rawModel, driverKindHint);
  if (!model) {
    return null;
  }
  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);
    return createModelSelection(instanceId, model, selections) as NormalizedModelSelection;
  }
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);
  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
        kindForLegacyOptions,
        kindForLegacyOptions === "codex" ? legacy?.legacyCodex : undefined,
      )
    : null;
  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;
  return createModelSelection(instanceId, model, options) as NormalizedModelSelection;
}

type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

function legacySyncModelSelectionOptions(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): NormalizedModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  const options = kind ? modelOptions?.[kind] : undefined;
  return createModelSelection(
    modelSelection.instanceId,
    modelSelection.model,
    options,
  ) as NormalizedModelSelection;
}

function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: NormalizedModelSelection | null,
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection?.options || modelSelection.options.length === 0) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  if (!kind) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    kind,
    modelSelection.options,
  );
}

function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
  provider: ProviderDriverKind,
  nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const merged: ProviderOptionSelectionsByProvider = { ...otherProviderModelOptions };
  if (nextProviderOptions && nextProviderOptions.length > 0) {
    merged[provider] = nextProviderOptions;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function legacyToModelSelectionByProvider(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  const result: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
      const options = modelOptions[provider];
      if (options && options.length > 0) {
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        result[instanceKey] = createModelSelection(
          instanceKey,
          modelSelection?.instanceId === instanceKey
            ? modelSelection.model
            : (DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL),
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.instanceId] = modelSelection as ModelSelection;
  }
  return result;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;
  const preserveThreadModel =
    input.selectedInstanceId !== null &&
    input.selectedInstanceId !== undefined &&
    input.threadModelSelection?.instanceId === input.selectedInstanceId;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
          { preserveUnavailableSelection: preserveThreadModel },
        )
      : null) ??
    // Antigravity has no static model or cross-account catalog fallback.
    (input.selectedProvider === "antigravity" && input.selectedInstanceId ? "" : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  const legacySelection =
    input.selectedProvider === "antigravity" &&
    input.selectedInstanceId &&
    input.selectedInstanceId !== defaultInstanceIdForDriver(input.selectedProvider)
      ? undefined
      : input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
        { preserveUnavailableSelection: true },
      ) ??
      (input.selectedProvider === "antigravity" ? "" : null) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerSelectionsFromModelSelection(input.threadModelSelection) ??
    providerSelectionsFromModelSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
    ...(isSnapShotSource(candidate.source) ? { source: candidate.source } : {}),
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id: toComposerContextId(id),
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
    ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
  };
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

export function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

function normalizeLegacyComposerStorageKey(
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

function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

function normalizeComposerTarget(
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

function resolveComposerThreadId(
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

function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

function draftThreadHasOpenPreview(draftThread: DraftThreadState | undefined): boolean {
  if (draftThread === undefined) return false;
  const ref = scopeThreadRef(draftThread.environmentId, draftThread.threadId);
  return Object.keys(readThreadPreviewState(ref).sessions).length > 0;
}

function isComposerThreadKeyInUse(mappings: Record<string, string>, threadKey: string): boolean {
  return Object.values(mappings).includes(threadKey);
}

function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

function createDraftThreadState(
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

function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

function draftThreadsEqual(left: DraftThreadState | undefined, right: DraftThreadState): boolean {
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

function removeDraftThreadReferences(
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

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [projectKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(projectKey);
      if (!projectRef) {
        continue;
      }
      const parsedThreadRef = parseScopedThreadKey(threadId);
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
        continue;
      }
      environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId);
    }
  }
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      const threadId =
        parsedThreadRef?.threadId ??
        (typeof candidateDraftThread.threadId === "string" &&
        candidateDraftThread.threadId.length > 0
          ? (candidateDraftThread.threadId as ThreadId)
          : (threadKeyOrId as ThreadId));
      const environmentId =
        parsedThreadRef?.environmentId ??
        (typeof candidateDraftThread.environmentId === "string" &&
        candidateDraftThread.environmentId.length > 0
          ? (candidateDraftThread.environmentId as EnvironmentId)
          : environmentIdByThreadId.get(threadKeyOrId as ThreadId));
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const startFromOrigin = candidateDraftThread.startFromOrigin === true;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const promotedToCandidate = candidateDraftThread.promotedTo;
      const promotedToRecord =
        promotedToCandidate && typeof promotedToCandidate === "object"
          ? (promotedToCandidate as Record<string, unknown>)
          : null;
      const promotedTo =
        promotedToRecord &&
        typeof promotedToRecord.environmentId === "string" &&
        promotedToRecord.environmentId.length > 0 &&
        typeof promotedToRecord.threadId === "string" &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              promotedToRecord.environmentId as EnvironmentId,
              promotedToRecord.threadId as ThreadId,
            )
          : null;
      if (typeof projectId !== "string" || projectId.length === 0 || environmentId === undefined) {
        continue;
      }
      const normalizedEnvironmentId = environmentId as EnvironmentId;
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: projectId as ProjectId,
        logicalProjectKey:
          typeof candidateDraftThread.logicalProjectKey === "string" &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
              : threadKeyOrId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        startFromOrigin,
        ...(candidateDraftThread.environmentSelection === "manual" ||
        candidateDraftThread.environmentSelection === "auto"
          ? { environmentSelection: candidateDraftThread.environmentSelection }
          : {}),
        ...(typeof candidateDraftThread.loadBalancedEnvironmentId === "string" &&
        candidateDraftThread.loadBalancedEnvironmentId.length > 0
          ? { loadBalancedEnvironmentId: candidateDraftThread.loadBalancedEnvironmentId }
          : candidateDraftThread.loadBalancedEnvironmentId === null
            ? { loadBalancedEnvironmentId: null }
            : {}),
        promotedTo,
      };
    }
  }

  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(logicalProjectKey);
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] = threadKey;
      const existingDraftThread = draftThreadsByThreadKey[threadKey];
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
      }
      // Logical keys may contain workspace paths; a matching draft's concrete project id wins.
      if (existingDraftThread?.logicalProjectKey === logicalProjectKey) {
        continue;
      }
      if (!projectRef) {
        if (existingDraftThread) {
          draftThreadsByThreadKey[threadKey] = {
            ...existingDraftThread,
            logicalProjectKey,
          };
        }
        continue;
      }
      if (!existingDraftThread) {
        draftThreadsByThreadKey[threadKey] = {
          threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
          createdAt: new Date().toISOString(),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        };
      } else if (
        existingDraftThread.projectId !== projectRef.projectId ||
        existingDraftThread.environmentId !== projectRef.environmentId
      ) {
        draftThreadsByThreadKey[threadKey] = {
          ...existingDraftThread,
          threadId: existingDraftThread.threadId,
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
        };
      }
    }
  }

  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey };
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey)) {
    const parsedThreadRef = composerThreadRefFromKey(threadKey);
    if (!parsedThreadRef) {
      continue;
    }
    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      draftThread.environmentId as EnvironmentId,
    );
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadKey"]> =
    {};
  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  )) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const files = Array.isArray(draftCandidate.files)
      ? draftCandidate.files.filter(isPersistedComposerDraftFileAttachment)
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const reviewComments = Array.isArray(draftCandidate.reviewComments)
      ? draftCandidate.reviewComments.filter(isReviewCommentContext)
      : [];
    const threadContexts = Array.isArray(draftCandidate.threadContexts)
      ? draftCandidate.threadContexts.filter(isThreadContextRecord)
      : [];
    const previewAnnotations = Array.isArray(draftCandidate.previewAnnotations)
      ? draftCandidate.previewAnnotations.filter(isPreviewAnnotationPayload)
      : [];
    const legacyElements =
      "elementContexts" in draftValue && Array.isArray(draftValue.elementContexts)
        ? draftValue.elementContexts
        : [];
    for (const element of legacyElements) {
      if (
        !isElementContextDetails(element) ||
        !("id" in element) ||
        typeof element.id !== "string" ||
        !("pickedAt" in element) ||
        typeof element.pickedAt !== "string"
      )
        continue;
      if (!previewAnnotations.some((annotation) => annotation.id === element.id)) {
        previewAnnotations.push(
          elementContextToPreviewAnnotation(element, element.id, element.pickedAt),
        );
      }
    }
    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const contextIds = new Map<string, string>();
    for (const [kind, entries] of [
      ["image", attachments],
      ["file", files],
      ["terminal", terminalContexts],
      ["review-comment", reviewComments],
      ["preview-annotation", previewAnnotations],
    ] as const) {
      for (const entry of entries) {
        const contextId = toKindScopedComposerContextId(kind, entry.id);
        contextIds.set(`${kind}/${entry.id}`, contextId);
        contextIds.set(`${kind}/${toComposerContextId(entry.id)}`, contextId);
        if (kind === "preview-annotation") {
          contextIds.set(`${kind}/${toComposerContextId(`annotation-${entry.id}`)}`, contextId);
        }
      }
      for (const entry of entries) {
        const contextId = toKindScopedComposerContextId(kind, entry.id);
        contextIds.set(`${kind}/${contextId}`, contextId);
      }
    }
    const migratedPrompt = promptCandidate.replace(
      /!?\[([^\]\r\n]*)\]\(t3-context:\/\/v1\/([a-z-]+)\/([^/()\r\n]+)\)/g,
      (source, label: string, kind: string, id: string) => {
        const contextId = contextIds.get(`${kind}/${id}`);
        return contextId ? formatInlineContextReference({ kind, contextId, label }) : source;
      },
    );
    const prompt = ensureInlineContextReferences(
      migrateLegacyTerminalContextPlaceholders(migratedPrompt, terminalContexts),
      terminalContexts.map((context) => terminalContextReference({ ...context, text: "" })),
    );
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
    let activeProvider: ProviderInstanceId | null = null;
    let modelSelectionExplicit: true | undefined = undefined;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
      activeProvider = normalizeProviderInstanceId(draftCandidate.activeProvider);
      modelSelectionExplicit = draftCandidate.modelSelectionExplicit === true ? true : undefined;
    } else {
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.instanceId ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      files.length === 0 &&
      terminalContexts.length === 0 &&
      previewAnnotations.length === 0 &&
      reviewComments.length === 0 &&
      threadContexts.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
    const normalizedThreadKey =
      parsedThreadRef !== null
        ? normalizeLegacyComposerStorageKey(threadKeyOrId)
        : draftThreadsByThreadKey[threadKeyOrId] !== undefined
          ? threadKeyOrId
          : (() => {
              const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId);
              return environmentId
                ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
                : threadKeyOrId;
            })();
    nextDraftsByThreadKey[normalizedThreadKey] = {
      prompt,
      attachments,
      ...(files.length > 0 ? { files } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(previewAnnotations.length > 0 ? { previewAnnotations } : {}),
      ...(reviewComments.length > 0 ? { reviewComments } : {}),
      ...(threadContexts.length > 0 ? { threadContexts } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
            activeProvider,
            ...(modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByThreadKey;
}

function persistedComposerDraftHasUserContent(draft: PersistedComposerThreadDraftState): boolean {
  return (
    draft.prompt.trim().length > 0 ||
    draft.attachments.length > 0 ||
    (draft.files?.length ?? 0) > 0 ||
    (draft.terminalContexts?.length ?? 0) > 0 ||
    (draft.previewAnnotations?.length ?? 0) > 0 ||
    (draft.reviewComments?.length ?? 0) > 0 ||
    (draft.threadContexts?.length ?? 0) > 0
  );
}

function stripLegacyModelSeedsFromEmptyDraftSessions(
  draftsByThreadKey: PersistedComposerDraftStoreState["draftsByThreadKey"],
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  return Object.fromEntries(
    Object.entries(draftsByThreadKey).flatMap(([threadKey, draft]) => {
      if (
        draftThreadsByThreadKey[threadKey] === undefined ||
        draft.modelSelectionExplicit === true ||
        persistedComposerDraftHasUserContent(draft)
      ) {
        return [[threadKey, draft]];
      }

      const {
        activeProvider: _activeProvider,
        modelSelectionByProvider: _modelSelectionByProvider,
        modelSelectionExplicit: _modelSelectionExplicit,
        ...retained
      } = draft;
      return retained.runtimeMode || retained.interactionMode ? [[threadKey, retained]] : [];
    }),
  );
}

function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  const normalized = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  return {
    ...normalized,
    draftsByThreadKey: stripLegacyModelSeedsFromEmptyDraftSessions(
      normalized.draftsByThreadKey,
      normalized.draftThreadsByThreadKey,
    ),
  };
}

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const mappedDraftKeys = new Set(
    Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey),
  );
  const keptSessionKeys = new Set(
    Object.entries(state.draftThreadsByThreadKey)
      .filter(
        ([threadKey, draftThread]) =>
          mappedDraftKeys.has(threadKey) ||
          isDraftThreadPromoting(draftThread) ||
          composerDraftHasUserContent(state.draftsByThreadKey[threadKey]) ||
          draftThreadHasOpenPreview(draftThread),
      )
      .map(([threadKey]) => threadKey),
  );
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (typeof threadKey !== "string" || threadKey.length === 0) {
      continue;
    }
    if (state.draftThreadsByThreadKey[threadKey] !== undefined && !keptSessionKeys.has(threadKey)) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.files.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.previewAnnotations.length === 0 &&
      draft.reviewComments.length === 0 &&
      draft.threadContexts.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.files.length > 0
        ? {
            files: draft.files.map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              ...(file.source ? { source: file.source } : {}),
              ...(file.uploadedAttachmentId && file.uploadEnvironmentId
                ? {
                    attachmentId: file.uploadedAttachmentId,
                    environmentId: file.uploadEnvironmentId,
                  }
                : {}),
            })),
          }
        : {}),
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
              text: context.text,
            })),
          }
        : {}),
      ...(draft.previewAnnotations.length > 0
        ? {
            previewAnnotations: draft.previewAnnotations.map(
              (annotation) => ({ ...annotation }) as DeepMutable<PreviewAnnotationPayload>,
            ),
          }
        : {}),
      ...(draft.reviewComments.length > 0
        ? {
            reviewComments: draft.reviewComments.map((comment) => ({ ...comment })),
          }
        : {}),
      ...(draft.threadContexts.length > 0
        ? { threadContexts: draft.threadContexts.map((record) => ({ ...record })) }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
            ...(draft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByThreadKey[threadKey] = persistedDraft;
  }
  const persistedDraftThreadsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftThreadsByThreadKey"]
  > = {};
  for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
    if (!keptSessionKeys.has(threadKey)) {
      continue;
    }
    persistedDraftThreadsByThreadKey[threadKey] = draftThread;
  }
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: persistedDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyOptionsByModelByProvider: compactStickyOptionsByModel(
      state.stickyOptionsByModelByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  let stickyActiveProvider: ProviderInstanceId | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    );
  } else {
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider ?? "codex",
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyOptionsByModelByProvider:
      normalizedPersistedState.stickyOptionsByModelByProvider === undefined
        ? seedStickyOptionsByModel(stickyModelSelectionByProvider)
        : compactStickyOptionsByModel(normalizedPersistedState.stickyOptionsByModelByProvider),
    stickyActiveProvider,
  };
}

function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function verifyPersistedAttachments(
  threadKey: string,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadKey[threadKey];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds: string[] = [];
    for (const image of current.images) {
      if (!persistedIdSet.has(image.id)) {
        nonPersistedImageIds.push(image.id);
      }
    }
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadKey[threadKey];
    } else {
      nextDraftsByThreadKey[threadKey] = nextDraft;
    }
    return { draftsByThreadKey: nextDraftsByThreadKey };
  });
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
        ...(attachment.source ? { source: attachment.source } : {}),
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null;
  const files: ComposerFileAttachment[] =
    persistedDraft.files?.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      file: null,
      ...(file.source ? { source: file.source } : {}),
      ...(file.attachmentId !== undefined && file.environmentId !== undefined
        ? { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: file.environmentId }
        : {}),
    })) ?? [];

  return {
    prompt: ensureInlineContextReferences(persistedDraft.prompt, [
      ...(persistedDraft.reviewComments ?? []).map(reviewCommentContextReference),
      ...(persistedDraft.previewAnnotations ?? []).map(previewAnnotationContextReference),
      ...(persistedDraft.threadContexts ?? []).map(threadContextReference),
      ...files.map(fileContextReference),
    ]),
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files,
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: context.text ?? "",
      })) ?? [],
    previewAnnotations:
      persistedDraft.previewAnnotations?.map((annotation) => ({ ...annotation })) ?? [],
    reviewComments: persistedDraft.reviewComments?.map((comment) => ({ ...comment })) ?? [],
    threadContexts: persistedDraft.threadContexts?.map((record) => ({ ...record })) ?? [],
    modelSelectionByProvider,
    activeProvider,
    ...(persistedDraft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState {
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: persistedDraftThread.environmentId as EnvironmentId,
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          persistedDraftThread.environmentId as EnvironmentId,
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    interactionMode: persistedDraftThread.interactionMode,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    startFromOrigin: persistedDraftThread.startFromOrigin,
    ...(persistedDraftThread.environmentSelection
      ? { environmentSelection: persistedDraftThread.environmentSelection }
      : {}),
    ...(persistedDraftThread.loadBalancedEnvironmentId !== undefined
      ? {
          loadBalancedEnvironmentId:
            persistedDraftThread.loadBalancedEnvironmentId as EnvironmentId | null,
        }
      : {}),
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          persistedDraftThread.promotedTo.environmentId as EnvironmentId,
          persistedDraftThread.promotedTo.threadId as ThreadId,
        )
      : null,
  };
}

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (setBase, get) => {
      const set = setBase;

      return {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        backgroundSubmissionThreadKeys: {},
        rewindingThreadKeys: new Set<string>(),
        stickyModelSelectionByProvider: {},
        stickyOptionsByModelByProvider: {},
        stickyActiveProvider: null,
        getComposerDraft: (target) => getComposerDraftState(get(), target),
        getDraftThreadByLogicalProjectKey: (logicalProjectKey) => {
          return get().getDraftSessionByLogicalProjectKey(logicalProjectKey);
        },
        getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
          if (normalizedLogicalProjectKey.length === 0) {
            return null;
          }
          const draftId =
            get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
          if (!draftId) {
            return null;
          }
          const draftThread = get().draftThreadsByThreadKey[draftId];
          if (!draftThread || isDraftThreadPromoting(draftThread)) {
            return null;
          }
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        },
        getDraftThreadByProjectRef: (projectRef) => {
          return get().getDraftSessionByProjectRef(projectRef);
        },
        getDraftSessionByProjectRef: (projectRef) => {
          const state = get();
          for (const draftId of Object.values(
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          )) {
            const draftThread = state.draftThreadsByThreadKey[draftId];
            if (!draftThread || isDraftThreadPromoting(draftThread)) {
              continue;
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            ) {
              return toProjectDraftSession(DraftId.make(draftId), draftThread);
            }
          }
          for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
            if (isDraftThreadPromoting(draftThread)) {
              continue;
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            ) {
              return toProjectDraftSession(DraftId.make(draftId), draftThread);
            }
          }
          return null;
        },
        getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
        getDraftSessionByRef: (threadRef) => {
          for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            ) {
              return draftSession;
            }
          }
          return null;
        },
        getDraftIdByRef: (threadRef) => {
          for (const [draftId, draftSession] of Object.entries(get().draftThreadsByThreadKey)) {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            ) {
              return DraftId.make(draftId);
            }
          }
          return null;
        },
        getDraftThread: (threadRef) => {
          if (typeof threadRef === "string") {
            return get().getDraftSession(DraftId.make(threadRef));
          }
          return get().getDraftSessionByRef(threadRef);
        },
        getDraftThreadByRef: (threadRef) => {
          return get().getDraftSessionByRef(threadRef);
        },
        listDraftThreadKeys: () =>
          Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
            scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
          ),
        hasDraftThreadsInEnvironment: (environmentId) =>
          Object.values(get().draftThreadsByThreadKey).some(
            (draftThread) => draftThread.environmentId === environmentId,
          ),
        setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
          if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
            return;
          }
          set((state) => {
            const existingThread = state.draftThreadsByThreadKey[draftId];
            const previousThreadKeyForLogicalProject =
              state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
            const nextDraftThread = createDraftThreadState(
              projectRef,
              options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
              normalizedLogicalProjectKey,
              existingThread,
              options,
            );
            const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
            const hasNoStaleMappingsForDraft = Object.entries(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).every(
              ([logicalKey, mappedDraftId]) =>
                mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
            );
            if (
              hasSameLogicalMapping &&
              hasNoStaleMappingsForDraft &&
              draftThreadsEqual(existingThread, nextDraftThread)
            ) {
              return state;
            }
            const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> =
              Object.fromEntries(
                Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
                  ([logicalKey, mappedDraftId]) =>
                    mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
                ),
              );
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey] =
              draftId;
            const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
              ...state.draftThreadsByThreadKey,
              [draftId]: nextDraftThread,
            };
            const existingDraft = state.draftsByThreadKey[draftId];
            let nextDraftsByThreadKey = state.draftsByThreadKey;
            if (
              existingThread &&
              existingThread.environmentId !== projectRef.environmentId &&
              existingDraft !== undefined
            ) {
              const nextDraft = clearStaleFileUploadMetadata(
                existingDraft,
                projectRef.environmentId,
              );
              if (nextDraft !== existingDraft) {
                nextDraftsByThreadKey = {
                  ...state.draftsByThreadKey,
                  [draftId]: nextDraft,
                };
              }
            }
            const previousDraftThread =
              previousThreadKeyForLogicalProject === undefined
                ? undefined
                : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
            // Keep populated drafts unmapped: sidebar rows still expose them when a new draft is opened.
            if (
              previousThreadKeyForLogicalProject &&
              previousThreadKeyForLogicalProject !== draftId &&
              !isComposerThreadKeyInUse(
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
                previousThreadKeyForLogicalProject,
              ) &&
              !isDraftThreadPromoting(previousDraftThread) &&
              !composerDraftHasUserContent(
                state.draftsByThreadKey[previousThreadKeyForLogicalProject],
              ) &&
              !draftThreadHasOpenPreview(previousDraftThread)
            ) {
              delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
              if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
                nextDraftsByThreadKey = { ...nextDraftsByThreadKey };
                delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
              }
            }
            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
            };
          });
        },
        setProjectDraftThreadId: (projectRef, draftId, options) => {
          get().setLogicalProjectDraftThreadId(
            projectDraftKey(projectRef),
            projectRef,
            draftId,
            options,
          );
        },
        setDraftThreadContext: (threadRef, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing) {
              return state;
            }
            const nextProjectRef = options.projectRef ?? {
              environmentId: existing.environmentId,
              projectId: existing.projectId,
            };
            if (
              nextProjectRef.projectId.length === 0 ||
              nextProjectRef.environmentId.length === 0
            ) {
              return state;
            }
            const projectChanged =
              nextProjectRef.environmentId !== existing.environmentId ||
              nextProjectRef.projectId !== existing.projectId;
            const nextWorktreePath =
              options.worktreePath === undefined
                ? projectChanged
                  ? null
                  : existing.worktreePath
                : (options.worktreePath ?? null);
            const nextBranch =
              options.branch === undefined
                ? projectChanged
                  ? null
                  : existing.branch
                : (options.branch ?? null);
            const nextStartFromOrigin =
              options.startFromOrigin === undefined
                ? existing.startFromOrigin
                : options.startFromOrigin;
            const environmentSelection =
              options.environmentSelection ??
              (options.branch != null || options.worktreePath != null
                ? "manual"
                : existing.environmentSelection);
            const nextDraftThread: DraftThreadState = {
              threadId: existing.threadId,
              environmentId: nextProjectRef.environmentId,
              projectId: nextProjectRef.projectId,
              logicalProjectKey: existing.logicalProjectKey,
              ...(environmentSelection ? { environmentSelection } : {}),
              loadBalancedEnvironmentId:
                options.loadBalancedEnvironmentId === undefined
                  ? projectChanged
                    ? null
                    : (existing.loadBalancedEnvironmentId ?? null)
                  : options.loadBalancedEnvironmentId,
              createdAt:
                options.createdAt === undefined
                  ? existing.createdAt
                  : options.createdAt || existing.createdAt,
              runtimeMode: options.runtimeMode ?? existing.runtimeMode,
              interactionMode: options.interactionMode ?? existing.interactionMode,
              branch: nextBranch,
              worktreePath: nextWorktreePath,
              envMode:
                options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
              startFromOrigin: nextStartFromOrigin,
              promotedTo: existing.promotedTo ?? null,
            };
            const isUnchanged =
              nextDraftThread.environmentId === existing.environmentId &&
              nextDraftThread.projectId === existing.projectId &&
              nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
              nextDraftThread.environmentSelection === existing.environmentSelection &&
              nextDraftThread.loadBalancedEnvironmentId === existing.loadBalancedEnvironmentId &&
              nextDraftThread.createdAt === existing.createdAt &&
              nextDraftThread.runtimeMode === existing.runtimeMode &&
              nextDraftThread.interactionMode === existing.interactionMode &&
              nextDraftThread.branch === existing.branch &&
              nextDraftThread.worktreePath === existing.worktreePath &&
              nextDraftThread.envMode === existing.envMode &&
              nextDraftThread.startFromOrigin === existing.startFromOrigin &&
              scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
            if (isUnchanged) {
              return state;
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: nextDraftThread,
              },
            };
          });
        },
        clearProjectDraftThreadId: (projectRef) => {
          set((state) => {
            const matchingThreadKeys = Object.entries(state.draftThreadsByThreadKey)
              .filter(
                ([, draftThread]) =>
                  draftThread.projectId === projectRef.projectId &&
                  draftThread.environmentId === projectRef.environmentId,
              )
              .map(([threadKey]) => threadKey);
            if (matchingThreadKeys.length === 0) {
              return state;
            }
            let nextState = {
              draftsByThreadKey: state.draftsByThreadKey,
              draftThreadsByThreadKey: state.draftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            };
            for (const threadKey of matchingThreadKeys) {
              nextState = removeDraftThreadReferences(nextState, threadKey);
            }
            return nextState;
          });
        },
        clearProjectDraftThreadById: (projectRef, threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const draftThread = state.draftThreadsByThreadKey[threadKey];
            if (
              !draftThread ||
              draftThread.projectId !== projectRef.projectId ||
              draftThread.environmentId !== projectRef.environmentId
            ) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey);
          });
        },
        markDraftThreadPromoting: (threadRef, promotedTo) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing) {
              return state;
            }
            const nextPromotedTo =
              promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
            if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
              return state;
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: {
                  ...existing,
                  promotedTo: nextPromotedTo,
                },
              },
            };
          });
        },
        finalizePromotedDraftThread: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftThreadsByThreadKey[threadKey];
            if (!existing || !isDraftThreadPromoting(existing)) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey, existing.promotedTo ?? undefined);
          });
        },
        clearDraftThread: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
            const hasLogicalProjectMapping = Object.values(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).includes(threadKey);
            const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
            if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
              return state;
            }
            return removeDraftThreadReferences(state, threadKey);
          });
        },
        setStickyModelSelection: (modelSelection) => {
          const normalized = normalizeModelSelection(modelSelection);
          set((state) => {
            if (!normalized) {
              return state;
            }
            const current = state.stickyModelSelectionByProvider[normalized.instanceId];
            // Model-only updates omit options; preserve sticky traits across model switches and new chats.
            const nextSelection =
              normalized.options !== undefined
                ? normalized
                : createModelSelection(normalized.instanceId, normalized.model, current?.options);
            const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
              ...state.stickyModelSelectionByProvider,
              [normalized.instanceId]: nextSelection,
            };
            if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
              return state.stickyActiveProvider === normalized.instanceId
                ? state
                : { stickyActiveProvider: normalized.instanceId };
            }
            return {
              stickyModelSelectionByProvider: nextMap,
              stickyActiveProvider: normalized.instanceId,
            };
          });
        },
        applyStickyState: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const stickyMap = state.stickyModelSelectionByProvider;
            const stickyActiveProvider = state.stickyActiveProvider;
            const existing = state.draftsByThreadKey[threadKey];
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = compactModelSelectionByProvider(stickyMap);
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === stickyActiveProvider &&
              base.modelSelectionExplicit === undefined
            ) {
              return state;
            }
            const { modelSelectionExplicit: _modelSelectionExplicit, ...retained } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...retained,
              modelSelectionByProvider: nextMap,
              activeProvider: stickyActiveProvider,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setPrompt: (threadRef, prompt) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setTerminalContexts: (threadRef, contexts) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return;
          }
          const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt: ensureInlineContextReferences(
                existing.terminalContexts
                  .filter((context) => !normalizedContexts.some((next) => next.id === context.id))
                  .reduce(
                    (prompt, context) =>
                      removeInlineContextReference(
                        prompt,
                        terminalContextReference(context).contextId,
                      ).prompt,
                    existing.prompt,
                  ),
                normalizedContexts.map(terminalContextReference),
              ),
              terminalContexts: normalizedContexts,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setModelSelection: (threadRef, modelSelection, opts) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const normalized = normalizeModelSelection(modelSelection);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && normalized === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = { ...base.modelSelectionByProvider };
            if (normalized) {
              const current = nextMap[normalized.instanceId];
              if (normalized.options !== undefined || opts?.replaceOptions) {
                nextMap[normalized.instanceId] = normalized as ModelSelection;
              } else {
                nextMap[normalized.instanceId] = createModelSelection(
                  normalized.instanceId,
                  normalized.model,
                  current?.options,
                );
              }
            }
            const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === nextActiveProvider &&
              (base.modelSelectionExplicit ?? false) === (opts?.explicit === true)
            ) {
              return state;
            }
            const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...restBase,
              modelSelectionByProvider: nextMap,
              activeProvider: nextActiveProvider,
              ...(opts?.explicit === true ? { modelSelectionExplicit: true as const } : {}),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setModelOptions: (threadRef, modelOptions) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0)) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            const nextMap = { ...base.modelSelectionByProvider };
            for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
              if (!modelOptions || !(provider in modelOptions)) continue;
              const opts = modelOptions[provider];
              const driverKind = ProviderDriverKind.make(provider);
              const instanceKey = defaultInstanceIdForDriver(driverKind);
              const current = nextMap[instanceKey];
              if (opts && opts.length > 0) {
                nextMap[instanceKey] = createModelSelection(
                  instanceKey,
                  current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
                  opts,
                );
              } else if (current?.options) {
                const { options: _, ...rest } = current;
                nextMap[instanceKey] = rest as ModelSelection;
              }
            }
            if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              modelSelectionByProvider: nextMap,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const normalizedProvider = normalizeProviderDriverKind(provider);
          if (normalizedProvider === null) {
            return;
          }
          const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);
          const fallbackModel =
            normalizeModelSlug(options?.model, normalizedProvider) ??
            DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
            DEFAULT_MODEL;
          const providerOpts =
            nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            const base = existing ?? createEmptyThreadDraft();

            const nextMap = { ...base.modelSelectionByProvider };
            const currentForProvider = nextMap[instanceKey];
            if (providerOpts) {
              nextMap[instanceKey] = createModelSelection(
                instanceKey,
                currentForProvider?.model ?? fallbackModel,
                providerOpts,
              );
            } else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0) {
              const { options: _, ...rest } = currentForProvider;
              nextMap[instanceKey] = rest as ModelSelection;
            }

            let nextStickyMap = state.stickyModelSelectionByProvider;
            let nextOptionsByModel = state.stickyOptionsByModelByProvider;
            let nextStickyActiveProvider = state.stickyActiveProvider;
            if (options?.persistSticky === true) {
              nextStickyMap = { ...state.stickyModelSelectionByProvider };
              const stickyBase =
                nextStickyMap[instanceKey] ??
                base.modelSelectionByProvider[instanceKey] ??
                createModelSelection(instanceKey, fallbackModel);
              const rememberedModel =
                normalizeModelSlug(options?.model, normalizedProvider) ?? stickyBase.model;
              if (providerOpts) {
                nextStickyMap[instanceKey] = createModelSelection(
                  instanceKey,
                  stickyBase.model,
                  providerOpts,
                );
                nextOptionsByModel = {
                  ...state.stickyOptionsByModelByProvider,
                  [instanceKey]: {
                    ...state.stickyOptionsByModelByProvider[instanceKey],
                    [rememberedModel]: providerOpts,
                  },
                };
              } else if ((stickyBase.options?.length ?? 0) > 0) {
                const { options: _, ...rest } = stickyBase;
                nextStickyMap[instanceKey] = rest as ModelSelection;
                const rememberedByModel = {
                  ...state.stickyOptionsByModelByProvider[instanceKey],
                };
                delete rememberedByModel[rememberedModel];
                nextOptionsByModel = {
                  ...state.stickyOptionsByModelByProvider,
                  [instanceKey]: rememberedByModel,
                };
              }
              nextStickyActiveProvider = options.instanceId
                ? instanceKey
                : (base.activeProvider ?? instanceKey);
            }

            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
              Equal.equals(state.stickyOptionsByModelByProvider, nextOptionsByModel) &&
              state.stickyActiveProvider === nextStickyActiveProvider
            ) {
              return state;
            }

            const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
            const nextDraft: ComposerThreadDraftState = {
              ...restBase,
              ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
              modelSelectionByProvider: nextMap,
              modelSelectionExplicit: true,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }

            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              ...(options?.persistSticky === true
                ? {
                    stickyModelSelectionByProvider: nextStickyMap,
                    stickyOptionsByModelByProvider: nextOptionsByModel,
                    stickyActiveProvider: nextStickyActiveProvider,
                  }
                : {}),
            };
          });
        },
        setRuntimeMode: (threadRef, runtimeMode) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && nextRuntimeMode === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            if (base.runtimeMode === nextRuntimeMode) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              runtimeMode: nextRuntimeMode,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setInteractionMode: (threadRef, interactionMode) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const nextInteractionMode =
            interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey];
            if (!existing && nextInteractionMode === null) {
              return state;
            }
            const base = existing ?? createEmptyThreadDraft();
            if (base.interactionMode === nextInteractionMode) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              interactionMode: nextInteractionMode,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addImage: (threadRef, image) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return false;
          }
          const acceptedIds = get().addImages(
            typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
            [image],
          );
          return acceptedIds.includes(image.id);
        },
        addImages: (threadRef, images, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || images.length === 0) {
            return [];
          }
          let acceptedIds: string[] = [];
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const existingIds = new Set(existing.images.map((image) => image.id));
            const existingDedupKeys = new Set(
              existing.images.map((image) => composerImageDedupKey(image)),
            );
            const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
            const dedupedIncoming: ComposerImageAttachment[] = [];
            for (const image of images) {
              const dedupKey = composerImageDedupKey(image);
              if (
                existingIds.has(image.id) ||
                (!options?.allowDuplicates && existingDedupKeys.has(dedupKey))
              ) {
                // Avoid revoking a blob URL that's still referenced by an accepted image.
                if (!acceptedPreviewUrls.has(image.previewUrl)) {
                  revokeObjectPreviewUrl(image.previewUrl);
                }
                continue;
              }
              if (
                existing.images.length + existing.files.length + dedupedIncoming.length >=
                PROVIDER_SEND_TURN_MAX_ATTACHMENTS
              ) {
                if (!acceptedPreviewUrls.has(image.previewUrl)) {
                  revokeObjectPreviewUrl(image.previewUrl);
                }
                continue;
              }
              dedupedIncoming.push(image);
              existingIds.add(image.id);
              existingDedupKeys.add(dedupKey);
              acceptedPreviewUrls.add(image.previewUrl);
            }
            if (dedupedIncoming.length === 0) {
              return state;
            }
            acceptedIds = dedupedIncoming.map((image) => image.id);
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  images: [...existing.images, ...dedupedIncoming],
                },
              },
            };
          });
          return acceptedIds;
        },
        removeImage: (threadRef, imageId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          const existing = get().draftsByThreadKey[threadKey];
          if (!existing) {
            return;
          }
          const removedImage = existing.images.find((image) => image.id === imageId);
          if (removedImage) {
            revokeObjectPreviewUrl(removedImage.previewUrl);
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                toKindScopedComposerContextId("image", imageId),
              ).prompt,
              images: current.images.filter((image) => image.id !== imageId),
              nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
              persistedAttachments: current.persistedAttachments.filter(
                (attachment) => attachment.id !== imageId,
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addFiles: (threadRef, files, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || files.length === 0) {
            return [];
          }
          let acceptedIds: string[] = [];
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const knownIds = new Set(existing.files.map((file) => file.id));
            const knownFiles = new Map<string, ComposerFileAttachment>(
              existing.files.map((file) => [composerFileDedupKey(file), file]),
            );
            const accepted: ComposerFileAttachment[] = [];
            const replacements = new Map<string, ComposerFileAttachment>();
            for (const file of files) {
              const key = composerFileDedupKey(file);
              if (knownIds.has(file.id)) {
                continue;
              }
              const duplicate = options?.allowDuplicates
                ? undefined
                : (knownFiles.get(key) ??
                  existing.files.find(
                    (candidate) =>
                      composerFileNeedsReattach(candidate) &&
                      !replacements.has(candidate.id) &&
                      composerFileMatchesReattachMarker(candidate, file),
                  ));
              if (duplicate) {
                if (composerFileNeedsReattach(duplicate) && !replacements.has(duplicate.id)) {
                  replacements.set(duplicate.id, file);
                  knownIds.add(file.id);
                  knownFiles.set(key, file);
                }
                continue;
              }
              if (
                existing.images.length + existing.files.length + accepted.length >=
                PROVIDER_SEND_TURN_MAX_ATTACHMENTS
              ) {
                break;
              }
              accepted.push(file);
              knownIds.add(file.id);
              knownFiles.set(key, file);
            }
            if (accepted.length === 0 && replacements.size === 0) {
              return state;
            }
            acceptedIds = accepted.map((file) => file.id);
            const retained = existing.files.map((file) => replacements.get(file.id) ?? file);
            const prompt =
              replacements.size === 0
                ? existing.prompt
                : replaceComposerContextReferences(existing.prompt, (occurrence) => {
                    const original = existing.files.find(
                      (file) => fileContextReference(file).contextId === occurrence.contextId,
                    );
                    const replacement = original ? replacements.get(original.id) : undefined;
                    return replacement
                      ? formatInlineContextReference(fileContextReference(replacement))
                      : occurrence.source;
                  });
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt: options?.appendReference
                    ? ensureInlineContextReferences(
                        prompt,
                        [...accepted, ...replacements.values()].map(fileContextReference),
                      )
                    : prompt,
                  files: [...retained, ...accepted],
                },
              },
            };
          });
          return acceptedIds;
        },
        removeFile: (threadRef, fileId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current?.files.some((file) => file.id === fileId)) {
              return state;
            }
            const nextDraft = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                toKindScopedComposerContextId("file", fileId),
              ).prompt,
              files: current.files.filter((file) => file.id !== fileId),
            } satisfies ComposerThreadDraftState;
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        setFileUpload: (threadRef, fileId, environmentId, attachmentId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            const file = current?.files.find((entry) => entry.id === fileId);
            if (
              !current ||
              !file ||
              (file.uploadEnvironmentId === environmentId &&
                file.uploadedAttachmentId === attachmentId)
            ) {
              return state;
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...current,
                  files: current.files.map((entry) =>
                    entry.id === fileId
                      ? {
                          ...entry,
                          uploadedAttachmentId: attachmentId,
                          uploadEnvironmentId: environmentId,
                        }
                      : entry,
                  ),
                },
              },
            };
          });
        },
        markFileUploadMissing: (threadRef, fileId, environmentId, attachmentId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return false;
          }
          let markedMissing = false;
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            const file = current?.files.find((entry) => entry.id === fileId);
            if (
              !current ||
              !file ||
              file.file !== null ||
              file.uploadEnvironmentId !== environmentId ||
              file.uploadedAttachmentId !== attachmentId
            ) {
              return state;
            }
            markedMissing = true;
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...current,
                  files: current.files.map((entry) => {
                    if (entry.id !== fileId) {
                      return entry;
                    }
                    const marker = { ...entry };
                    delete marker.uploadedAttachmentId;
                    delete marker.uploadEnvironmentId;
                    return marker;
                  }),
                },
              },
            };
          });
          return markedMissing;
        },
        insertTerminalContext: (threadRef, prompt, context, index) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return false;
          }
          let inserted = false;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const normalizedContext = normalizeTerminalContextForThread(threadId, context);
            if (!normalizedContext) {
              return state;
            }
            const dedupKey = terminalContextDedupKey(normalizedContext);
            if (
              existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
              existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
            ) {
              return state;
            }
            inserted = true;
            const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
              terminalContexts: [
                ...existing.terminalContexts.slice(0, boundedIndex),
                normalizedContext,
                ...existing.terminalContexts.slice(boundedIndex),
              ],
            };
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: nextDraft,
              },
            };
          });
          return inserted;
        },
        addTerminalContext: (threadRef, context) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId) {
            return;
          }
          get().addTerminalContexts(
            typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
            [context],
          );
        },
        addTerminalContexts: (threadRef, contexts, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          const threadId = resolveComposerThreadId(get(), threadRef);
          if (!threadKey || !threadId || contexts.length === 0) {
            return;
          }
          const currentContexts = get().draftsByThreadKey[threadKey]?.terminalContexts ?? [];
          const incoming = normalizeTerminalContextsForThread(threadId, [
            ...currentContexts,
            ...contexts,
          ]).slice(currentContexts.length);
          if (incoming.length === 0) return;
          const placedAtCaret =
            options?.appendReference !== false &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.(incoming.map(terminalContextReference)) ??
              false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
              ...existing.terminalContexts,
              ...contexts,
            ]).slice(existing.terminalContexts.length);
            if (acceptedContexts.length === 0) {
              return state;
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    placedAtCaret || options?.appendReference === false
                      ? existing.prompt
                      : ensureInlineContextReferences(
                          existing.prompt,
                          [...existing.terminalContexts, ...acceptedContexts].map(
                            terminalContextReference,
                          ),
                        ),
                  terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
                },
              },
            };
          });
        },
        removeTerminalContext: (threadRef, contextId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0 || contextId.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                toKindScopedComposerContextId("terminal", contextId),
              ).prompt,
              terminalContexts: current.terminalContexts.filter(
                (context) => context.id !== contextId,
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        clearTerminalContexts: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current || current.terminalContexts.length === 0) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: current.terminalContexts.reduce(
                (prompt, context) =>
                  removeInlineContextReference(prompt, terminalContextReference(context).contextId)
                    .prompt,
                current.prompt,
              ),
              terminalContexts: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addPreviewAnnotation: (threadRef, annotation, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          const compactAnnotation: PreviewAnnotationPayload = {
            ...annotation,
            screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: "" } : null,
          };
          const reference = previewAnnotationContextReference(compactAnnotation);
          const current = get().draftsByThreadKey[threadKey];
          const alreadyPresent =
            current?.previewAnnotations.some((entry) => entry.id === annotation.id) ?? false;
          // The handler calls setPrompt; running it inside the updater would overwrite the inserted reference.
          const placedAtCaret =
            !alreadyPresent &&
            options?.appendReference !== false &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const nextAnnotations = existing.previewAnnotations.filter(
              (entry) => entry.id !== annotation.id,
            );
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    alreadyPresent || placedAtCaret || options?.appendReference === false
                      ? existing.prompt
                      : appendInlineContextReference(existing.prompt, reference),
                  previewAnnotations: [...nextAnnotations, compactAnnotation],
                },
              },
            };
          });
        },
        setPreviewAnnotations: (threadRef, annotations) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const retainedIds = new Set(annotations.map((annotation) => annotation.id));
            let prompt = existing.prompt;
            for (const previous of existing.previewAnnotations) {
              if (retainedIds.has(previous.id)) continue;
              prompt = removeInlineContextReference(
                prompt,
                previewAnnotationContextId(previous.id),
              ).prompt;
            }
            prompt = ensureInlineContextReferences(
              prompt,
              annotations.map(previewAnnotationContextReference),
            );
            const nextDraft = { ...existing, prompt, previewAnnotations: [...annotations] };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        removePreviewAnnotation: (threadRef, annotationId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey || !annotationId) return;
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) return state;
            const previewAnnotations = current.previewAnnotations.filter(
              (entry) => entry.id !== annotationId,
            );
            if (previewAnnotations.length === current.previewAnnotations.length) return state;
            const nextDraft = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                previewAnnotationContextId(annotationId),
              ).prompt,
              previewAnnotations,
              images: current.images.filter((image) => image.id !== annotationId),
              persistedAttachments: current.persistedAttachments.filter(
                (image) => image.id !== annotationId,
              ),
              nonPersistedImageIds: current.nonPersistedImageIds.filter(
                (imageId) => imageId !== annotationId,
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addReviewComment: (threadRef, comment, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey || !isReviewCommentContext(comment)) return;
          const reference = reviewCommentContextReference(comment);
          const current = get().draftsByThreadKey[threadKey];
          const alreadyPresent =
            current?.reviewComments.some((entry) => entry.id === comment.id) ?? false;
          const shouldPlaceReference =
            options?.appendReference !== false &&
            (!alreadyPresent || options?.allowDuplicateReference === true);
          // Editor insertion must finish before this update reads the draft it extends.
          const placedAtCaret =
            shouldPlaceReference &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const reviewComments = existing.reviewComments.filter(
              (entry) => entry.id !== comment.id,
            );
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    !shouldPlaceReference || placedAtCaret
                      ? existing.prompt
                      : appendInlineContextReference(existing.prompt, reference),
                  reviewComments: [...reviewComments, { ...comment }],
                },
              },
            };
          });
        },
        setContextInsertionHandler: (threadRef, handler) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          if (handler) contextInsertionHandlers.set(threadKey, handler);
          else contextInsertionHandlers.delete(threadKey);
          return () => {
            if (contextInsertionHandlers.get(threadKey) === handler) {
              contextInsertionHandlers.delete(threadKey);
            }
          };
        },
        setReviewComments: (threadRef, comments) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          const reviewComments = comments
            .filter(isReviewCommentContext)
            .map((comment) => ({ ...comment }));
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const retainedIds = new Set(reviewComments.map((comment) => comment.id));
            let prompt = existing.prompt;
            for (const previous of existing.reviewComments) {
              if (retainedIds.has(previous.id)) continue;
              prompt = removeInlineContextReference(
                prompt,
                reviewCommentContextId(previous.id),
              ).prompt;
            }
            prompt = ensureInlineContextReferences(
              prompt,
              reviewComments.map(reviewCommentContextReference),
            );
            const nextDraft = { ...existing, prompt, reviewComments };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        addThreadContexts: (threadRef, records, options) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          const existingIds = new Set(
            (get().draftsByThreadKey[threadKey]?.threadContexts ?? []).map(
              (record) => record.contextId,
            ),
          );
          const incoming = records.filter((record) => {
            if (existingIds.has(record.contextId)) return false;
            existingIds.add(record.contextId);
            return true;
          });
          if (incoming.length === 0) return;
          const references = incoming.map(threadContextReference);
          const placedAtCaret =
            options?.appendReference !== false &&
            options?.insertAtCaret !== false &&
            (contextInsertionHandlers.get(threadKey)?.(references) ?? false);
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const known = new Set(existing.threadContexts.map((record) => record.contextId));
            const accepted = incoming.filter((record) => !known.has(record.contextId));
            if (accepted.length === 0) return state;
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt:
                    placedAtCaret || options?.appendReference === false
                      ? existing.prompt
                      : ensureInlineContextReferences(
                          existing.prompt,
                          accepted.map(threadContextReference),
                        ),
                  threadContexts: [...existing.threadContexts, ...accepted],
                },
              },
            };
          });
        },
        setThreadContexts: (threadRef, records) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) return;
          const threadContexts = records
            .filter(isThreadContextRecord)
            .map((record) => ({ ...record }));
          set((state) => {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
            const retainedIds = new Set(threadContexts.map((record) => record.contextId));
            let prompt = existing.prompt;
            for (const previous of existing.threadContexts) {
              if (retainedIds.has(previous.contextId)) continue;
              prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
            }
            prompt = ensureInlineContextReferences(
              prompt,
              threadContexts.map(threadContextReference),
            );
            const nextDraft = { ...existing, prompt, threadContexts };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        removeReviewComment: (threadRef, commentId) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey || !commentId) return;
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) return state;
            const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId);
            if (reviewComments.length === current.reviewComments.length) return state;
            const nextDraft = {
              ...current,
              prompt: removeInlineContextReference(
                current.prompt,
                reviewCommentContextId(commentId),
              ).prompt,
              reviewComments,
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
            else nextDraftsByThreadKey[threadKey] = nextDraft;
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        clearPersistedAttachments: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              persistedAttachments: [],
              nonPersistedImageIds: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        syncPersistedAttachments: async (threadRef, attachments) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef);
          if (!threadKey) {
            return;
          }
          const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              persistedAttachments: attachments,
              nonPersistedImageIds: current.nonPersistedImageIds.filter(
                (id) => !attachmentIdSet.has(id),
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
          await Promise.resolve();
          verifyPersistedAttachments(threadKey, attachments, set);
        },
        clearComposerContent: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: "",
              images: [],
              files: [],
              nonPersistedImageIds: [],
              persistedAttachments: [],
              terminalContexts: [],
              previewAnnotations: [],
              reviewComments: [],
              threadContexts: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        clearComposerPromptAndImages: (threadRef) => {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
          if (threadKey.length === 0) {
            return;
          }
          set((state) => {
            const current = state.draftsByThreadKey[threadKey];
            if (!current) {
              return state;
            }
            for (const image of current.images) {
              revokeObjectPreviewUrl(image.previewUrl);
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: ensureInlineContextReferences("", [
                ...current.terminalContexts.map(terminalContextReference),
                ...current.reviewComments.map(reviewCommentContextReference),
                ...current.threadContexts.map(threadContextReference),
                ...current.previewAnnotations.map(previewAnnotationContextReference),
              ]),
              images: [],
              files: [],
              nonPersistedImageIds: [],
              persistedAttachments: [],
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadKey[threadKey];
            } else {
              nextDraftsByThreadKey[threadKey] = nextDraft;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
        moveComposerPromptAndImages: (from, to) => {
          const fromKey = resolveComposerDraftKey(get(), from) ?? "";
          const toKey = resolveComposerDraftKey(get(), to) ?? "";
          if (fromKey.length === 0 || toKey.length === 0 || fromKey === toKey) {
            return;
          }
          set((state) => {
            const source = state.draftsByThreadKey[fromKey];
            if (!source) {
              return state;
            }
            const destination = state.draftsByThreadKey[toKey] ?? createEmptyThreadDraft();
            const destinationEnvironmentId =
              typeof to === "string"
                ? (state.draftThreadsByThreadKey[toKey]?.environmentId ??
                  parseScopedThreadKey(toKey)?.environmentId ??
                  null)
                : to.environmentId;
            const destinationFileIds = new Set(destination.files.map((file) => file.id));
            const destinationFileKeys = new Set(destination.files.map(composerFileDedupKey));
            const transferableFiles = source.files.filter(
              (file) =>
                (file.file !== null || file.uploadEnvironmentId === destinationEnvironmentId) &&
                !destinationFileIds.has(file.id) &&
                !destinationFileKeys.has(composerFileDedupKey(file)),
            );
            const remainingAttachmentSlots = Math.max(
              0,
              PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
                destination.images.length -
                destination.files.length,
            );
            const movedImages = source.images.slice(0, remainingAttachmentSlots);
            const movedImageIds = new Set(movedImages.map((image) => image.id));
            const retainedImages = source.images.filter((image) => !movedImageIds.has(image.id));
            const movedFiles = transferableFiles
              .slice(0, remainingAttachmentSlots - movedImages.length)
              .map((file) => {
                // Re-upload local bytes across environments; the destination cannot reach source upload ids.
                if (
                  file.file === null ||
                  file.uploadEnvironmentId === undefined ||
                  file.uploadEnvironmentId === destinationEnvironmentId
                ) {
                  return file;
                }
                const { uploadedAttachmentId: _a, uploadEnvironmentId: _e, ...rest } = file;
                return rest;
              });
            const movedFileIds = new Set(movedFiles.map((file) => file.id));
            const retainedFiles = source.files.filter((file) => !movedFileIds.has(file.id));
            const movedPrompt = ensureInlineContextReferences(
              stripInlineContextReferences(source.prompt),
              destination.terminalContexts.map(terminalContextReference),
            );
            const nextDestination: ComposerThreadDraftState = {
              ...destination,
              prompt: movedPrompt,
              images: [...destination.images, ...movedImages],
              files: [...destination.files, ...movedFiles],
              nonPersistedImageIds: [
                ...destination.nonPersistedImageIds,
                ...source.nonPersistedImageIds.filter((imageId) => movedImageIds.has(imageId)),
              ],
              persistedAttachments: [
                ...destination.persistedAttachments,
                ...source.persistedAttachments.filter((attachment) =>
                  movedImageIds.has(attachment.id),
                ),
              ],
            };
            // Moved images still use these blob URLs at the destination; do not revoke them.
            const nextSource: ComposerThreadDraftState = {
              ...source,
              prompt: ensureInlineContextReferences(
                "",
                source.terminalContexts.map(terminalContextReference),
              ),
              images: retainedImages,
              files: retainedFiles,
              nonPersistedImageIds: source.nonPersistedImageIds.filter(
                (imageId) => !movedImageIds.has(imageId),
              ),
              persistedAttachments: source.persistedAttachments.filter(
                (attachment) => !movedImageIds.has(attachment.id),
              ),
            };
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            if (shouldRemoveDraft(nextSource)) {
              delete nextDraftsByThreadKey[fromKey];
            } else {
              nextDraftsByThreadKey[fromKey] = nextSource;
            }
            if (shouldRemoveDraft(nextDestination)) {
              delete nextDraftsByThreadKey[toKey];
            } else {
              nextDraftsByThreadKey[toKey] = nextDestination;
            }
            return { draftsByThreadKey: nextDraftsByThreadKey };
          });
        },
      };
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      partialize: (state): ComposerPersistState => ({ capturedState: state }),
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
            threadKey,
            toHydratedThreadDraft(draft),
          ]),
        );
        const draftThreadsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(
            ([threadKey, draftThread]) => [threadKey, toHydratedDraftThreadState(draftThread)],
          ),
        ) as Record<string, DraftThreadState>;
        return {
          ...currentState,
          draftsByThreadKey,
          draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyOptionsByModelByProvider: normalizedPersisted.stickyOptionsByModelByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export const useComposerDraftStore = composerDraftStore;

export function subscribeComposerDraftModelReconciliation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
  readonly shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, unknown>>;
}): () => void {
  const draftsAtom = Atom.make(composerDraftStore.getState());
  const unsubscribeDrafts = composerDraftStore.subscribe((state) =>
    input.registry.set(draftsAtom, state),
  );
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const matchesAtom = Atom.make((get) => {
    const state = get(draftsAtom);
    const threadKeys = get(threadKeysAtom);
    const matches: Array<readonly [string, ComposerThreadDraftState]> = [];
    for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
      // Local drafts can materialize a shell before their first turn is submitted.
      if (state.draftThreadsByThreadKey[key] || draft.activeProvider === null) continue;
      const ref = parseScopedThreadKey(key);
      const pick = draft.modelSelectionByProvider[draft.activeProvider];
      if (!ref || !pick || !threadKeys.has(key)) continue;
      const thread = get(input.threadShellAtom(ref));
      if (!thread || !draftModelPickMatchesThread(pick, thread.modelSelection)) continue;
      // Status and selection must come from the same emission; derived atoms can update apart.
      const shell = Option.getOrNull(
        AsyncResult.value(get(input.shellStateAtom(ref.environmentId))),
      );
      if (shell?.status !== "live") continue;
      const authoritativeThread = Option.getOrNull(shell.snapshot)?.threads.find(
        (candidate) => candidate.id === ref.threadId,
      );
      if (
        authoritativeThread &&
        draftModelPickMatchesThread(pick, authoritativeThread.modelSelection)
      ) {
        matches.push([key, draft]);
      }
    }
    return matches;
  });
  const unsubscribeMatches = input.registry.subscribe(
    matchesAtom,
    (matches) => {
      if (matches.length === 0) return;
      composerDraftStore.setState((state) => {
        const drafts = { ...state.draftsByThreadKey };
        for (const [key, matchedDraft] of matches) {
          if (drafts[key] !== matchedDraft) continue;
          const { modelSelectionExplicit: _explicit, ...retained } = matchedDraft;
          const draft = { ...retained, activeProvider: null, modelSelectionByProvider: {} };
          if (shouldRemoveDraft(draft)) delete drafts[key];
          else drafts[key] = draft;
        }
        return { draftsByThreadKey: drafts };
      });
    },
    { immediate: true },
  );
  return () => {
    unsubscribeMatches();
    unsubscribeDrafts();
  };
}

export function beginBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => ({
    backgroundSubmissionThreadKeys: { ...state.backgroundSubmissionThreadKeys, [threadKey]: true },
  }));
}

export function clearBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (!state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    const backgroundSubmissionThreadKeys = { ...state.backgroundSubmissionThreadKeys };
    delete backgroundSubmissionThreadKeys[threadKey];
    return { backgroundSubmissionThreadKeys };
  });
}

export function useBackgroundDraftSubmissionPending(threadRef: ScopedThreadRef | null): boolean {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  return useComposerDraftStore(
    (state) => threadKey !== null && state.backgroundSubmissionThreadKeys[threadKey] === true,
  );
}

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }
        revokeDraftThreadPreviewUrls(draft);
        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;
    const nextBackgroundSubmissionThreadKeys = Object.fromEntries(
      Object.entries(state.backgroundSubmissionThreadKeys).filter(
        ([threadKey]) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
      ),
    ) as Record<string, true>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
      backgroundSubmissionThreadKeys: nextBackgroundSubmissionThreadKeys,
      rewindingThreadKeys: new Set(
        [...state.rewindingThreadKeys].filter(
          (threadKey) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
        ),
      ),
    };
  });
  composerDebouncedStorage.flush();
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

export function useThreadHasUnsentDraft(threadRef: ScopedThreadRef): boolean {
  return useComposerDraftStore((state) =>
    composerDraftHasUserContent(getComposerDraftState(state, threadRef)),
  );
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function restoreFailedDraftThread(
  draftId: DraftId,
  draftThread: DraftThreadState,
  threadId: ThreadId,
): void {
  useComposerDraftStore.setState((state) => ({
    draftThreadsByThreadKey: {
      ...state.draftThreadsByThreadKey,
      [draftId]: {
        ...(state.draftThreadsByThreadKey[draftId] ?? draftThread),
        threadId,
        ...(threadId !== draftThread.threadId ? { createdAt: new Date().toISOString() } : {}),
        promotedTo: null,
      },
    },
  }));
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;
    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }
  clearBackgroundDraftSubmissionByRef(threadRef);
}
