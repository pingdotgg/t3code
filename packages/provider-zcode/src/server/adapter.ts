import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Predicate from "effect/Predicate";
import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type RuntimeMode,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { ZcodeSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";

import {
  isServerRequest,
  makeZcodeConnection,
  zcodeJsonStringify,
  zcodeRecordArray,
  zcodeRecordField,
  zcodeRecordNumber,
  zcodeRecordString,
  type ZcodeConnection,
  type ZcodeRecord,
} from "./zcodeProtocol.ts";
import {
  resolveZcodeCatalogFiles,
  resolveZcodeLaunchCommand,
  zcodeModelSelectionFromSlug,
  zcodeRuntimeEnvironment,
  zcodeSpawnArgs,
  type ZcodeCatalogFileSet,
} from "./zcodeRuntime.ts";
import {
  makeZcodeRequestAuth,
  zcodeAccountConfigPushFromLadder,
  zcodeFamilyFromProviderId,
} from "./zcodeRequestAuth.ts";

export const ZCODE_PROVIDER: ProviderDriverKind = ProviderDriverKind.make("zcode");
const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZcodeSettings)({});

const STREAM_FLUSH_MS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// MCP boot dominates session startup; the probe measured 10s+ with plugins enabled.
const SESSION_CREATE_TIMEOUT_MS = 150_000;
const T3_MCP_SERVER_NAME = "t3-code";
const USAGE_LIMIT_ERROR_PATTERN = /rate limit|quota|usage limit|too many requests/i;

const ZcodeProviderCapabilitiesV2: OrchestrationV2ProviderCapabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    // The protocol has no conversation rollback method.
    canRollbackThread: false,
    // session/fork exists on the wire, but its thread-handoff mapping into T3 is unwired.
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: false,
    activeSteeringAcceptsAttachments: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    // tool.updated carries subagent attribution, but the child-session projection shape is
    // unverified; wrong OrchestrationV2Subagent records would corrupt the run tree.
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
};

export interface ZcodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZcodeSettings;
  /** Instance environment already merged with the host process environment. */
  readonly environment: NodeJS.ProcessEnv;
  /** Testkit injection point; production spawns the real `zcode app-server`. */
  readonly makeConnection?: typeof makeZcodeConnection;
  /** Testkit injection point; production mints OAuth project tokens from the local store. */
  readonly makeRequestAuth?: typeof makeZcodeRequestAuth;
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: ZCODE_PROVIDER, nativeId, strength };
}

/**
 * Zcode enforces tool gating itself: guarded gates everything through the permission client,
 * edit auto-accepts file changes, yolo never asks. Unoffered stored modes arrive as
 * Supervised, so anything unexpected falls back to the strictest mode.
 */
function zcodeSessionMode(runtimeMode: RuntimeMode | undefined): "guarded" | "edit" | "yolo" {
  switch (runtimeMode) {
    case "auto-accept-edits":
      return "edit";
    case "full-access":
      return "yolo";
    default:
      return "guarded";
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block) =>
      zcodeRecordString(block ?? {}, "type") === "text"
        ? (zcodeRecordString(block, "text") ?? "")
        : "",
    )
    .join("");
}

interface ZcodeAvailableModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly defaultReasoningLevel?: string;
}

/** Parses the create result's `settings.model.available` descriptors. */
function parseZcodeAvailableModels(input: unknown): ReadonlyArray<ZcodeAvailableModel> {
  if (!Array.isArray(input)) return [];
  const out: Array<ZcodeAvailableModel> = [];
  for (const entry of input) {
    if (!Predicate.isObject(entry)) continue;
    const ref = entry["ref"];
    const providerId = zcodeRecordString(ref, "providerId");
    const modelId = zcodeRecordString(ref, "modelId");
    if (providerId === undefined || modelId === undefined) continue;
    const reasoning = entry["reasoning"];
    const defaultLevel = Predicate.isObject(reasoning)
      ? zcodeRecordString(reasoning, "defaultLevel")
      : undefined;
    out.push({
      providerId,
      modelId,
      ...(defaultLevel === undefined ? {} : { defaultReasoningLevel: defaultLevel }),
    });
  }
  return out;
}

function toolResultOutput(result: unknown): string | undefined {
  if (!Predicate.isObject(result)) return undefined;
  const direct = zcodeRecordString(result, "output") ?? zcodeRecordString(result, "text");
  if (direct !== undefined) return direct;
  const content = zcodeRecordField(result, "content");
  if (content !== undefined) {
    const text = contentText(content);
    if (text.length > 0) return text;
  }
  return undefined;
}

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "powershell", "cmd", "terminal", "exec"]);
const FILE_WRITE_TOOL_NAMES = new Set(["write", "edit", "applypatch", "multiedit", "notebookedit"]);

interface ZcodeStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

interface ZcodeToolState {
  readonly toolCallId: string;
  name: string | undefined;
  input: unknown;
  readonly startedAt: DateTime.Utc;
  output: string | undefined;
}

interface ZcodePermissionOptionRecord {
  readonly optionId: string;
  readonly kind: string;
  readonly name: string;
  readonly response: ZcodeRecord;
}

function zcodePermissionOptions(value: unknown): ReadonlyArray<ZcodePermissionOptionRecord> {
  const raw = zcodeRecordArray(value ?? {}, "options") ?? [];
  const options: Array<ZcodePermissionOptionRecord> = [];
  for (const entry of raw) {
    const optionId = zcodeRecordString(entry ?? {}, "optionId");
    const kind = zcodeRecordString(entry ?? {}, "kind");
    const name = zcodeRecordString(entry ?? {}, "name");
    const response = zcodeRecordField(entry ?? {}, "response");
    if (
      optionId === undefined ||
      kind === undefined ||
      name === undefined ||
      !Predicate.isObject(response)
    ) {
      continue;
    }
    options.push({ optionId, kind, name, response });
  }
  return options;
}

/** Chooses the exact response object zcode's broker expects for a T3 decision. */
function zcodeApprovalResponseForDecision(
  options: ReadonlyArray<ZcodePermissionOptionRecord>,
  decision: ProviderApprovalDecision,
): ZcodeRecord | undefined {
  const byKind = (kinds: ReadonlyArray<string>) =>
    options.find((option) => kinds.includes(option.kind))?.response;
  const byResponseDecision = (value: string) =>
    options.find((option) => zcodeRecordString(option.response, "decision") === value)?.response;
  switch (decision) {
    case "accept":
      return byKind(["allow_once"]) ?? byResponseDecision("allow");
    case "acceptForSession":
    case "acceptAlways":
      return byKind(["allow_always"]) ?? byKind(["allow_once"]) ?? byResponseDecision("allow");
    case "decline":
    case "cancel":
      return byKind(["deny", "reject"]) ?? byResponseDecision("deny");
  }
}

function zcodeApprovalDecisionForOption(
  option: ZcodePermissionOptionRecord,
): ProviderApprovalDecision {
  if (option.kind === "allow_once") return "accept";
  if (option.kind === "allow_always") return "acceptForSession";
  if (option.kind === "deny" || option.kind === "reject") return "decline";
  return zcodeRecordString(option.response, "decision") === "allow" ? "accept" : "decline";
}

interface ZcodePendingApproval {
  readonly nativeRequestId: string;
  readonly options: ReadonlyArray<ZcodePermissionOptionRecord>;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  /** The exact PermissionResponse object zcode's broker expects; null until the user answers. */
  chosenResponse: ZcodeRecord | null;
}

interface ZcodePendingQuestion {
  readonly nativeRequestId: string;
  readonly questionId: string;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  answer: { readonly value: string } | { readonly cancelled: true } | null;
}

interface ZcodeAwaitingRequest {
  readonly respondId: string;
  readonly nativeRequestId: string;
}

interface ActiveZcodeTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  readonly streamItems: Map<string, ZcodeStreamItemState>;
  readonly tools: Map<string, ZcodeToolState>;
  upsertedItemId: string | null;
  interrupted: boolean;
  failure: OrchestrationV2ProviderFailure | null;
  finalized: boolean;
}

interface ZcodeThreadState {
  providerThread: OrchestrationV2ProviderThread;
  readonly nativeSessionId: string;
  activeTurn: ActiveZcodeTurn | null;
}

function zcodeFailureFromErrorDetail(error: unknown): OrchestrationV2ProviderFailure {
  const record = Predicate.isObject(error) ? error : {};
  const message = zcodeRecordString(record, "message") ?? "ZCode reported a turn error.";
  const usageLimited = USAGE_LIMIT_ERROR_PATTERN.test(message);
  const configurationGap =
    zcodeRecordString(record, "code") === "CONFIGURATION_ERROR" &&
    message.toLowerCase().includes("select a model");
  return makeProviderFailure({
    message: configurationGap
      ? "ZCode resolved no usable model for this environment. Update the ZCode CLI on the server machine, then refresh the provider. Model provisioning over the local protocol is broken in CLI 0.17.1."
      : message,
    code: zcodeRecordString(record, "code") ?? null,
    class: usageLimited ? "usage_limit" : "provider_error",
    ...(usageLimited ? { retryable: true as const } : {}),
  });
}

export const makeZcodeAdapterV2 = Effect.fn("makeZcodeAdapterV2")(function* (
  options: ZcodeAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const httpClient = yield* HttpClient.HttpClient;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ZCODE_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  const requestAuth = (options.makeRequestAuth ?? makeZcodeRequestAuth)({
    fileSystem,
    httpClient,
    environment: options.environment,
    clientVersion: "0.0.0",
  });

  const zcodeMcpServers = (
    session: McpProviderSessionConfig | undefined,
  ): ReadonlyArray<ZcodeRecord> | undefined =>
    session === undefined
      ? undefined
      : [
          {
            name: T3_MCP_SERVER_NAME,
            type: "http",
            url: session.endpoint,
            headers: [{ name: "Authorization", value: session.authorizationHeader }],
          },
        ];

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: ZCODE_PROVIDER,
    getCapabilities: Effect.fn("ZcodeAdapter.getCapabilities")(function () {
      return Effect.succeed(ZcodeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("ZcodeAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("ZcodeAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      // Catalog files must exist before spawn: the CLI fails closed on dangling env paths.
      const catalogFiles: ZcodeCatalogFileSet = yield* resolveZcodeCatalogFiles(
        fileSystem,
        options.environment,
      );
      const env = zcodeRuntimeEnvironment(options.environment, catalogFiles);
      const launchCommand = yield* resolveZcodeLaunchCommand(
        options.settings,
        options.environment,
        fileSystem,
      );
      const scopedLaunch = yield* agentScope.wrap({
        command: launchCommand,
        args: zcodeSpawnArgs(options.settings.launchArgs),
        name: "zcode",
        threadId: input.threadId,
        env,
      });
      // Finalizers run in reverse order: reap detached work after terminating zcode.
      const scopeUnit = scopedLaunch.unit;
      const stopScope =
        scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
      yield* Effect.addFinalizer(() => stopScope);
      const connection: ZcodeConnection = yield* (options.makeConnection ?? makeZcodeConnection)({
        command: scopedLaunch.command,
        args: scopedLaunch.args,
        cwd,
        env,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: ZCODE_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      // Detached children can keep stdout open after zcode exits.
      if (scopeUnit !== undefined) {
        yield* connection.exited.pipe(
          Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
          Effect.forkIn(scope),
        );
      }

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: ZCODE_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: ZcodeProviderCapabilitiesV2,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingApprovals = new Map<string, ZcodePendingApproval>();
      const pendingQuestions = new Map<string, ZcodePendingQuestion>();
      const awaitingPermissionRequests = new Map<string, ZcodeAwaitingRequest>();
      const awaitingUserInputRequests = new Map<string, ZcodeAwaitingRequest>();
      // Pump, turn installs, and dialog answers share one permit so terminal events cannot
      // overtake the runtime request resolution they correlate with.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: ZcodeThreadState | null = null;
      // Session models come from the CLI's own create-result advertisement; per-session, so a
      // resume re-populates them.
      let availableModels: ReadonlyArray<ZcodeAvailableModel> = [];
      let transportDown = false;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          transportDown = true;
        }),
      );

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: ZCODE_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          state: ZcodeThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
        ) {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: ZCODE_PROVIDER,
            providerThread: state.providerThread,
          });
        });

      const request = (
        method: string,
        params: ZcodeRecord,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      ) => connection.request(method, params, timeoutMs);

      const itemOrdinal = (turn: ActiveZcodeTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const baseItemFields = (
        turn: ActiveZcodeTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: ZCODE_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: ZCODE_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActiveZcodeTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: ZCODE_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: ZCODE_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitStreamItem =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          turn: ActiveZcodeTurn,
          item: ZcodeStreamItemState,
          streaming: boolean,
        ) {
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: ZCODE_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: ZCODE_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver: ZCODE_PROVIDER,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: base.nodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActiveZcodeTurn, item: ZcodeStreamItemState) {
          if (item.flushScheduled || item.completed || turn.finalized) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed || turn.finalized
                  ? Effect.void
                  : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActiveZcodeTurn,
        kind: ZcodeStreamItemState["kind"],
        messageId: string,
        partId: string,
      ) {
        const nativeItemId = `${messageId}:${partId}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: ZcodeStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (
        turn: ActiveZcodeTurn,
        item: ZcodeStreamItemState,
        text?: string,
      ) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActiveZcodeTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      const toolStateFor = (
        turn: ActiveZcodeTurn,
        payload: ZcodeRecord,
        startedAt: DateTime.Utc,
      ): ZcodeToolState | undefined => {
        const toolCallId = zcodeRecordString(payload, "toolCallId");
        if (toolCallId === undefined) return undefined;
        const existing = turn.tools.get(toolCallId);
        if (existing !== undefined) {
          const name = zcodeRecordString(payload, "toolName");
          if (name !== undefined) existing.name = name;
          return existing;
        }
        const state: ZcodeToolState = {
          toolCallId,
          name: zcodeRecordString(payload, "toolName"),
          input: zcodeRecordField(payload, "input"),
          startedAt,
          output: undefined,
        };
        turn.tools.set(toolCallId, state);
        return state;
      };

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActiveZcodeTurn,
        tool: ZcodeToolState,
        status: OrchestrationV2TurnItem["status"],
      ) {
        const emittedAt = yield* DateTime.now;
        const completed = status === "completed" || status === "failed" || status === "interrupted";
        const base = baseItemFields(turn, tool.toolCallId, tool.startedAt, emittedAt);
        const nodeStatus: OrchestrationV2ExecutionNode["status"] =
          status === "failed" ? "failed" : completed ? status : "running";
        yield* emitItemNode(
          turn,
          tool.toolCallId,
          "tool_call",
          nodeStatus,
          tool.startedAt,
          completed ? emittedAt : null,
        );
        const toolName = tool.name ?? "tool";
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "command_execution",
              input:
                Predicate.isObject(tool.input) && typeof tool.input["command"] === "string"
                  ? tool.input["command"]
                  : zcodeJsonStringify(tool.input ?? {}),
              ...(tool.output === undefined ? {} : { output: tool.output }),
            },
          });
          return;
        }
        const fileName = Predicate.isObject(tool.input)
          ? (zcodeRecordString(tool.input, "file_path") ?? zcodeRecordString(tool.input, "path"))
          : undefined;
        if (FILE_WRITE_TOOL_NAMES.has(toolName.toLowerCase()) && fileName !== undefined) {
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "file_change",
              fileName,
              ...(tool.output === undefined ? {} : { diffStr: tool.output }),
            },
          });
          return;
        }
        yield* emit({
          type: "turn_item.updated",
          driver: ZCODE_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: Predicate.isObject(tool.input) ? tool.input : {},
            ...(tool.output === undefined ? {} : { output: tool.output }),
          },
        });
      });

      const emitRuntimeRequestShell = Effect.fnUntraced(function* (
        nativeRequestId: string,
        kind: OrchestrationV2RuntimeRequest["kind"],
        questions: ReadonlyArray<OrchestrationV2UserInputQuestion> | undefined,
        approval:
          | {
              readonly requestKind: ProviderRequestKind;
              readonly prompt: string;
              readonly options: ReadonlyArray<ProviderApprovalOption>;
            }
          | undefined,
        state: ZcodeThreadState | null,
        turn: ActiveZcodeTurn | null,
      ): Effect.fn.Return<RuntimeRequestId, IdAllocator.IdAllocatorV2Error> {
        const createdAt = yield* DateTime.now;
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: ZCODE_PROVIDER,
          ...(providerTurnId === null ? {} : { providerTurnId }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: questions !== undefined ? "user_input_request" : "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          title: null,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          questions !== undefined
            ? {
                ...itemBase,
                type: "user_input_request",
                requestId,
                questions: [...questions],
              }
            : {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: approval?.requestKind ?? "command",
                ...(approval === undefined ? {} : { prompt: approval.prompt }),
                ...(approval === undefined || approval.options.length === 0
                  ? {}
                  : { options: approval.options }),
              };
        if (questions !== undefined) {
          pendingQuestions.set(String(requestId), {
            nativeRequestId,
            questionId: questions[0]?.id ?? nativeRequestId,
            runtimeRequest,
            node,
            turnItem,
            answer: null,
          });
        } else {
          pendingApprovals.set(String(requestId), {
            nativeRequestId,
            options: [],
            runtimeRequest,
            node,
            turnItem,
            chosenResponse: null,
          });
        }
        yield* emit({
          type: "runtime_request.updated",
          driver: ZCODE_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
        return requestId;
      });

      const resolveRuntimeRequestRecords = Effect.fnUntraced(function* (
        pending: ZcodePendingApproval | ZcodePendingQuestion,
        resolvedAt: DateTime.Utc,
      ) {
        pending.runtimeRequest = { ...pending.runtimeRequest, status: "resolved", resolvedAt };
        yield* emit({
          type: "runtime_request.updated",
          driver: ZCODE_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* emit({
          type: "node.updated",
          driver: ZCODE_PROVIDER,
          node: { ...pending.node, status: "completed", completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: ZCODE_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: "completed",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      });

      const cancelRuntimeRequest = Effect.fnUntraced(function* (
        pending: ZcodePendingApproval | ZcodePendingQuestion,
        respondWith: unknown,
      ) {
        const resolvedAt = yield* DateTime.now;
        pending.runtimeRequest = { ...pending.runtimeRequest, status: "cancelled", resolvedAt };
        if ("chosenResponse" in pending) {
          pendingApprovals.delete(String(pending.runtimeRequest.id));
          for (const [respondId, awaitingRequest] of awaitingPermissionRequests) {
            if (awaitingRequest.nativeRequestId === pending.nativeRequestId) {
              awaitingPermissionRequests.delete(respondId);
              // The transport may already be down during teardown; the deny is best-effort.
              yield* connection.respond(respondId, respondWith).pipe(Effect.ignore);
            }
          }
        } else {
          pendingQuestions.delete(String(pending.runtimeRequest.id));
          for (const [respondId, awaitingRequest] of awaitingUserInputRequests) {
            if (awaitingRequest.nativeRequestId === pending.nativeRequestId) {
              awaitingUserInputRequests.delete(respondId);
              yield* connection.respond(respondId, respondWith).pipe(Effect.ignore);
            }
          }
        }
        yield* emit({
          type: "runtime_request.updated",
          driver: ZCODE_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* emit({
          type: "node.updated",
          driver: ZCODE_PROVIDER,
          node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: ZCODE_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: "cancelled",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      });

      const cancelPendingRuntimeRequests = Effect.fnUntraced(function* () {
        for (const pending of Array.from(pendingApprovals.values())) {
          yield* cancelRuntimeRequest(pending, { decision: "deny", reason: "No user response" });
        }
        for (const pending of Array.from(pendingQuestions.values())) {
          yield* cancelRuntimeRequest(pending, { cancelled: true });
        }
      });

      const finalizeTurn = Effect.fnUntraced(function* (state: ZcodeThreadState) {
        const turn = state.activeTurn;
        if (turn === null || turn.finalized) return;
        turn.finalized = true;
        state.activeTurn = null;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        yield* cancelPendingRuntimeRequests();
        const failure = turn.interrupted ? null : turn.failure;
        yield* emit({
          type: "provider_turn.updated",
          driver: ZCODE_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            status: turn.interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
          },
        });
        yield* updateProviderThread(state, { status: "idle" });
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, failureItemId, completedAt, completedAt),
              status: "failed",
              title: null,
              completedAt,
              type: "error",
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: ZCODE_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          return;
        }
        yield* emit({
          type: "turn.terminal",
          driver: ZCODE_PROVIDER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          status: turn.interrupted ? "interrupted" : "completed",
          failure: null,
          threadDisposition: "reusable",
        });
      });

      const findApprovalByNativeId = (nativeRequestId: string) =>
        Array.from(pendingApprovals.values()).find(
          (candidate) => candidate.nativeRequestId === nativeRequestId,
        );
      const findQuestionByNativeId = (nativeRequestId: string) =>
        Array.from(pendingQuestions.values()).find(
          (candidate) => candidate.nativeRequestId === nativeRequestId,
        );
      // The broker request can arrive after the user already answered; keep chosen answers
      // findable so those late requests still carry the decision instead of parking forever.
      const answeredPermissions = new Map<string, ZcodeRecord>();
      const answeredUserInputs = new Map<
        string,
        { readonly value: string } | { readonly cancelled: true }
      >();

      const handleSessionEvent = Effect.fnUntraced(function* (
        eventType: string,
        payload: ZcodeRecord,
      ) {
        const state = threadState;
        const turn = state === null ? null : state.activeTurn;
        switch (eventType) {
          case "turn.started": {
            if (turn !== null) yield* updateProviderSession("running", null);
            return;
          }
          case "part.delta": {
            if (turn === null) return;
            const messageId = zcodeRecordString(payload, "messageId");
            const partId = zcodeRecordString(payload, "partId");
            const delta = zcodeRecordString(payload, "delta");
            const field = zcodeRecordString(payload, "field") ?? "text";
            if (messageId === undefined || partId === undefined || delta === undefined) return;
            if (field !== "text" && field !== "reasoning") return;
            const item = yield* streamItemFor(
              turn,
              field === "text" ? "assistant_message" : "reasoning",
              messageId,
              partId,
            );
            item.text += delta;
            yield* emit({
              type: "command_output.delta",
              driver: ZCODE_PROVIDER,
              threadId: turn.turnInput.threadId,
              itemId: idAllocator.derive.turnItemFromProviderItem({
                driver: ZCODE_PROVIDER,
                nativeItemId: item.nativeItemId,
              }),
              chunk: delta,
            });
            yield* scheduleStreamFlush(turn, item);
            return;
          }
          case "part.started":
          case "part.upserted": {
            if (turn === null) return;
            const part = zcodeRecordField(payload, "part");
            if (!Predicate.isObject(part)) return;
            const partType = zcodeRecordString(part, "type");
            const messageId = zcodeRecordString(part, "messageId");
            const partId = zcodeRecordString(part, "partId");
            if (messageId === undefined || partId === undefined) return;
            if (partType !== "text" && partType !== "reasoning") return;
            const item = yield* streamItemFor(
              turn,
              partType === "text" ? "assistant_message" : "reasoning",
              messageId,
              partId,
            );
            yield* completeStreamItem(turn, item, zcodeRecordString(part, "text") ?? item.text);
            return;
          }
          case "message.upserted": {
            if (turn === null) return;
            // Fallback for providers that skip part deltas: upserts carry no message id, so
            // they only contribute content when no streaming item exists for this turn.
            const text = zcodeRecordString(payload, "content") ?? contentText(payload);
            if (text.length === 0) return;
            const nativeItemId = turn.upsertedItemId ?? `upserted:${turn.providerTurn.id}:0`;
            const hasStreamItem = Array.from(turn.streamItems.keys()).some(
              (key) => key.startsWith("upserted:") === false,
            );
            if (hasStreamItem) return;
            turn.upsertedItemId = nativeItemId;
            const item = yield* streamItemFor(turn, "assistant_message", nativeItemId, "final");
            yield* completeStreamItem(turn, item, text);
            return;
          }
          case "model.streaming": {
            // The CLI's real text/reasoning stream: {assistantMessageId, delta, kind, done}.
            if (turn === null) return;
            const messageId = zcodeRecordString(payload, "assistantMessageId");
            const delta = zcodeRecordString(payload, "delta");
            if (messageId === undefined || delta === undefined) return;
            const kind = zcodeRecordString(payload, "kind") ?? "text_delta";
            if (kind !== "text_delta" && kind !== "reasoning_delta") return;
            const item = yield* streamItemFor(
              turn,
              kind === "text_delta" ? "assistant_message" : "reasoning",
              messageId,
              messageId,
            );
            item.text += delta;
            yield* emit({
              type: "command_output.delta",
              driver: ZCODE_PROVIDER,
              threadId: turn.turnInput.threadId,
              itemId: idAllocator.derive.turnItemFromProviderItem({
                driver: ZCODE_PROVIDER,
                nativeItemId: item.nativeItemId,
              }),
              chunk: delta,
            });
            if (payload["done"] === true) {
              yield* completeStreamItem(turn, item);
              return;
            }
            yield* scheduleStreamFlush(turn, item);
            return;
          }
          case "tool.updated": {
            if (turn === null) return;
            // Subagent-attributed calls belong to child sessions; projecting them as parent
            // tools would misplace work, and subagent capabilities are off.
            if (zcodeRecordString(payload, "source") === "subagent") return;
            const kind = zcodeRecordString(payload, "kind");
            const toolState = toolStateFor(turn, payload, yield* DateTime.now);
            if (toolState === undefined) return;
            switch (kind) {
              case "scheduled":
              case "started": {
                yield* emitToolItem(turn, toolState, "running");
                return;
              }
              case "progress": {
                const stdoutTail = zcodeRecordString(payload, "stdoutTail");
                const stderrTail = zcodeRecordString(payload, "stderrTail");
                const outputPreview = zcodeRecordField(payload, "outputPreview");
                const previewText = Predicate.isObject(outputPreview)
                  ? (zcodeRecordString(outputPreview, "text") ??
                    zcodeRecordString(outputPreview, "output"))
                  : undefined;
                const tail = [stdoutTail, stderrTail].filter((part) => part !== undefined).join("");
                const next = tail.length > 0 ? tail : previewText;
                if (next !== undefined && next.length > 0 && next !== toolState.output) {
                  toolState.output = next;
                  yield* emitToolItem(turn, toolState, "running");
                }
                return;
              }
              case "result": {
                const output = toolResultOutput(zcodeRecordField(payload, "result"));
                if (output !== undefined) toolState.output = output;
                yield* emitToolItem(turn, toolState, "completed");
                return;
              }
              case "error": {
                const error = zcodeRecordField(payload, "error");
                const message =
                  (Predicate.isObject(error) ? zcodeRecordString(error, "message") : undefined) ??
                  "Tool failed.";
                toolState.output = message;
                yield* emitToolItem(turn, toolState, turn.interrupted ? "interrupted" : "failed");
                return;
              }
              default:
                return;
            }
          }
          case "permission.requested": {
            const nativeRequestId =
              zcodeRecordString(payload, "requestId") ?? zcodeRecordString(payload, "toolCallId");
            if (nativeRequestId === undefined) return;
            const options = zcodePermissionOptions(payload);
            const requestId = yield* emitRuntimeRequestShell(
              nativeRequestId,
              "command",
              undefined,
              {
                requestKind: "command",
                prompt:
                  zcodeRecordString(payload, "reason") ??
                  `${zcodeRecordString(payload, "toolName") ?? "Tool"} needs approval`,
                options: options.map((option) => ({
                  decision: zcodeApprovalDecisionForOption(option),
                  label: option.name,
                })),
              },
              state,
              turn,
            );
            const pending = pendingApprovals.get(String(requestId));
            if (pending !== undefined)
              pendingApprovals.set(String(requestId), { ...pending, options });
            return;
          }
          case "permission.resolved": {
            const nativeRequestId =
              zcodeRecordString(payload, "requestId") ?? zcodeRecordString(payload, "toolCallId");
            if (nativeRequestId === undefined) return;
            const pending = findApprovalByNativeId(nativeRequestId);
            if (pending === undefined) return;
            pendingApprovals.delete(String(pending.runtimeRequest.id));
            yield* resolveRuntimeRequestRecords(pending, yield* DateTime.now);
            return;
          }
          case "userInput.requested": {
            const nativeRequestId = zcodeRecordString(payload, "requestId");
            if (nativeRequestId === undefined) return;
            const prompt = zcodeRecordString(payload, "prompt") ?? "The agent asked a question";
            const inputType = zcodeRecordString(payload, "inputType") ?? "text";
            const choices = (zcodeRecordArray(payload, "choices") ?? []).filter(
              (choice): choice is string => typeof choice === "string" && choice.length > 0,
            );
            yield* emitRuntimeRequestShell(
              nativeRequestId,
              "user_input",
              [
                {
                  id: nativeRequestId,
                  header: "Question",
                  question: prompt,
                  options: choices.map((choice) => ({
                    label: choice,
                    description: choice,
                    value: choice,
                  })),
                  // Free-text asks keep a custom answer even with preset choices.
                  ...(inputType === "text" || choices.length === 0
                    ? { allowCustomAnswer: true }
                    : {}),
                },
              ],
              undefined,
              state,
              turn,
            );
            return;
          }
          case "userInput.resolved": {
            const nativeRequestId = zcodeRecordString(payload, "requestId");
            if (nativeRequestId === undefined) return;
            const pending = findQuestionByNativeId(nativeRequestId);
            if (pending === undefined) return;
            pendingQuestions.delete(String(pending.runtimeRequest.id));
            yield* resolveRuntimeRequestRecords(pending, yield* DateTime.now);
            return;
          }
          case "turn.completed": {
            if (state === null || turn === null || turn.finalized) return;
            const resultType = zcodeRecordString(payload, "resultType") ?? "success";
            if (resultType === "success") {
              const tokenCount = zcodeRecordNumber(payload, "tokenCount");
              if (tokenCount !== undefined && tokenCount > 0) {
                const updatedAt = yield* DateTime.now;
                turn.providerTurn = {
                  ...turn.providerTurn,
                  tokenUsage: { usedTokens: tokenCount, updatedAt: DateTime.formatIso(updatedAt) },
                };
              }
              // The completed payload carries the authoritative full response; make sure an
              // assistant message exists even when the stream produced no mapped items.
              const response = zcodeRecordString(payload, "response");
              if (response !== undefined && response.length > 0) {
                const textItems = Array.from(turn.streamItems.entries()).filter(
                  ([, item]) => item.kind === "assistant_message",
                );
                const last = textItems.at(-1);
                if (last === undefined) {
                  const item = yield* streamItemFor(
                    turn,
                    "assistant_message",
                    `final:${turn.providerTurn.id}`,
                    "final",
                  );
                  yield* completeStreamItem(turn, item, response);
                } else {
                  yield* completeStreamItem(turn, last[1], response);
                }
              }
              yield* finalizeTurn(state);
              return;
            }
            if (resultType === "cancelled") {
              turn.interrupted = true;
              yield* finalizeTurn(state);
              return;
            }
            turn.failure =
              resultType === "error_max_budget"
                ? makeProviderFailure({
                    message: "The model provider usage limit was reached.",
                    class: "usage_limit",
                    code: resultType,
                    retryable: true,
                  })
                : makeProviderFailure({
                    message: `ZCode turn failed (${resultType}).`,
                    class: "provider_error",
                    code: resultType,
                  });
            yield* finalizeTurn(state);
            return;
          }
          case "turn.failed": {
            if (state === null || turn === null || turn.finalized) return;
            turn.failure = zcodeFailureFromErrorDetail(zcodeRecordField(payload, "error"));
            yield* finalizeTurn(state);
            return;
          }
          case "turn.steerQueued":
          case "turn.steerDrained":
          case "session.created":
          case "session.resumed":
          case "session.updated":
          case "session.titleUpdated":
          case "session.closed":
          case "checkpoint.created":
          case "rewind.triggered":
          case "part.removed":
          case "message.removed":
            return;
          default:
            yield* Effect.logDebug("Ignoring zcode session event.", { eventType });
            return;
        }
      });

      const handleServerRequest = Effect.fnUntraced(function* (record: ZcodeRecord) {
        const method = zcodeRecordString(record, "method") ?? "";
        const respondId = String(zcodeRecordField(record, "id") ?? "");
        switch (method) {
          case "session/requestRuntimePreferences": {
            yield* connection.respond(respondId, {
              nativeSearchEnhancementsEnabled: false,
              toolSearchMode: "off",
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: true,
              modelContextBudgetStrategy: "preflight-v1",
            });
            return;
          }
          case "interaction/requestOfficialMcpAuthHeaders": {
            yield* connection.respond(respondId, {});
            return;
          }
          case "interaction/requestProviderRuntimeHeaders": {
            const params = zcodeRecordField(record, "params");
            const providerId =
              zcodeRecordString(params ?? {}, "providerId") ??
              zcodeRecordString(
                zcodeRecordField(params ?? {}, "modelSelection") ?? {},
                "providerId",
              );
            const family = zcodeFamilyFromProviderId(providerId);
            if (family === undefined) {
              yield* connection.respond(respondId, {
                headersApplied: false,
                errorMessage: "Unsupported ZCode account provider.",
              });
              return;
            }
            const rejectedProjectTokenFingerprint = zcodeRecordString(
              params ?? {},
              "rejectedProjectTokenFingerprint",
            );
            const answer = requestAuth.answerRuntimeHeaders({
              family,
              ...(rejectedProjectTokenFingerprint === undefined
                ? {}
                : { rejectedProjectTokenFingerprint }),
            });
            yield* answer.pipe(
              Effect.flatMap((response) => connection.respond(respondId, response)),
              Effect.catchCause((cause) =>
                Effect.logWarning("ZCode runtime headers answer failed.", {
                  errorTag: causeErrorTag(cause),
                }),
              ),
            );
            return;
          }
          case "interaction/requestPermission": {
            const params = zcodeRecordField(record, "params");
            const nativeRequestId =
              zcodeRecordString(params ?? {}, "requestId") ??
              zcodeRecordString(params ?? {}, "toolCallId") ??
              respondId;
            const answered = findApprovalByNativeId(nativeRequestId);
            if (answered !== undefined && answered.chosenResponse !== null) {
              yield* connection.respond(respondId, answered.chosenResponse);
              return;
            }
            const stored = answeredPermissions.get(nativeRequestId);
            if (stored !== undefined) {
              yield* connection.respond(respondId, stored);
              return;
            }
            // Hold the broker request so a slower user answer still reaches zcode; cancel
            // paths answer it with a "No user response" denial instead.
            awaitingPermissionRequests.set(respondId, { respondId, nativeRequestId });
            return;
          }
          case "interaction/requestUserInput": {
            const params = zcodeRecordField(record, "params");
            const nativeRequestId = zcodeRecordString(params ?? {}, "requestId") ?? respondId;
            const answered = findQuestionByNativeId(nativeRequestId);
            if (answered !== undefined && answered.answer !== null) {
              yield* connection.respond(respondId, answered.answer);
              return;
            }
            const stored = answeredUserInputs.get(nativeRequestId);
            if (stored !== undefined) {
              yield* connection.respond(respondId, stored);
              return;
            }
            awaitingUserInputRequests.set(respondId, { respondId, nativeRequestId });
            return;
          }
          default: {
            yield* Effect.logDebug("Answering unknown zcode server request with {}.", { method });
            yield* connection.respond(respondId, {});
            return;
          }
        }
      });

      const handleLifecycle = Effect.fnUntraced(function* (params: ZcodeRecord) {
        const sessionId = zcodeRecordString(params, "sessionId");
        const state = threadState;
        if (state !== null && sessionId !== undefined && sessionId !== state.nativeSessionId)
          return;
        const lifecycleState = zcodeRecordString(params, "state");
        const lastError = zcodeRecordField(params, "lastError");
        switch (lifecycleState) {
          case "ready":
            yield* updateProviderSession(state?.activeTurn != null ? "running" : "ready", null);
            return;
          case "unloaded": {
            const errorDetail = Predicate.isObject(lastError)
              ? zcodeRecordString(lastError, "message")
              : undefined;
            if (state?.activeTurn != null) {
              state.activeTurn.failure = makeProviderFailure({
                message: errorDetail ?? "ZCode unloaded the session while a turn was running.",
                class: "transport_error",
                retryable: false,
              });
              yield* finalizeTurn(state);
            }
            yield* updateProviderSession("stopped", errorDetail ?? null);
            return;
          }
          default:
            return;
        }
      });

      const handleRecord = Effect.fnUntraced(function* (record: ZcodeRecord) {
        if (isServerRequest(record)) {
          yield* handleServerRequest(record);
          return;
        }
        const method = zcodeRecordString(record, "method");
        if (method === "session/event") {
          const params = zcodeRecordField(record, "params");
          if (!Predicate.isObject(params)) return;
          const eventType = zcodeRecordString(params, "type");
          if (eventType === undefined) return;
          const payload = zcodeRecordField(params, "payload");
          yield* handleSessionEvent(eventType, Predicate.isObject(payload) ? payload : {});
          return;
        }
        if (method === "session/lifecycle/changed") {
          const params = zcodeRecordField(record, "params");
          if (Predicate.isObject(params)) yield* handleLifecycle(params);
          return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const record = yield* Queue.take(connection.events);
          yield* sessionEventPermit.withPermits(1)(handleRecord(record));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            transportDown = true;
            const state = threadState;
            const interrupted = state?.activeTurn?.interrupted === true;
            if (state?.activeTurn != null) {
              state.activeTurn.failure = interrupted
                ? null
                : makeProviderFailure({
                    cause,
                    message: "zcode app-server exited unexpectedly.",
                    class: "transport_error",
                  });
              yield* finalizeTurn(state);
            } else {
              yield* cancelPendingRuntimeRequests();
            }
            yield* updateProviderSession(
              interrupted ? "stopped" : "error",
              interrupted
                ? "zcode app-server was stopped."
                : "zcode app-server exited unexpectedly.",
            );
            yield* Queue.fail(
              events,
              new ProviderAdapter.ProviderAdapterEventStreamError({
                driver: ZCODE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
            );
          }),
        ),
        Effect.forkIn(scope),
      );

      // Provisioning must precede session/create: the CLI resolves models against the registry
      // it builds from this push. Best-effort — a rejected push surfaces honestly as a
      // "Select a model" turn failure instead of failing the session open.
      const bootstrapProviderRegistry = Effect.fn("ZcodeAdapter.bootstrapProviderRegistry")(
        function* () {
          if (catalogFiles.builtinCatalog === undefined || catalogFiles.builtinPath === undefined) {
            yield* Effect.logWarning(
              "ZCode builtin catalog unavailable; account models will report as missing.",
              { builtinPath: catalogFiles.builtinPath ?? null },
            );
            return;
          }
          const push = yield* zcodeAccountConfigPushFromLadder(fileSystem, {
            builtinPath: catalogFiles.builtinPath,
            builtinCatalog: catalogFiles.builtinCatalog,
            environment: options.environment,
          });
          if (push === undefined) {
            yield* Effect.logWarning(
              "ZCode catalog declares no account providers; account models will report as missing.",
            );
            return;
          }
          yield* request("provider/updateAccountConfig", push).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("ZCode account config push failed.", {
                operation: error.operation,
              }),
            ),
            Effect.ignore,
          );
        },
      );
      yield* bootstrapProviderRegistry();

      const subscribeSession = (sessionId: string) =>
        request("session/subscribe", {
          sessionId,
          deliveryKind: "desktop-continuous",
          includeSnapshot: true,
        });

      const createNativeSession = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        const mcpServers = zcodeMcpServers(yield* mcpSessions.read(threadInput.threadId));
        const createParams: ZcodeRecord = {
          workspace: { workspacePath: cwd, workspaceKey: cwd },
          // Mode changes restart the session (supportsRuntimeModeSwitchInSession: false), so
          // the mode is set once here and zcode enforces it natively for the session's life.
          mode: zcodeSessionMode(threadInput.runtimePolicy?.runtimeMode),
          titleGenerationEnabled: false,
          ...(mcpServers === undefined ? {} : { mcpServers }),
        };
        // The model rides on session/send instead: pinning it at create breaks whenever the
        // CLI's registry lacks the model, while the send-time selection resolves per turn and
        // carries the reasoning level the CLI requires.
        const result = yield* request("session/create", createParams, SESSION_CREATE_TIMEOUT_MS);
        const resultRecord = Predicate.isObject(result) ? result : {};
        const sessionRecord = zcodeRecordField(resultRecord, "session");
        const nativeSessionId = zcodeRecordString(sessionRecord ?? {}, "sessionId");
        if (nativeSessionId === undefined) {
          return yield* protocolError("session/create returned no sessionId", result);
        }
        availableModels = parseZcodeAvailableModels(
          zcodeRecordField(
            zcodeRecordField(
              Predicate.isObject(resultRecord["settings"]) ? resultRecord["settings"] : {},
              "model",
            ),
            "available",
          ),
        );
        yield* subscribeSession(nativeSessionId);
        return nativeSessionId;
      });

      const resumeNativeSession = Effect.fnUntraced(function* (
        nativeSessionId: string,
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        const mcpServers = zcodeMcpServers(yield* mcpSessions.read(threadInput.threadId));
        yield* request(
          "session/resume",
          {
            sessionId: nativeSessionId,
            workspace: { workspacePath: cwd, workspaceKey: cwd },
            ...(mcpServers === undefined ? {} : { mcpServers }),
          },
          SESSION_CREATE_TIMEOUT_MS,
        );
        yield* subscribeSession(nativeSessionId);
        return nativeSessionId;
      });

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (threadState !== null && threadState.activeTurn !== null) {
          return yield* protocolError("Cannot switch ZCode threads while a turn is active");
        }
        const existing = threadInput.existingProviderThread;
        if (
          threadState !== null &&
          existing !== undefined &&
          threadState.providerThread.id === existing.id
        ) {
          return threadState.providerThread;
        }
        const nativeId = existing?.nativeThreadRef?.nativeId ?? threadState?.nativeSessionId;
        const nativeSessionId =
          nativeId !== undefined
            ? yield* resumeNativeSession(nativeId, threadInput)
            : yield* createNativeSession(threadInput);
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeSessionId),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: ZCODE_PROVIDER,
                  nativeThreadId: nativeSessionId,
                }),
                driver: ZCODE_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeSessionId),
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
        threadState = { providerThread, nativeSessionId, activeTurn: null };
        yield* emit({
          type: "provider_thread.updated",
          driver: ZCODE_PROVIDER,
          providerThread,
        });
        return providerThread;
      });

      const resolveTurnPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ProviderAdapter.ProviderAdapterV2TurnMessage["attachments"],
      ) {
        return yield* providerMessageTextWithAttachmentPaths({
          text,
          attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        });
      });

      const installTurn = Effect.fnUntraced(function* (
        state: ZcodeThreadState,
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        nativeTurnId: string,
      ): Effect.fn.Return<ActiveZcodeTurn, ProviderAdapter.ProviderAdapterProtocolError> {
        if (
          threadState !== state ||
          state.activeTurn !== null ||
          transportDown ||
          state.providerThread.nativeThreadRef?.nativeId !==
            turnInput.providerThread.nativeThreadRef?.nativeId
        ) {
          return yield* protocolError("ZCode turn ownership changed before it could start");
        }
        const startedAt = yield* DateTime.now;
        return {
          turnInput,
          providerTurn: {
            id: idAllocator.derive.providerTurn({
              driver: ZCODE_PROVIDER,
              nativeTurnId,
            }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: providerRef(nativeTurnId, "weak"),
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          },
          itemOrdinals: new Map(),
          nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          streamItems: new Map(),
          tools: new Map(),
          upsertedItemId: null,
          interrupted: false,
          failure: null,
          finalized: false,
        } satisfies ActiveZcodeTurn;
      });

      const beginTurnWork = Effect.fnUntraced(function* (
        state: ZcodeThreadState,
        turn: ActiveZcodeTurn,
      ) {
        state.providerThread = turn.turnInput.providerThread;
        state.activeTurn = turn;
        yield* emit({
          type: "provider_turn.updated",
          driver: ZCODE_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateProviderThread(state, {
          status: "active",
          firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turn.turnInput.runOrdinal,
          lastRunOrdinal: turn.turnInput.runOrdinal,
        });
        yield* updateProviderSession("running", null);
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: ZCODE_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        // session/resume after a host restart is unverified against a logged-in CLI; until it
        // is, restarts keep the conversation alive rather than attempting a lossy restore.
        canResumeAfterRestart: false,
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: ZCODE_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: ZCODE_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: Effect.fn("ZcodeAdapter.startTurn")(
          function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("ZCode session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ZCODE_PROVIDER,
                detail: `ZCode provider thread ${turnInput.providerThread.id} already has an active turn`,
                reason: "previous_turn_active",
              });
            }
            if (
              state.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
            ) {
              return yield* protocolError("ZCode turn requested for a different native session");
            }
            const content = yield* resolveTurnPayload(
              turnInput.message.text,
              turnInput.message.attachments,
            );
            const nativeTurnId = `${state.nativeSessionId}:attempt:${turnInput.attemptId}`;
            const sendParams: ZcodeRecord = {
              sessionId: state.nativeSessionId,
              content,
            };
            const modelSelection = zcodeModelSelectionFromSlug(turnInput.modelSelection.model);
            if (modelSelection !== undefined) {
              // The registry requires a reasoning level whenever the model advertises one; the
              // CLI's own default fills the gap for T3 selections that carry none.
              const advertised = availableModels.find(
                (entry) =>
                  entry.providerId === modelSelection.providerId &&
                  entry.modelId === modelSelection.modelId,
              );
              const reasoningLevel =
                modelSelection.options?.reasoningLevel ?? advertised?.defaultReasoningLevel;
              sendParams["modelSelection"] = {
                ...modelSelection,
                ...(reasoningLevel === undefined ? {} : { options: { reasoningLevel } }),
              };
            }
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                const turn = yield* installTurn(state, turnInput, nativeTurnId);
                yield* beginTurnWork(state, turn);
                yield* request("session/send", sendParams).pipe(
                  Effect.tapError(() =>
                    Effect.sync(() => {
                      if (state.activeTurn === turn) state.activeTurn = null;
                    }),
                  ),
                );
              }),
            );
            // session/send acks before turn events; rejections surface via turn.failed.
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: ZCODE_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        compactThread: Effect.fn("ZcodeAdapter.compactThread")(
          function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("ZCode session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ZCODE_PROVIDER,
                detail: `ZCode provider thread ${turnInput.providerThread.id} already has an active turn`,
                reason: "previous_turn_active",
              });
            }
            const nativeTurnId = `${state.nativeSessionId}:compact:${turnInput.attemptId}`;
            const instructions =
              turnInput.message.text.trim() === "/compact" ||
              turnInput.message.text.trim().length === 0
                ? undefined
                : turnInput.message.text;
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                const turn = yield* installTurn(state, turnInput, nativeTurnId);
                yield* beginTurnWork(state, turn);
                const result = yield* request(
                  "session/compact",
                  {
                    sessionId: state.nativeSessionId,
                    ...(instructions === undefined ? {} : { instructions }),
                  },
                  SESSION_CREATE_TIMEOUT_MS,
                ).pipe(
                  Effect.mapError((cause) => {
                    turn.failure = makeProviderFailure({
                      cause,
                      message: "ZCode context compaction failed.",
                      class: "provider_error",
                    });
                    return cause;
                  }),
                );
                const resultRecord = Predicate.isObject(result) ? result : {};
                const summary = zcodeRecordString(resultRecord, "response");
                const compactState = zcodeRecordString(
                  zcodeRecordField(resultRecord, "compact") ?? {},
                  "state",
                );
                if (compactState === "already_running") {
                  turn.failure = makeProviderFailure({
                    message: "ZCode is already compacting this thread.",
                    class: "provider_error",
                    retryable: true,
                  });
                }
                const emittedAt = yield* DateTime.now;
                const compactionItemId = `compaction:${turn.providerTurn.id}`;
                const failed = turn.failure !== null;
                yield* emitItemNode(
                  turn,
                  compactionItemId,
                  "system",
                  failed ? "failed" : "completed",
                  turn.providerTurn.startedAt ?? emittedAt,
                  emittedAt,
                );
                yield* emit({
                  type: "turn_item.updated",
                  driver: ZCODE_PROVIDER,
                  turnItem: {
                    ...baseItemFields(
                      turn,
                      compactionItemId,
                      turn.providerTurn.startedAt ?? emittedAt,
                      emittedAt,
                    ),
                    status: failed ? "failed" : "completed",
                    title: failed ? "Context compaction failed" : "Context compacted",
                    completedAt: emittedAt,
                    type: "compaction",
                    driver: ZCODE_PROVIDER,
                    ...(failed || summary === undefined ? {} : { summary }),
                  },
                });
                yield* finalizeTurn(state);
              }),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: ZCODE_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("ZcodeAdapter.steerTurn")(
          function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            if (
              state === null ||
              turn === null ||
              turn.providerTurn.id !== steerInput.providerTurnId
            ) {
              return yield* protocolError(`ZCode turn ${steerInput.providerTurnId} is not active`);
            }
            const content = yield* resolveTurnPayload(
              steerInput.message.text,
              steerInput.message.attachments,
            );
            // zcode queues steering natively; turn.steerQueued/drain events follow.
            yield* request("session/send", { sessionId: state.nativeSessionId, content });
          },
          (effect, steerInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: ZCODE_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("ZcodeAdapter.interruptTurn")(
          function* (interruptInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            if (
              state === null ||
              turn === null ||
              turn.providerTurn.id !== interruptInput.providerTurnId
            ) {
              return yield* protocolError(
                `ZCode turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            yield* request("session/stop", { sessionId: state.nativeSessionId });
          },
          (effect, interruptInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: ZCODE_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("ZcodeAdapter.respondToRuntimeRequest")(
          function* (requestInput: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) {
            const key = String(requestInput.requestId);
            const approval = pendingApprovals.get(key);
            const question = pendingQuestions.get(key);
            if (approval === undefined && question === undefined) {
              return yield* protocolError(
                `No pending ZCode runtime request ${requestInput.requestId}`,
              );
            }
            if (approval !== undefined) {
              const decision: ProviderApprovalDecision =
                requestInput.decision ??
                (requestInput.feedback !== undefined ? "decline" : "cancel");
              const response = zcodeApprovalResponseForDecision(approval.options, decision) ?? {
                decision: "deny",
                reason: requestInput.feedback ?? "Denied in T3 Code",
              };
              approval.chosenResponse = response;
              pendingApprovals.delete(key);
              answeredPermissions.set(approval.nativeRequestId, response);
              for (const [respondId, awaiting] of awaitingPermissionRequests) {
                if (awaiting.nativeRequestId === approval.nativeRequestId) {
                  awaitingPermissionRequests.delete(respondId);
                  yield* connection.respond(respondId, response);
                }
              }
              yield* resolveRuntimeRequestRecords(approval, yield* DateTime.now);
              return;
            }
            const pendingQuestion = question!;
            const answerValue = requestInput.answers?.[pendingQuestion.questionId];
            pendingQuestion.answer =
              requestInput.decision === "cancel" || typeof answerValue !== "string"
                ? { cancelled: true }
                : { value: answerValue };
            pendingQuestions.delete(key);
            answeredUserInputs.set(pendingQuestion.nativeRequestId, pendingQuestion.answer);
            for (const [respondId, awaiting] of awaitingUserInputRequests) {
              if (awaiting.nativeRequestId === pendingQuestion.nativeRequestId) {
                awaitingUserInputRequests.delete(respondId);
                yield* connection.respond(respondId, pendingQuestion.answer);
              }
            }
            yield* resolveRuntimeRequestRecords(pendingQuestion, yield* DateTime.now);
          },
          (effect, requestInput) =>
            effect.pipe(
              sessionEventPermit.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: ZCODE_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("ZcodeAdapter.readThreadSnapshot")(
          function* (snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput) {
            const state = threadState;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (
              state === null ||
              wantedNativeId == null ||
              state.nativeSessionId !== wantedNativeId
            ) {
              return yield* protocolError(
                "ZCode snapshot requested for a thread this session does not host",
              );
            }
            const result = yield* request("session/read", { sessionId: state.nativeSessionId });
            const resultRecord = Predicate.isObject(result) ? result : {};
            const messagesRaw = zcodeRecordArray(resultRecord, "messages") ?? [];
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = messagesRaw.flatMap(
              (entry: unknown, index: number): Array<OrchestrationV2ConversationMessage> => {
                const record = Predicate.isObject(entry) ? entry : {};
                const info = zcodeRecordField(record, "info");
                const role = zcodeRecordString(info ?? {}, "role");
                if (
                  (role !== "user" && role !== "assistant") ||
                  info === undefined ||
                  !Predicate.isObject(info)
                ) {
                  return [];
                }
                const parts = zcodeRecordArray(record, "parts") ?? [];
                const text = parts
                  .filter((part) => zcodeRecordString(part ?? {}, "type") === "text")
                  .map((part) => zcodeRecordString(part, "text") ?? "")
                  .join("");
                if (text.length === 0) return [];
                const createdMs = zcodeRecordNumber(
                  zcodeRecordField(info, "time") ?? {},
                  "created",
                );
                const at =
                  createdMs !== undefined
                    ? Option.getOrElse(
                        DateTime.make(createdMs),
                        () => state.providerThread.createdAt,
                      )
                    : state.providerThread.createdAt;
                return [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: ZCODE_PROVIDER,
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                    }),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: role === "user" ? ("user" as const) : ("assistant" as const),
                    text,
                    attachments: [],
                    streaming: false,
                    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                    creationSource: "provider" as const,
                    createdAt: at,
                    updatedAt: at,
                  },
                ];
              },
            );
            return {
              providerThread: state.providerThread,
              providerTurns: [],
              messages,
              runtimeRequests: [],
            };
          },
          (effect, snapshotInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: ZCODE_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: (_rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: ZCODE_PROVIDER,
              detail: "ZCode has no rollback method",
            }),
          ),
        forkThread: (_forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: ZCODE_PROVIDER,
              detail:
                "ZCode session/fork exists, but its thread-handoff mapping into T3 is not implemented",
            }),
          ),
      };
      return runtime;
    }),
  });
});

export type ZcodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const ZcodeAdapterV2Driver: ProviderAdapterDriver<ZcodeSettings, ZcodeAdapterV2DriverEnv> = {
  driverKind: ZCODE_PROVIDER,
  configSchema: ZcodeSettings,
  defaultConfig: (): ZcodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: Effect.fn("ZcodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ZcodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const httpClient = yield* HttpClient.HttpClient;
      return yield* makeZcodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ZCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create ZCode adapter.",
              cause,
            }),
        ),
      ),
  ),
};
