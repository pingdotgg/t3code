import {
  CODEX_REASONING_EFFORT_OPTIONS,
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DeepMutable } from "effect/Types";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type ChatImageAttachment } from "./types";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 2;
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

const composerDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});
type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(ProviderModelOptions),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  codexFastMode: Schema.optionalKey(Schema.Boolean),
  serviceTier: Schema.optionalKey(Schema.String),
});
type LegacyCodexFields = typeof LegacyCodexFields.Type;

type LegacyPersistedCodexThreadDraftState = PersistedComposerThreadDraftState & LegacyCodexFields;

const PersistedDraftThreadState = Schema.Struct({
  projectId: ProjectId,
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
});
type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadId: Schema.Record(ThreadId, PersistedComposerThreadDraftState),
  draftThreadsByThreadId: Schema.Record(ThreadId, PersistedDraftThreadState),
  projectDraftThreadIdByProjectId: Schema.Record(ProjectId, ThreadId),
});
type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  provider: ProviderKind | null;
  model: string | null;
  modelOptions: ProviderModelOptions | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  getDraftThreadByProjectId: (projectId: ProjectId) => ProjectDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setProvider: (threadId: ThreadId, provider: ProviderKind | null | undefined) => void;
  setModel: (threadId: ThreadId, model: string | null | undefined) => void;
  setModelOptions: (
    threadId: ThreadId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  insertTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadId: ThreadId, contextId: string) => void;
  clearTerminalContexts: (threadId: ThreadId) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadId: ThreadId) => void;
  clearThreadDraft: (threadId: ThreadId) => void;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE: PersistedComposerDraftStoreState = {
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByProjectId: {},
};

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  provider: null,
  model: null,
  modelOptions: null,
  runtimeMode: null,
  interactionMode: null,
});

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    provider: null,
    model: null,
    modelOptions: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
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
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.provider === null &&
    draft.model === null &&
    draft.modelOptions === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" ? value : null;
}

function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: LegacyCodexFields,
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate =
    candidate?.codex && typeof candidate.codex === "object"
      ? (candidate.codex as Record<string, unknown>)
      : null;
  const claudeCandidate =
    candidate?.claudeAgent && typeof candidate.claudeAgent === "object"
      ? (candidate.claudeAgent as Record<string, unknown>)
      : null;

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
  const codexFastMode =
    codexCandidate?.fastMode === true ||
    (provider === "codex" && legacy?.codexFastMode === true) ||
    (typeof legacy?.serviceTier === "string" && legacy.serviceTier === "fast");
  const codex =
    codexReasoningEffort && codexReasoningEffort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex
      ? {
          reasoningEffort: codexReasoningEffort,
          ...(codexFastMode ? { fastMode: true } : {}),
        }
      : codexFastMode
        ? { fastMode: true }
        : undefined;

  const claudeThinking = claudeCandidate?.thinking === false ? false : undefined;
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode = claudeCandidate?.fastMode === true;
  const claude =
    claudeThinking === false ||
    (claudeEffort && claudeEffort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent) ||
    claudeFastMode
      ? {
          ...(claudeThinking === false ? { thinking: false } : {}),
          ...(claudeEffort && claudeEffort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent
            ? { effort: claudeEffort }
            : {}),
          ...(claudeFastMode ? { fastMode: true } : {}),
        }
      : undefined;

  if (!codex && !claude) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
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
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
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

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectId: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadId" | "projectDraftThreadIdByProjectId"
> {
  const draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState> = {};
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        projectId: projectId as ProjectId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode:
          candidateDraftThread.runtimeMode === "approval-required" ||
          candidateDraftThread.runtimeMode === "full-access"
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
      };
    }
  }

  const projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {};
  if (
    rawProjectDraftThreadIdByProjectId &&
    typeof rawProjectDraftThreadIdByProjectId === "object"
  ) {
    for (const [projectId, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectId as Record<string, unknown>,
    )) {
      if (
        typeof projectId === "string" &&
        projectId.length > 0 &&
        typeof threadId === "string" &&
        threadId.length > 0
      ) {
        projectDraftThreadIdByProjectId[projectId as ProjectId] = threadId as ThreadId;
        if (!draftThreadsByThreadId[threadId as ThreadId]) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            projectId: projectId as ProjectId,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            envMode: "local",
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.projectId !== projectId) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            projectId: projectId as ProjectId,
          };
        }
      }
    }
  }

  return { draftThreadsByThreadId, projectDraftThreadIdByProjectId };
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  resolveModelOptions: (
    draftCandidate: PersistedComposerThreadDraftState | LegacyPersistedCodexThreadDraftState,
    provider: ProviderKind | null,
  ) => ProviderModelOptions | null,
): PersistedComposerDraftStoreState["draftsByThreadId"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const nextDraftsByThreadId: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadId"]> =
    {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as
      | PersistedComposerThreadDraftState
      | LegacyPersistedCodexThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const provider = normalizeProviderKind(draftCandidate.provider);
    const model =
      typeof draftCandidate.model === "string"
        ? normalizeModelSlug(draftCandidate.model, provider ?? "codex")
        : null;
    const runtimeMode =
      draftCandidate.runtimeMode === "approval-required" ||
      draftCandidate.runtimeMode === "full-access"
        ? draftCandidate.runtimeMode
        : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const modelOptions = resolveModelOptions(draftCandidate, provider);
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      !provider &&
      !model &&
      modelOptions === null &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      attachments,
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(modelOptions ? { modelOptions } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByThreadId;
}

function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
  persistedVersion: number,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = persistedState as Record<string, unknown>;
  const rawDraftMap = candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId = candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectId = candidate.projectDraftThreadIdByProjectId;
  const { draftThreadsByThreadId, projectDraftThreadIdByProjectId } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectId);
  const draftsByThreadId = normalizePersistedDraftsByThreadId(
    rawDraftMap,
    (draftCandidate, provider) =>
      persistedVersion >= COMPOSER_DRAFT_STORAGE_VERSION
        ? normalizeProviderModelOptions(draftCandidate.modelOptions, provider)
        : normalizeProviderModelOptions(
            draftCandidate.modelOptions,
            provider,
            draftCandidate as LegacyPersistedCodexThreadDraftState,
          ),
  );
  return {
    draftsByThreadId,
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
  };
}

function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const persistedDraftsByThreadId: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadId"]
  > = {};
  for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.provider === null &&
      draft.model === null &&
      draft.modelOptions === null &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
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
            })),
          }
        : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.modelOptions ? { modelOptions: draft.modelOptions } : {}),
      ...(draft.provider ? { provider: draft.provider } : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
  }
  return {
    draftsByThreadId: persistedDraftsByThreadId,
    draftThreadsByThreadId: state.draftThreadsByThreadId,
    projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
  };
}

function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as Record<string, unknown>;
  const { draftThreadsByThreadId, projectDraftThreadIdByProjectId } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.projectDraftThreadIdByProjectId,
    );
  return {
    draftsByThreadId: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadId,
      (draftCandidate, provider) =>
        normalizeProviderModelOptions(draftCandidate.modelOptions, provider),
    ),
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
  };
}

function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
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
    return (persisted.state.draftsByThreadId[threadId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function hydreatePersistedComposerImageAttachment(
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

function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydreatePersistedComposerImageAttachment(attachment);
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
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    provider: persistedDraft.provider ?? null,
    model: persistedDraft.model ?? null,
    modelOptions: persistedDraft.modelOptions ?? null,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      getDraftThreadByProjectId: (projectId) => {
        if (projectId.length === 0) {
          return null;
        }
        const threadId = get().projectDraftThreadIdByProjectId[projectId];
        if (!threadId) {
          return null;
        }
        const draftThread = get().draftThreadsByThreadId[threadId];
        if (!draftThread || draftThread.projectId !== projectId) {
          return null;
        }
        return {
          threadId,
          ...draftThread,
        };
      },
      getDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return null;
        }
        return get().draftThreadsByThreadId[threadId] ?? null;
      },
      setProjectDraftThreadId: (projectId, threadId, options) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[projectId];
          const nextWorktreePath =
            options?.worktreePath === undefined
              ? (existingThread?.worktreePath ?? null)
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId,
            createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            runtimeMode:
              options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              options?.interactionMode ??
              existingThread?.interactionMode ??
              DEFAULT_INTERACTION_MODE,
            branch:
              options?.branch === undefined
                ? (existingThread?.branch ?? null)
                : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options?.envMode ??
              (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
          };
          const hasSameProjectMapping = previousThreadIdForProject === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.runtimeMode === nextDraftThread.runtimeMode &&
            existingThread.interactionMode === nextDraftThread.interactionMode &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath &&
            existingThread.envMode === nextDraftThread.envMode;
          if (hasSameProjectMapping && hasSameDraftThread) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [projectId]: threadId,
          };
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (
            previousThreadIdForProject &&
            previousThreadIdForProject !== threadId &&
            !Object.values(nextProjectDraftThreadIdByProjectId).includes(previousThreadIdForProject)
          ) {
            delete nextDraftThreadsByThreadId[previousThreadIdForProject];
            if (state.draftsByThreadId[previousThreadIdForProject] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[previousThreadIdForProject];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setDraftThreadContext: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextProjectId = options.projectId ?? existing.projectId;
          if (nextProjectId.length === 0) {
            return state;
          }
          const nextWorktreePath =
            options.worktreePath === undefined
              ? existing.worktreePath
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId: nextProjectId,
            createdAt:
              options.createdAt === undefined
                ? existing.createdAt
                : options.createdAt || existing.createdAt,
            runtimeMode: options.runtimeMode ?? existing.runtimeMode,
            interactionMode: options.interactionMode ?? existing.interactionMode,
            branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
          };
          const isUnchanged =
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.runtimeMode === existing.runtimeMode &&
            nextDraftThread.interactionMode === existing.interactionMode &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath &&
            nextDraftThread.envMode === existing.envMode;
          if (isUnchanged) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [nextProjectId]: threadId,
          };
          if (existing.projectId !== nextProjectId) {
            if (nextProjectDraftThreadIdByProjectId[existing.projectId] === threadId) {
              delete nextProjectDraftThreadIdByProjectId[existing.projectId];
            }
          }
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      clearProjectDraftThreadId: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const threadId = state.projectDraftThreadIdByProjectId[projectId];
          if (threadId === undefined) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearProjectDraftThreadById: (projectId, threadId) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          if (state.projectDraftThreadIdByProjectId[projectId] !== threadId) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          if (!hasDraftThread && !hasProjectMapping) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftThreadIdByProjectId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<ProjectId, ThreadId>;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          return {
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setPrompt: (threadId, prompt) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt: ensureInlineTerminalContextPlaceholders(
              existing.prompt,
              normalizedContexts.length,
            ),
            terminalContexts: normalizedContexts,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setProvider: (threadId, provider) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderKind(provider);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedProvider === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.provider === normalizedProvider) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            provider: normalizedProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModel: (threadId, model) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          const normalizedModel = normalizeModelSlug(model, existing?.provider ?? "codex") ?? null;
          if (!existing && normalizedModel === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.model === normalizedModel) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            model: normalizedModel,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModelOptions: (threadId, modelOptions) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          const provider = existing?.provider ?? null;
          const nextModelOptions = normalizeProviderModelOptions(modelOptions, provider);
          if (!existing && nextModelOptions === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (JSON.stringify(base.modelOptions) === JSON.stringify(nextModelOptions)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelOptions: nextModelOptions,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setRuntimeMode: (threadId, runtimeMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextRuntimeMode =
          runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
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
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setInteractionMode: (threadId, interactionMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
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
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      addImage: (threadId, image) => {
        if (threadId.length === 0) {
          return;
        }
        get().addImages(threadId, [image]);
      },
      addImages: (threadId, images) => {
        if (threadId.length === 0 || images.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
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
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeImage: (threadId, imageId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      insertTerminalContext: (threadId, prompt, context, index) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
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
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: nextDraft,
            },
          };
        });
        return inserted;
      },
      addTerminalContext: (threadId, context) => {
        if (threadId.length === 0) {
          return;
        }
        get().addTerminalContexts(threadId, [context]);
      },
      addTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0 || contexts.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
            ...existing.terminalContexts,
            ...contexts,
          ]).slice(existing.terminalContexts.length);
          if (acceptedContexts.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                prompt: ensureInlineTerminalContextPlaceholders(
                  existing.prompt,
                  existing.terminalContexts.length + acceptedContexts.length,
                ),
                terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
              },
            },
          };
        });
      },
      removeTerminalContext: (threadId, contextId) => {
        if (threadId.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: current.terminalContexts.filter(
              (context) => context.id !== contextId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearTerminalContexts: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.terminalContexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearPersistedAttachments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      syncPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            // Stage attempted attachments so persist middleware can try writing them.
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
        Promise.resolve().then(() => {
          const persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadId));
          set((state) => {
            const current = state.draftsByThreadId[threadId];
            if (!current) {
              return state;
            }
            const imageIdSet = new Set(current.images.map((image) => image.id));
            const persistedAttachments = attachments.filter(
              (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
            );
            const nonPersistedImageIds = current.images
              .map((image) => image.id)
              .filter((imageId) => !persistedIdSet.has(imageId));
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              persistedAttachments,
              nonPersistedImageIds,
            };
            const nextDraftsByThreadId = { ...state.draftsByThreadId };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadId[threadId];
            } else {
              nextDraftsByThreadId[threadId] = nextDraft;
            }
            return { draftsByThreadId: nextDraftsByThreadId };
          });
        });
      },
      clearComposerContent: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearThreadDraft: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (existing) {
          for (const image of existing.images) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        set((state) => {
          const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          if (!hasComposerDraft && !hasDraftThread && !hasProjectMapping) {
            return state;
          }
          const { [threadId]: _removedComposerDraft, ...restComposerDraftsByThreadId } =
            state.draftsByThreadId;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftThreadIdByProjectId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<ProjectId, ThreadId>;
          return {
            draftsByThreadId: restComposerDraftsByThreadId,
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => composerDebouncedStorage),
      migrate: migratePersistedComposerDraftStoreState,
      partialize: partializeComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT);
}

/**
 * Clear draft threads that have been promoted to server threads.
 *
 * Call this after a snapshot sync so the route guard in `_chat.$threadId`
 * sees the server thread before the draft is removed — avoids a redirect
 * to `/` caused by a gap where neither draft nor server thread exists.
 */
export function clearPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.clearDraftThread(draftId);
    }
  }
}
