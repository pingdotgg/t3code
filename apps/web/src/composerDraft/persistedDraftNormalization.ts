import { ReviewCommentContextSchema } from "../reviewCommentContext";
import {
  ElementContextDetails,
  EnvironmentContextRecord,
  PreviewAnnotationPayloadSchema,
  RuntimeMode,
  SnapShotSource,
  ThreadContextRecord,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  LegacyPersistedComposerThreadDraftState,
  PersistedComposerDraftStoreState,
  PersistedComposerImageAttachment,
  PersistedComposerThreadDraftState,
  PersistedDraftThreadState,
  PersistedTerminalContextDraft,
  isPersistedComposerDraftFileAttachment,
} from "./draftTypes";
import {
  compactModelSelectionByProvider,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
} from "./modelSelectionNormalization";
import {
  composerThreadRefFromKey,
  normalizeDraftThreadEnvMode,
  normalizeLegacyComposerStorageKey,
  projectDraftKey,
} from "./draftStateHelpers";
import { elementContextToPreviewAnnotation } from "../lib/elementContext";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DeepMutable } from "effect/Types";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { migrateLegacyTerminalContextPlaceholders } from "../lib/terminalContext";
import {
  ensureInlineContextReferences,
  formatInlineContextReference,
} from "../lib/composerContextReferences";
import { terminalContextReference } from "../lib/composerContextRecords";
import {
  toComposerContextId,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isElementContextDetails = Schema.is(ElementContextDetails);
const isRuntimeMode = Schema.is(RuntimeMode);
const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);
const isThreadContextRecord = Schema.is(ThreadContextRecord);
const isEnvironmentContextRecord = Schema.is(EnvironmentContextRecord);
const isSnapShotSource = Schema.is(SnapShotSource);
const isPreviewAnnotationPayload = Schema.is(PreviewAnnotationPayloadSchema);
export function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
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

export function normalizePersistedTerminalContextDraft(
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
export function normalizePersistedDraftThreads(
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
export const decodePersistedModelSelection = Schema.decodeUnknownOption(ModelSelection);

/** Storage v3-v5 wrote `provider` and object-shaped options; the schema upgrades both. */
export function normalizePersistedModelSelectionByProvider(
  value: object,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([instanceId, selection]) =>
      Option.match(decodePersistedModelSelection(selection), {
        onNone: () => [],
        onSome: (decoded) => [[instanceId, decoded] as const],
      }),
    ),
  );
}

export function normalizePersistedDraftsByThreadId(
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
    const environmentContexts = Array.isArray(draftCandidate.environmentContexts)
      ? draftCandidate.environmentContexts.filter(isEnvironmentContextRecord)
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
      modelSelectionByProvider = normalizePersistedModelSelectionByProvider(
        draftCandidate.modelSelectionByProvider,
      );
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
      environmentContexts.length === 0 &&
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
      ...(environmentContexts.length > 0 ? { environmentContexts } : {}),
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
export function persistedComposerDraftHasUserContent(draft: PersistedComposerThreadDraftState): boolean {
  return (
    draft.prompt.trim().length > 0 ||
    draft.attachments.length > 0 ||
    (draft.files?.length ?? 0) > 0 ||
    (draft.terminalContexts?.length ?? 0) > 0 ||
    (draft.previewAnnotations?.length ?? 0) > 0 ||
    (draft.reviewComments?.length ?? 0) > 0 ||
    (draft.threadContexts?.length ?? 0) > 0 ||
    (draft.environmentContexts?.length ?? 0) > 0
  );
}

export function stripLegacyModelSeedsFromEmptyDraftSessions(
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
