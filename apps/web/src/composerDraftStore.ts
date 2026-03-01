import {
  DEFAULT_REASONING,
  ProjectId,
  REASONING_OPTIONS,
  ThreadId,
  normalizeModelSlug,
  type ReasoningEffort,
} from "@t3tools/contracts";
import type { ChatImageAttachment } from "./types";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";

const SAFE_LOCAL_STORAGE: StateStorage = {
  getItem: (key) => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Swallow quota/storage errors so draft state stays usable in-memory.
    }
  },
  removeItem: (key) => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Best-effort cleanup.
    }
  },
};

export interface PersistedComposerImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

interface PersistedComposerThreadDraftState {
  prompt: string;
  cursor: number;
  attachments: PersistedComposerImageAttachment[];
  model?: string | null;
  effort?: ReasoningEffort | null;
}

interface PersistedDraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  branch: string | null;
  worktreePath: string | null;
}

interface PersistedComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, PersistedComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
}

export interface ComposerThreadDraftState {
  prompt: string;
  cursor: number;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  model: string | null;
  effort: ReasoningEffort | null;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  branch: string | null;
  worktreePath: string | null;
}

interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  readDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  isDraftThread: (threadId: ThreadId) => boolean;
  readProjectDraftThreadId: (projectId: ProjectId) => ThreadId | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setCursor: (threadId: ThreadId, cursor: number) => void;
  setModel: (threadId: ThreadId, model: string | null | undefined) => void;
  setEffort: (threadId: ThreadId, effort: ReasoningEffort | null | undefined) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (threadId: ThreadId, attachments: PersistedComposerImageAttachment[]) => void;
  clearComposerContent: (threadId: ThreadId) => void;
  clearThreadDraft: (threadId: ThreadId) => void;
}

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_THREAD_DRAFT: ComposerThreadDraftState = {
  prompt: "",
  cursor: 0,
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  model: null,
  effort: null,
};

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>(REASONING_OPTIONS);

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    cursor: 0,
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    model: null,
    effort: null,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.model === null &&
    draft.effort === null
  );
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

function normalizePersistedComposerDraftState(value: unknown): PersistedComposerDraftStoreState {
  if (!value || typeof value !== "object") {
    return { draftsByThreadId: {}, draftThreadsByThreadId: {}, projectDraftThreadIdByProjectId: {} };
  }
  const candidate = value as Record<string, unknown>;
  const rawDraftMap = candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId = candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectId = candidate.projectDraftThreadIdByProjectId;
  const draftThreadsByThreadId: PersistedComposerDraftStoreState["draftThreadsByThreadId"] = {};
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
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        projectId: projectId as ProjectId,
        createdAt: typeof createdAt === "string" && createdAt.length > 0 ? createdAt : new Date().toISOString(),
        branch: typeof branch === "string" ? branch : null,
        worktreePath: typeof worktreePath === "string" ? worktreePath : null,
      };
    }
  }
  const projectDraftThreadIdByProjectId: PersistedComposerDraftStoreState["projectDraftThreadIdByProjectId"] =
    {};
  if (rawProjectDraftThreadIdByProjectId && typeof rawProjectDraftThreadIdByProjectId === "object") {
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
            branch: null,
            worktreePath: null,
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
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return { draftsByThreadId: {}, draftThreadsByThreadId, projectDraftThreadIdByProjectId };
  }
  const nextDraftsByThreadId: PersistedComposerDraftStoreState["draftsByThreadId"] = {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as Record<string, unknown>;
    const prompt = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const cursor =
      typeof draftCandidate.cursor === "number" && Number.isFinite(draftCandidate.cursor)
        ? Math.max(0, Math.floor(draftCandidate.cursor))
        : 0;
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const model =
      typeof draftCandidate.model === "string" ? normalizeModelSlug(draftCandidate.model) : null;
    const effortCandidate =
      typeof draftCandidate.effort === "string" ? draftCandidate.effort : null;
    const effort =
      effortCandidate && REASONING_EFFORT_VALUES.has(effortCandidate as ReasoningEffort)
        ? (effortCandidate as ReasoningEffort)
        : null;
    if (prompt.length === 0 && attachments.length === 0 && !model && !effort) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      cursor,
      attachments,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }
  return { draftsByThreadId: nextDraftsByThreadId, draftThreadsByThreadId, projectDraftThreadIdByProjectId };
}

function fileFromDataUrl(dataUrl: string, name: string, mimeType: string): File | null {
  const [rawHeader, payload] = dataUrl.split(",", 2);
  const header = rawHeader ?? "";
  if (!payload) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : mimeType;
      return new File([decodedText], name, { type: inferredMimeType || mimeType });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], name, { type: mimeType });
  } catch {
    return null;
  }
}

function hydrateImagesFromPersisted(
  attachments: PersistedComposerImageAttachment[],
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = fileFromDataUrl(attachment.dataUrl, attachment.name, attachment.mimeType);
    if (!file) {
      return [];
    }
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

function readPersistedDraftStateFromLocalStorage(): PersistedComposerDraftStoreState {
  if (typeof window === "undefined") {
    return { draftsByThreadId: {}, draftThreadsByThreadId: {}, projectDraftThreadIdByProjectId: {} };
  }
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) {
      return { draftsByThreadId: {}, draftThreadsByThreadId: {}, projectDraftThreadIdByProjectId: {} };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "state" in parsed) {
      return normalizePersistedComposerDraftState((parsed as { state?: unknown }).state);
    }
    return normalizePersistedComposerDraftState(parsed);
  } catch {
    return { draftsByThreadId: {}, draftThreadsByThreadId: {}, projectDraftThreadIdByProjectId: {} };
  }
}

function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  return {
    prompt: persistedDraft.prompt,
    cursor: persistedDraft.cursor,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: persistedDraft.attachments,
    model: persistedDraft.model ?? null,
    effort: persistedDraft.effort ?? null,
  };
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      readDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return null;
        }
        return get().draftThreadsByThreadId[threadId] ?? null;
      },
      isDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return false;
        }
        return get().draftThreadsByThreadId[threadId] !== undefined;
      },
      readProjectDraftThreadId: (projectId) => {
        if (projectId.length === 0) {
          return null;
        }
        return get().projectDraftThreadIdByProjectId[projectId] ?? null;
      },
      setProjectDraftThreadId: (projectId, threadId, options) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[projectId];
          const nextDraftThread: DraftThreadState = {
            projectId,
            createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            branch:
              options && "branch" in options
                ? (options.branch ?? null)
                : (existingThread?.branch ?? null),
            worktreePath:
              options && "worktreePath" in options
                ? (options.worktreePath ?? null)
                : (existingThread?.worktreePath ?? null),
          };
          const hasSameProjectMapping = previousThreadIdForProject === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath;
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
          if (
            previousThreadIdForProject &&
            previousThreadIdForProject !== threadId &&
            !Object.values(nextProjectDraftThreadIdByProjectId).includes(previousThreadIdForProject)
          ) {
            delete nextDraftThreadsByThreadId[previousThreadIdForProject];
          }
          return {
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
          const nextDraftThread: DraftThreadState = {
            projectId: nextProjectId,
            createdAt:
              options.createdAt === undefined ? existing.createdAt : (options.createdAt || existing.createdAt),
            branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
            worktreePath:
              options.worktreePath === undefined
                ? existing.worktreePath
                : (options.worktreePath ?? null),
          };
          const isUnchanged =
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath;
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
          const { [projectId]: _removed, ...restProjectMappingsRaw } = state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
          }
          return {
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
          const { [projectId]: _removed, ...restProjectMappingsRaw } = state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
          }
          return {
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
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(threadId);
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
          const cursor = Math.min(existing.cursor, prompt.length);
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
            cursor,
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
      setCursor: (threadId, cursor) => {
        if (threadId.length === 0) {
          return;
        }
        const nextCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextCursor === 0) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          const boundedCursor = Math.min(nextCursor, base.prompt.length);
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            cursor: boundedCursor,
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
        const normalizedModel = normalizeModelSlug(model) ?? null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
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
      setEffort: (threadId, effort) => {
        if (threadId.length === 0) {
          return;
        }
        const nextEffort =
          effort &&
          REASONING_EFFORT_VALUES.has(effort) &&
          effort !== DEFAULT_REASONING
            ? effort
            : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextEffort === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.effort === nextEffort) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            effort: nextEffort,
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
          const existingDedupKeys = new Set(existing.images.map((image) => composerImageDedupKey(image)));
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
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) =>
              !attachmentIdSet.has(id),
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
          const persistedIdSet = new Set(readPersistedComposerDraftAttachmentIds(threadId));
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
            cursor: 0,
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
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
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(threadId);
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
      version: 1,
      storage: createJSONStorage(() => SAFE_LOCAL_STORAGE),
      partialize: (state) => {
        const persistedDraftsByThreadId: PersistedComposerDraftStoreState["draftsByThreadId"] = {};
        for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
          if (typeof threadId !== "string" || threadId.length === 0) {
            continue;
          }
          if (
            draft.prompt.length === 0 &&
            draft.persistedAttachments.length === 0 &&
            draft.model === null &&
            draft.effort === null
          ) {
            continue;
          }
          const persistedDraft: PersistedComposerThreadDraftState = {
            prompt: draft.prompt,
            cursor: Math.min(Math.max(0, draft.cursor), draft.prompt.length),
            attachments: draft.persistedAttachments,
          };
          if (draft.model) {
            persistedDraft.model = draft.model;
          }
          if (draft.effort) {
            persistedDraft.effort = draft.effort;
          }
          persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
        }
        return {
          draftsByThreadId: persistedDraftsByThreadId,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
        };
      },
      merge: (persistedState, currentState) => {
        const normalizedPersisted = normalizePersistedComposerDraftState(persistedState);
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

export function readPersistedComposerDraftAttachmentIds(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
    return [];
  }
  return readPersistedComposerDraftAttachments(threadId).map((attachment) => attachment.id);
}

export function readPersistedComposerDraftAttachments(
  threadId: ThreadId,
): PersistedComposerImageAttachment[] {
  if (threadId.length === 0) {
    return [];
  }
  const persisted = readPersistedDraftStateFromLocalStorage();
  return persisted.draftsByThreadId[threadId]?.attachments ?? [];
}
