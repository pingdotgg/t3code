/**
 * Pi thread registration, applied model selection and prompt payload resolution.
 */
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import {
  PI_INHERIT_MODEL_SLUG,
  PI_PROVIDER,
  STREAM_FLUSH_MS,
  PI_REQUEST_TIMEOUT_MS,
  PI_SESSION_TIMEOUT_MS,
  PI_UNSOLICITED_ACTIVITY_ERROR,
  SETTLE_PROBE_MAX_ATTEMPTS,
  SETTLE_PROBE_RETRY_DELAY,
  PI_THINKING_LEVELS,
  PI_COMPACTING_PROMPT_REJECTION,
  PiProviderCapabilitiesV2,
  contentText,
  piToolOutput,
  providerRef,
  compactionTitle,
  piApprovalRequestKind,
} from "../adapter.ts";
import type {
  PiAdapterV2Options,
  PiStreamItemState,
  PiCompactionStatus,
  PiCompactionState,
  PiProviderRetryState,
  ActivePiTurn,
  PiTurnTreeRefs,
  PendingPiPrompt,
  PiPromptSend,
  PiThreadState,
  PiWake,
} from "../adapter.ts";
import { protocolError } from "./protocol.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";
import type { Usage } from "./usage.ts";

export const makeThreads = (deps: State & Emitters & Usage) => {
  const {
    options,
    input,
    fileSystem,
    idAllocator,
    host,
    now,
    request,
    lifecycleRequest,
  } = deps;
  const m = deps.mutable;
  const registerThread = Effect.fnUntraced(function* (
    threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
    publish = true,
  ) {
    if (m.rollbackBarrier !== null)
      return yield* protocolError("Cannot register a Pi thread during rollback");
    if (m.threadState !== null && m.threadState.activeTurn !== null) {
      return yield* protocolError("Cannot register a Pi thread while a turn is active");
    }
    if (m.pendingWake !== null) {
      const state = m.threadState;
      if (
        state !== null &&
        state === m.pendingWake.state &&
        state.providerThread.appThreadId === threadInput.threadId &&
        (threadInput.existingProviderThread === undefined ||
          threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
            state.providerThread.nativeThreadRef?.nativeId)
      )
        return state.providerThread;
      return yield* protocolError(
        "Cannot switch Pi threads while native work is awaiting a turn",
      );
    }
    const existing = threadInput.existingProviderThread;
    const resumeId = existing?.nativeThreadRef?.nativeId;
    const needsNewSession = resumeId == null && m.registrationAttempted;
    m.registrationAttempted = true;
    if (resumeId != null || needsNewSession) {
      m.lastNativeThreadId = resumeId ?? m.lastNativeThreadId;
      // Failed lifecycle operations can still change native sessions; invalidate bindings and defaults.
      m.threadState = null;
      m.appliedModel = null;
      m.appliedThinking = null;
      m.appliedSessionName = null;
      m.baselineModel = null;
      m.baselineThinking = null;
      m.contextWindow = null;
      const result = yield* lifecycleRequest(
        resumeId != null
          ? { type: "switch_session", sessionPath: resumeId }
          : { type: "new_session" },
      );
      if (recordField(result, "cancelled") === true) {
        return yield* protocolError("A Pi extension cancelled the session switch");
      }
    }
    const stateData = yield* request({ type: "get_state" });
    if (!m.modelsDiscovered) {
      const modelsData = yield* request({ type: "get_available_models" }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const models = recordField(modelsData, "models");
      if (Array.isArray(models)) {
        for (const model of models) deps.rememberModelContextWindow(model);
        m.modelsDiscovered = true;
      }
    }
    m.contextWindow = deps.rememberModelContextWindow(recordField(stateData, "model"));
    // Capture each baseline before applying selections so our own choices cannot become Pi defaults.
    if (m.baselineModel === null && m.appliedModel === null) {
      const stateModel = recordField(stateData, "model");
      const provider = recordString(stateModel, "provider");
      const modelId = recordString(stateModel, "id");
      if (provider !== undefined && modelId !== undefined) {
        m.baselineModel = { provider, modelId };
      }
    }
    if (m.baselineThinking === null && m.appliedThinking === null) {
      m.baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
    }
    // switch_session accepts a file path, not Pi's display session UUID.
    const nativeId = recordString(stateData, "sessionFile");
    if (nativeId === undefined) {
      return yield* protocolError("get_state returned no persisted sessionFile", stateData);
    }
    if (needsNewSession && nativeId === m.lastNativeThreadId) {
      return yield* protocolError("Pi did not create a distinct session file");
    }
    m.lastNativeThreadId = nativeId;
    const createdAt = yield* DateTime.now;
    const providerThread: OrchestrationV2ProviderThread =
      existing !== undefined
        ? {
            ...existing,
            providerSessionId: input.providerSessionId,
            nativeThreadRef: providerRef(nativeId),
            ...(needsNewSession ? { nativeConversationHeadRef: null, contextUsage: null } : {}),
            status: "idle",
            updatedAt: createdAt,
          }
        : {
            id: idAllocator.derive.providerThread({
              driver: PI_PROVIDER,
              nativeThreadId: nativeId,
            }),
            driver: PI_PROVIDER,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadInput.threadId,
            ownerNodeId: null,
            nativeThreadRef: providerRef(nativeId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt: createdAt,
          };
    m.threadState = { providerThread, activeTurn: null };
    const baselineEntries = yield* request({ type: "get_entries" }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    m.lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
    m.leafCursorStale = baselineEntries === undefined;
    if (publish)
      yield* deps.emit({
        type: "provider_thread.updated",
        driver: PI_PROVIDER,
        providerThread,
      });
    return providerThread;
  });

  const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
    const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
    if (modelSelection.model === PI_INHERIT_MODEL_SLUG) {
      if (m.appliedModel !== null && m.baselineModel !== null) {
        const restoredModel = yield* request({ type: "set_model", ...m.baselineModel });
        m.contextWindow = deps.rememberModelContextWindow(restoredModel);
        m.appliedModel = null;
        const updatedAt = yield* DateTime.now;
        m.sessionEntity = { ...m.sessionEntity, model: PI_INHERIT_MODEL_SLUG, updatedAt };
        yield* deps.emit({
          type: "provider_session.updated",
          driver: PI_PROVIDER,
          providerSession: m.sessionEntity,
        });
      }
      if (
        thinking === undefined &&
        m.appliedThinking !== null &&
        m.baselineThinking !== null &&
        m.appliedThinking !== m.baselineThinking
      ) {
        yield* request({ type: "set_thinking_level", level: m.baselineThinking });
        m.appliedThinking = null;
      }
    } else if (modelSelection.model !== m.appliedModel) {
      const parsed = parsePiModelSlug(modelSelection.model);
      if (parsed === null) {
        return yield* protocolError(
          `Pi model '${modelSelection.model}' must use provider/model format`,
        );
      }
      const selectedModel = yield* request({
        type: "set_model",
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      m.contextWindow = deps.rememberModelContextWindow(selectedModel);
      m.appliedModel = modelSelection.model;
      const updatedAt = yield* DateTime.now;
      m.sessionEntity = { ...m.sessionEntity, model: modelSelection.model, updatedAt };
      yield* deps.emit({
        type: "provider_session.updated",
        driver: PI_PROVIDER,
        providerSession: m.sessionEntity,
      });
    }
    if (
      thinking !== undefined &&
      thinking !== m.appliedThinking &&
      PI_THINKING_LEVELS.has(thinking)
    ) {
      yield* request({ type: "set_thinking_level", level: thinking });
      m.appliedThinking = thinking;
    }
  });

  const resolvePromptPayload = Effect.fnUntraced(function* (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const message = yield* providerMessageTextWithAttachmentPaths({
      text,
      attachments,
      resolveAttachmentPath: host.resolveAttachmentPath,
      resolveExtractedTextPath: host.resolveExtractedTextPath,
    });
    for (const attachment of attachments) {
      const path = host.resolveAttachmentPath(attachment);
      if (path === null) continue;
      if (attachment.mimeType.startsWith("image/")) {
        const bytes = yield* fileSystem.readFile(path);
        images.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
    }
    return { message, images };
  });

  return { registerThread, applySelection, resolvePromptPayload };
};

export type Threads = ReturnType<typeof makeThreads>;
