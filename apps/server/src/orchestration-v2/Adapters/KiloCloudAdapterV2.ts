import {
  ProviderDriverKind,
  RuntimeRequestId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ExecutionNode,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Cloud from "../../provider/kilo/KiloCloudWebClient.ts";
import { KiloCloudError } from "../../provider/kilo/KiloCloudError.ts";
import * as Journal from "../../provider/kilo/KiloCloudJournal.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Adapter from "../ProviderAdapter.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { openCodePermissionRules } from "./OpenCodeAdapterV2.ts";
import { openCodeToolTurnItem } from "./OpenCodeToolItems.ts";
import { kiloInteraction, kiloPermissionReply, kiloQuestionAnswers } from "./KiloAdapterV2.ts";

export const KILO_CLOUD_PROVIDER = ProviderDriverKind.make("kilo-cloud");
const capabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: true,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
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
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
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
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
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
  runtimePolicy: { enforcement: "client-boundary" },
};

const error = (detail: string) =>
  new Adapter.ProviderAdapterProtocolError({ driver: KILO_CLOUD_PROVIDER, detail });
const nativeRef = (nativeId: string) => ({
  driver: KILO_CLOUD_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
const wire = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new Adapter.ProviderAdapterProtocolError({
          driver: KILO_CLOUD_PROVIDER,
          detail: "Kilo Cloud request failed. Remote execution and billing may still be active.",
          cause,
        }),
    ),
  );
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isCloudError = Schema.is(KiloCloudError);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isJournalError = Schema.is(Journal.CloudJournalError);
const isJournalConflict = (cause: unknown) =>
  isRecord(cause) && isJournalError(cause.cause) && cause.cause.reason === "conflict";

export const make = Effect.fn("KiloCloudAdapterV2.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly continuationKey: string;
  readonly accountId: string;
  readonly repository: string;
  readonly branch: string;
  readonly client: ReturnType<typeof Cloud.make>;
  readonly journal: Effect.Success<ReturnType<typeof Journal.make>>;
  readonly allowAdmission?: boolean;
  /** Bounded local retrieval window, persisted from first remote completion. */
  readonly resultRecoveryTimeoutMs?: number;
}) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const crypto = yield* Crypto.Crypto;
  const driver = KILO_CLOUD_PROVIDER;
  const key = (id: string) => `${options.continuationKey}:${id}`;
  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("KiloCloudAdapterV2.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const gate = yield* Semaphore.make(1);
      const now = yield* DateTime.now;
      const session = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        cwd: `kilo-cloud://${options.repository}`,
        model: input.modelSelection.model,
        status: "ready" as const,
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const queue = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event, Cause.Done>();
      const wake = yield* Queue.sliding<void>(1);
      const nodes = new Map<string, OrchestrationV2ExecutionNode>();
      const items = new Map<string, OrchestrationV2TurnItem>();
      const emit = (event: Adapter.ProviderAdapterV2Event) =>
        Effect.suspend(() => {
          if (event.type === "node.updated") nodes.set(event.node.id, event.node);
          if (event.type === "turn_item.updated") items.set(event.turnItem.id, event.turnItem);
          return Queue.offer(queue, event).pipe(Effect.asVoid);
        });
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: Journal.CloudIntent | undefined;
      let needsHistoryRestore = false;
      let binding: Cloud.CloudBinding | undefined;
      let watching = false;
      let streamWatching = false;
      let streamFiber: Fiber.Fiber<void> | undefined;
      let admissionStoragePaused = false;
      // Ephemeral proof is never reconstructed from an uncertain persisted row.
      let rejectedOperationKey: string | undefined;
      let admissionFailures = 0;
      let admissionProbeAt = 0;
      let admissionProbeDelay = 2_000;
      let streamCursor = 0;
      let monitorSandbox = false;
      let resultStatus: Journal.CloudIntent["resultStatus"];
      let taskState:
        | "not_started"
        | "admission_unknown"
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "interrupted"
        | "unknown" = "not_started";
      let lifecycleSignature = "";
      let terminalSignal = yield* Deferred.make<void>();
      const messages = new Map<string, OrchestrationV2ConversationMessage>();
      const signatures = new Map<string, string>();
      const requests = new Map<
        RuntimeRequestId,
        {
          runtime: OrchestrationV2RuntimeRequest;
          native: Cloud.CloudInteraction;
          node: OrchestrationV2ExecutionNode;
          item: OrchestrationV2TurnItem;
        }
      >();
      const ordinals = new Map<string, number>();
      const ordinal = (id: string) => {
        const old = ordinals.get(id);
        if (old !== undefined) return old;
        const next = ordinals.size + 1;
        ordinals.set(id, next);
        return next;
      };
      const status = (detail: string) =>
        Effect.gen(function* () {
          yield* emit({
            type: "provider_session.updated",
            driver,
            providerSession: {
              ...session,
              status: "waiting",
              lastError: detail,
              updatedAt: yield* DateTime.now,
            },
          });
        });
      const owned = (candidate: OrchestrationV2ProviderThread) =>
        candidate.id === thread?.id &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.nativeMetadata?.continuationKey === options.continuationKey
          ? Effect.void
          : Effect.fail(error("This cloud thread belongs to a different account or repository."));
      const save = (intent: Journal.CloudIntent) =>
        wire(options.journal.save(intent)).pipe(
          Effect.tap((saved) =>
            Effect.sync(() => {
              active = saved;
            }),
          ),
        );
      const resolveRequest = Effect.fn("KiloCloudAdapterV2.resolveRequest")(function* (
        entry: NonNullable<ReturnType<typeof requests.get>>,
        cancelled = false,
      ) {
        const at = yield* DateTime.now;
        entry.runtime = {
          ...entry.runtime,
          status: cancelled ? "cancelled" : "resolved",
          resolvedAt: at,
        };
        const status = cancelled ? ("interrupted" as const) : ("completed" as const);
        entry.node = { ...entry.node, status, completedAt: at };
        entry.item = { ...entry.item, status, completedAt: at, updatedAt: at };
        yield* emit({ type: "runtime_request.updated", driver, runtimeRequest: entry.runtime });
        yield* emit({ type: "node.updated", driver, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver, turnItem: entry.item });
      });
      yield* Effect.addFinalizer(() =>
        active ? options.client.forgetAdmission(options.repository, active.messageId) : Effect.void,
      );
      const hasBackgroundWork = () =>
        (!!active && !active.admissionRecoveryPaused && !admissionStoragePaused) ||
        needsHistoryRestore ||
        monitorSandbox;
      const finish = Effect.fn("KiloCloudAdapterV2.finish")(function* (
        terminal: "completed" | "failed" | "interrupted",
        resultFailure?: string,
      ) {
        if (!active) return;
        const at = yield* DateTime.now;
        const notSubmitted = active.submissionPhase === "preflight";
        const rejected = active.submissionRejected === true;
        const saved = {
          ...active,
          state: terminal,
          providerTurn: {
            ...active.providerTurn,
            status: terminal,
            completedAt: active.providerTurn.completedAt ?? at,
          },
        };
        // A terminal record adopted from another observer is already durable.
        if (active.state !== terminal || active.providerTurn.status !== terminal)
          yield* save(saved);
        taskState = notSubmitted || rejected ? "not_started" : (saved.remoteState ?? terminal);
        yield* options.client.forgetAdmission(options.repository, saved.messageId);
        if (thread?.nativeMetadata?.cloudExecution) {
          thread = {
            ...thread,
            status: "idle",
            nativeMetadata: {
              ...thread.nativeMetadata,
              cloudExecution: {
                ...thread.nativeMetadata.cloudExecution,
                task: taskState,
                ...(saved.resultStatus ? { result: saved.resultStatus } : {}),
              },
            },
          };
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        }
        yield* emit({ type: "provider_turn.updated", driver, providerTurn: saved.providerTurn });
        for (const request of requests.values()) {
          if (request.runtime.status !== "pending") continue;
          yield* resolveRequest(request, true);
        }
        for (const node of nodes.values()) {
          if (
            node.providerTurnId === saved.providerTurn.id &&
            ["running", "waiting"].includes(node.status)
          )
            yield* emit({
              type: "node.updated",
              driver,
              node: { ...node, status: terminal, completedAt: at },
            });
        }
        for (const item of items.values()) {
          if (
            item.providerTurnId !== saved.providerTurn.id ||
            !["running", "waiting"].includes(item.status)
          )
            continue;
          const done = { ...item, status: terminal, completedAt: at, updatedAt: at };
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: "streaming" in done ? { ...done, streaming: false } : done,
          });
        }
        for (const [id, message] of messages) {
          if (!message.streaming) continue;
          const done = { ...message, streaming: false, updatedAt: at };
          messages.set(id, done);
          yield* emit({ type: "message.updated", driver, message: done });
        }
        yield* emit(
          terminal === "failed"
            ? {
                type: "turn.terminal",
                driver,
                providerThreadId: saved.providerThread.id,
                providerTurnId: saved.providerTurn.id,
                runOrdinal: saved.runOrdinal,
                failureItemOrdinal: ordinals.size + 1,
                status: "failed",
                failure: makeProviderFailure({
                  class: "provider_error",
                  code: notSubmitted
                    ? "kilo_cloud_not_submitted"
                    : rejected
                      ? "kilo_cloud_submission_rejected"
                      : resultFailure
                        ? "kilo_cloud_result_unavailable"
                        : "provider_error",
                  ...(resultFailure ? { retryable: false } : {}),
                  message: notSubmitted
                    ? "The request ended before submission. No paid request was sent; you can try a new turn."
                    : rejected
                      ? "Kilo Cloud rejected the submission. The request was sent, but no task was accepted. You can try a new turn."
                      : (resultFailure ?? "Kilo Cloud reported a failed task."),
                }),
                threadDisposition: "reusable",
              }
            : {
                type: "turn.terminal",
                driver,
                providerThreadId: saved.providerThread.id,
                providerTurnId: saved.providerTurn.id,
                runOrdinal: saved.runOrdinal,
                status: terminal,
                failure: null,
                threadDisposition: "reusable",
              },
        );
        yield* emit({
          type: "provider_session.updated",
          driver,
          providerSession: { ...session, status: "ready", updatedAt: at, lastError: null },
        });
        active = undefined;
        admissionStoragePaused = false;
        admissionFailures = 0;
        rejectedOperationKey = undefined;
        // Terminal task state must not pin a history retry forever. Reopening
        // the thread can retry history independently of the ended turn.
        needsHistoryRestore = false;
        if (!binding) monitorSandbox = false;
        resultStatus = saved.resultStatus;
        yield* Deferred.succeed(terminalSignal, undefined);
      });
      const project = Effect.fn("KiloCloudAdapterV2.project")(function* (
        message: Cloud.CloudMessage,
        intents: ReadonlyArray<Journal.CloudIntent>,
      ) {
        if (!thread?.appThreadId) return;
        const correlationId =
          message.info.role === "user" ? message.info.id : message.info.parentID;
        const intent = intents.find((entry) => entry.messageId === correlationId);
        if (!intent) return; // No unrelated native conversation or child events enter this T3 thread.
        const correlation =
          intent.providerThread.nativeMetadata?.turnCorrelations?.[intent.messageId];
        if (!correlation) return;
        const terminal = ["completed", "failed", "interrupted"].includes(intent.state);
        const signature = encode([message, intent.state]);
        if (signatures.get(message.info.id) === signature) return;
        const at = yield* DateTime.now;
        const done =
          terminal || message.info.role === "user" || message.info.time.completed !== undefined;
        const text = message.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        const row: OrchestrationV2ConversationMessage = {
          id:
            message.info.role === "user"
              ? correlation.messageId
              : ids.derive.messageFromProviderItem({ driver, nativeItemId: key(message.info.id) }),
          threadId: thread.appThreadId,
          runId: correlation.runId,
          nodeId: correlation.nodeId,
          role: message.info.role,
          text,
          attachments: [],
          streaming: !done,
          createdAt: DateTime.makeUnsafe(message.info.time.created),
          updatedAt: at,
          createdBy: message.info.role === "user" ? (correlation.createdBy ?? "user") : "agent",
          creationSource:
            message.info.role === "user" ? (correlation.creationSource ?? "provider") : "provider",
        };
        messages.set(message.info.id, row);
        yield* emit({ type: "message.updated", driver, message: row });
        if (message.info.role !== "assistant") {
          signatures.set(message.info.id, signature);
          return;
        }
        for (const part of message.parts) {
          if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool") continue;
          const nodeId = ids.derive.nodeFromProviderItem({ driver, nativeItemId: key(part.id) });
          const toolStatus = part.state?.status;
          const nativeDone =
            part.type === "tool"
              ? toolStatus === "completed" || toolStatus === "error"
              : message.info.time.completed !== undefined;
          const partDone = nativeDone || terminal;
          const partStatus =
            toolStatus === "error"
              ? "failed"
              : nativeDone
                ? "completed"
                : terminal
                  ? intent.state
                  : "running";
          const base = {
            id: ids.derive.turnItemFromProviderItem({ driver, nativeItemId: key(part.id) }),
            threadId: thread.appThreadId,
            runId: correlation.runId,
            nodeId,
            providerThreadId: thread.id,
            providerTurnId: intent.providerTurn.id,
            nativeItemRef: nativeRef(part.id),
            parentItemId: null,
            ordinal: ordinal(part.id),
            status: partStatus as "completed" | "failed" | "interrupted" | "running",
            title: part.tool ?? null,
            startedAt: intent.providerTurn.startedAt,
            completedAt: partDone ? at : null,
            updatedAt: at,
          };
          yield* emit({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: thread.appThreadId,
              runId: correlation.runId,
              parentNodeId: correlation.nodeId,
              rootNodeId: correlation.nodeId,
              kind:
                part.type === "tool"
                  ? "tool_call"
                  : part.type === "reasoning"
                    ? "reasoning"
                    : "assistant_message",
              status: base.status,
              countsForRun: false,
              providerThreadId: thread.id,
              providerTurnId: intent.providerTurn.id,
              nativeItemRef: base.nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: base.startedAt,
              completedAt: base.completedAt,
            },
          });
          const item: OrchestrationV2TurnItem =
            part.type === "tool"
              ? openCodeToolTurnItem(base, {
                  name: part.tool ?? "unknown",
                  input: isRecord(part.state?.input) ? part.state.input : {},
                  output:
                    typeof part.state?.output === "string"
                      ? part.state.output
                      : typeof part.state?.error === "string"
                        ? part.state.error
                        : undefined,
                  completedMetadata: toolStatus === "completed" ? part.state?.metadata : undefined,
                })
              : part.type === "reasoning"
                ? { ...base, type: "reasoning", text: part.text ?? "", streaming: !done }
                : {
                    ...base,
                    type: "assistant_message",
                    messageId: row.id,
                    text: part.text ?? "",
                    streaming: !done,
                  };
          yield* emit({ type: "turn_item.updated", driver, turnItem: item });
        }
        signatures.set(message.info.id, signature);
      });
      const ask = Effect.fn("KiloCloudAdapterV2.ask")(function* (native: Cloud.CloudInteraction) {
        const intent = active;
        const correlation =
          intent?.providerThread.nativeMetadata?.turnCorrelations?.[intent.messageId];
        const requestId = RuntimeRequestId.make(key(native.id));
        if (!intent || !correlation || !thread?.appThreadId || requests.has(requestId)) return;
        const interaction = kiloInteraction({
          native,
          requestId,
          nodeId: ids.derive.approvalNode({ requestId }),
          turnItemId: ids.derive.approvalTurnItem({ requestId }),
          nativeRef: nativeRef(native.id),
          threadId: thread.appThreadId,
          runId: correlation.runId,
          rootNodeId: correlation.nodeId,
          providerThreadId: thread.id,
          providerTurnId: intent.providerTurn.id,
          providerSessionId: input.providerSessionId,
          ordinal: ordinal(native.id),
          at: yield* DateTime.now,
        });
        requests.set(requestId, {
          runtime: interaction.runtime,
          native,
          node: interaction.node,
          item: interaction.turnItem,
        });
        yield* emit({ type: "node.updated", driver, node: interaction.node });
        yield* emit({
          type: "runtime_request.updated",
          driver,
          threadId: thread.appThreadId,
          runtimeRequest: interaction.runtime,
        });
        yield* emit({ type: "turn_item.updated", driver, turnItem: interaction.turnItem });
      });
      const refreshIntent = Effect.gen(function* () {
        if (!active) return;
        const latest = (yield* wire(options.journal.readThread(thread!.id))).find(
          (entry) => entry.operationKey === active!.operationKey,
        );
        if (latest && latest.revision > active.revision) {
          active = latest;
          if (latest.binding) {
            binding = latest.binding;
            monitorSandbox = true;
          }
        }
      });
      const finishKnownOutcome = Effect.gen(function* () {
        if (!active) return false;
        const terminal = active.state;
        if (terminal === "completed" || terminal === "failed" || terminal === "interrupted") {
          yield* finish(
            terminal,
            active.remoteState === "completed" && terminal === "failed"
              ? "Kilo Cloud completed remotely, but its result was unavailable before the recovery deadline."
              : undefined,
          ).pipe(Effect.uninterruptible);
          return true;
        }
        if (rejectedOperationKey === active.operationKey) {
          // Newer durable acceptance/terminal state outranks an older local outcome.
          if (active.state === "admission_unknown" && !active.prepared && !active.remoteState)
            active = { ...active, submissionRejected: true };
          else rejectedOperationKey = undefined;
        }
        if (active.submissionPhase === "preflight" || active.submissionRejected) {
          yield* finish("failed").pipe(Effect.uninterruptible);
          return true;
        }
        return false;
      });
      // Retry local persistence only. Never repeat a paid customer request.
      const settleKnownOutcome = Effect.gen(function* () {
        yield* refreshIntent;
        return yield* finishKnownOutcome;
      }).pipe(
        Effect.retry({ times: 1 }),
        Effect.timeout("8 seconds"),
        // The timeout can lose a race to an uninterruptible terminal commit.
        Effect.catch((cause) => (!active ? Effect.succeed(true) : Effect.fail(cause))),
      );
      const resumeLocalStorage = Effect.gen(function* () {
        yield* refreshIntent;
        if (yield* finishKnownOutcome) return true;
        if (active) yield* save(active);
        admissionStoragePaused = false;
        admissionFailures = 0;
        admissionProbeAt = 0;
        return false;
      }).pipe(
        Effect.retry({ times: 1 }),
        Effect.timeout("8 seconds"),
        Effect.catch((cause) => (!active ? Effect.succeed(true) : Effect.fail(cause))),
      );
      const recoverAdmission = Effect.gen(function* () {
        yield* refreshIntent;
        if (!active || (yield* finishKnownOutcome)) return;
        if (active.admissionRecoveryPaused || admissionStoragePaused || binding) return;
        const now = yield* Clock.currentTimeMillis;
        if (now < admissionProbeAt) return;
        admissionProbeAt = now + admissionProbeDelay;
        admissionProbeDelay = Math.min(admissionProbeDelay * 2, 60_000);
        if (!active.prepared) {
          const found = yield* options.client.findAdmission(options.repository, active.messageId);
          if (found) yield* save({ ...active, prepared: found });
        }
        if (active?.prepared) {
          const recovered = yield* options.client.bind(
            active.prepared,
            options.repository,
            active.messageId,
            options.branch,
          );
          yield* save({
            ...active,
            binding: recovered,
            state: "active",
            admissionRecoveryFailures: 0,
          });
          binding = recovered;
          monitorSandbox = true;
          yield* options.client.forgetAdmission(options.repository, active!.messageId);
        } else if (active?.admissionRecoveryFailures) {
          yield* save({ ...active, admissionRecoveryFailures: 0 });
        }
        admissionFailures = 0;
      }).pipe(
        Effect.timeout("8 seconds"),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            // Another adapter may have won the CAS. Adopt its progress before
            // accounting this failure; never overwrite it with our stale record.
            if (!active || binding) return;
            admissionFailures =
              Math.max(admissionFailures, active.admissionRecoveryFailures ?? 0) + 1;
            let paused =
              admissionFailures >= 3 ||
              (isCloudError(cause) &&
                ["recovery_incomplete", "recovery_limit", "wrong_owner"].includes(cause.reason));
            // Count and pause locally before further I/O: an unavailable journal
            // must not let the outer reconciliation timeout erase all progress.
            const storageWasPaused = admissionStoragePaused;
            if (paused) {
              admissionStoragePaused = true;
              monitorSandbox = false;
            }
            yield* refreshIntent.pipe(Effect.timeout("500 millis"), Effect.ignore);
            if (!active || binding) {
              admissionStoragePaused = false;
              admissionFailures = 0;
              return;
            }
            // A concurrent observer may have already exhausted its scan budget.
            // Only an explicit resume can clear that newer durable pause.
            admissionFailures = Math.max(admissionFailures, active.admissionRecoveryFailures ?? 0);
            paused ||= active.admissionRecoveryPaused === true || admissionFailures >= 3;
            let conflicted = false;
            yield* save({
              ...active,
              admissionRecoveryFailures: admissionFailures,
              admissionRecoveryPaused: paused,
            }).pipe(
              Effect.timeout("500 millis"),
              Effect.tap(() =>
                Effect.sync(() => {
                  admissionStoragePaused = false;
                }),
              ),
              Effect.catch((writeCause) =>
                Effect.gen(function* () {
                  if (isJournalConflict(writeCause)) {
                    // This probe lost to another observer. Adopt its pause/resume
                    // instead of reapplying counters computed before its write.
                    yield* refreshIntent.pipe(Effect.timeout("500 millis"));
                    conflicted = true;
                    admissionFailures = active?.admissionRecoveryFailures ?? 0;
                    paused = active?.admissionRecoveryPaused === true;
                    admissionStoragePaused = storageWasPaused;
                  } else if (paused) admissionStoragePaused = true;
                }).pipe(
                  Effect.catch(() =>
                    Effect.sync(() => {
                      admissionStoragePaused = true;
                      paused = true;
                      conflicted = false;
                    }),
                  ),
                ),
              ),
            );
            if (paused) {
              monitorSandbox = false;
              yield* status(
                conflicted
                  ? "Cloud recovery changed in another observer. Reopen history to retry reads; no request was resubmitted."
                  : admissionStoragePaused
                    ? "Cloud recovery is paused because its journal cannot be updated. Restore local storage and reopen history. Submission and billing remain unknown; no request was resubmitted."
                    : isCloudError(cause) && cause.reason === "recovery_limit"
                      ? "Cloud recovery reached the 100-page history limit. Reopening repeats this limit; contact support to resolve the existing operation. Submission and billing remain unknown; do not submit again."
                      : `Cloud admission recovery is incomplete and automatic scanning is paused${isCloudError(cause) ? ` (${cause.recoveryCause ?? cause.reason})` : ""}. Reopen history to retry reads. Submission and billing remain unknown; do not submit again.`,
              );
            }
          }),
        ),
      );
      const reconcile = Effect.fn("KiloCloudAdapterV2.reconcile")(function* () {
        if (!binding) yield* recoverAdmission;
        else yield* refreshIntent;
        if (yield* finishKnownOutcome) return;
        if (!binding || active?.admissionRecoveryPaused || admissionStoragePaused) return;
        const expectedMessageId = active?.messageId;
        const intents = yield* wire(options.journal.readThread(thread!.id));
        const nowMs = yield* Clock.currentTimeMillis;
        const previousRecovery = active?.resultRecovery;
        if (previousRecovery && nowMs < previousRecovery.nextAttemptMs) return;
        const outcome =
          active?.remoteState === "completed"
            ? { status: "completed" as const }
            : active
              ? yield* wire(options.client.result(binding, active.messageId))
              : null;
        if (active?.messageId !== expectedMessageId) return;
        if (outcome && active) {
          taskState = outcome.status;
          // First observed completion and its deadline are one durable write.
          if (outcome.status === "completed" && !active.resultRecovery) {
            yield* save({
              ...active,
              remoteState: "completed",
              state: "awaiting_result",
              resultStatus: "awaiting_result",
              resultRecovery: {
                deadlineMs: nowMs + (options.resultRecoveryTimeoutMs ?? 300_000),
                nextAttemptMs: nowMs,
                attempts: 0,
                cursor: null,
                seenCursors: [],
              },
            });
            resultStatus = "awaiting_result";
          } else if (active.remoteState !== outcome.status)
            yield* save({ ...active, remoteState: outcome.status });
        }
        // Reserve the next attempt before I/O, including pending/history failures.
        if (active?.resultRecovery) {
          const recovery = active.resultRecovery;
          yield* save({
            ...active,
            resultRecovery: {
              ...recovery,
              attempts: recovery.attempts + 1,
              nextAttemptMs: nowMs + Math.min(2_000 * 2 ** Math.min(recovery.attempts, 4), 30_000),
            },
          });
        }
        const failedOrInterrupted =
          outcome?.status === "failed" || outcome?.status === "interrupted";
        const expired = !!active?.resultRecovery && nowMs >= active.resultRecovery.deadlineMs;
        const pending = !failedOrInterrupted
          ? yield* options.client.pending(binding).pipe(
              Effect.timeout("3 seconds"),
              Effect.catch((cause) =>
                expired || !active ? Effect.succeed(null) : Effect.fail(cause),
              ),
              wire,
            )
          : null;
        if (pending && active) {
          for (const interaction of [...pending.questions, ...pending.permissions])
            yield* ask(interaction);
          const stillPending = new Set(
            [...pending.questions, ...pending.permissions].map((entry) => entry.id),
          );
          for (const entry of requests.values())
            if (entry.runtime.status === "pending" && !stillPending.has(entry.native.id))
              yield* resolveRequest(entry);
        }
        const hasPending = !!pending && pending.questions.length + pending.permissions.length > 0;
        if (hasPending && active?.resultRecovery) {
          // Human interaction is not a missing-result failure. Persist a fresh
          // retrieval window while the customer API confirms it is outstanding.
          yield* save({
            ...active,
            resultRecovery: {
              ...active.resultRecovery,
              deadlineMs: Math.max(
                active.resultRecovery.deadlineMs,
                nowMs + (options.resultRecoveryTimeoutMs ?? 300_000),
              ),
            },
          });
        }
        if (expired) {
          if (hasPending) {
            yield* status(
              "Kilo Cloud has an outstanding interaction. Remote completion does not resolve it.",
            );
          } else {
            yield* save({ ...active!, resultStatus: "unavailable" });
            yield* finish(
              "failed",
              "Kilo Cloud completed remotely, but its correlated result could not be retrieved before the recovery deadline. Reopen history to retrieve a late result; no task was resubmitted.",
            ).pipe(Effect.uninterruptible);
          }
          return;
        }
        // A terminal local run may still receive a late result. Explicit history
        // refresh advances the same durable cursor without restarting the run.
        let target = active ?? intents.at(-1);
        const recovery =
          target?.resultRecovery ??
          (target && !active
            ? {
                deadlineMs: nowMs,
                nextAttemptMs: nowMs,
                attempts: 0,
                cursor: null,
                seenCursors: [],
                completeReplySeen: false,
                incompleteReplySeen: false,
              }
            : undefined);
        let cursor: string | undefined = recovery?.cursor ?? undefined;
        let completeReplySeen = recovery?.completeReplySeen ?? false;
        let incompleteReplySeen = recovery?.incompleteReplySeen ?? false;
        let scanComplete = false;
        let resetScan = false;
        const seen = new Set(recovery?.seenCursors ?? []);
        const readHistory = Effect.gen(function* () {
          for (let pages = 0; pages < 4; pages++) {
            const page = yield* wire(options.client.history(binding!, cursor));
            if (page.history === null) return;
            if (page.history.omittedItemCount > 0)
              return yield* error("Kilo Cloud result history is incomplete.");
            for (const message of page.history.messages) {
              yield* project(message, intents);
              if (message.info.role !== "assistant" || message.info.parentID !== target?.messageId)
                continue;
              const complete =
                message.info.time.completed !== undefined &&
                message.parts.every(
                  (part) =>
                    part.type !== "tool" ||
                    ["completed", "error"].includes(String(part.state?.status)),
                );
              if (complete) completeReplySeen = true;
              else incompleteReplySeen = true;
            }
            cursor =
              active &&
              page.history.messages.some((message) => message.info.id === target?.messageId)
                ? undefined
                : (page.history.nextCursor ?? undefined);
            if (!cursor) {
              scanComplete = true;
              return;
            }
            if (seen.has(cursor) || seen.size >= 100) {
              resetScan = true;
              return yield* error(
                "Kilo Cloud result history exceeded its cursor budget or repeated a cursor.",
              );
            }
            seen.add(cursor);
          }
        });
        if (failedOrInterrupted) {
          yield* readHistory.pipe(Effect.timeout("5 seconds"), Effect.ignore);
          yield* finish(outcome.status as "failed" | "interrupted").pipe(Effect.uninterruptible);
          return;
        }
        if (recovery) yield* readHistory.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        else yield* readHistory;
        const available =
          scanComplete &&
          completeReplySeen &&
          !incompleteReplySeen &&
          pending !== null &&
          !hasPending;
        if (target && recovery) {
          const updated = {
            ...target,
            ...(available ? { resultStatus: "available" as const } : {}),
            resultRecovery: {
              ...recovery,
              cursor: scanComplete || resetScan ? null : (cursor ?? null),
              seenCursors: scanComplete || resetScan ? [] : [...seen],
              completeReplySeen: scanComplete || resetScan ? false : completeReplySeen,
              incompleteReplySeen: scanComplete || resetScan ? false : incompleteReplySeen,
            },
          };
          // Use the latest revision after reserving this attempt above.
          target = active
            ? yield* save({ ...updated, revision: active.revision })
            : yield* wire(options.journal.save(updated));
          if (!active) resultStatus = target.resultStatus;
        }
        if (active?.remoteState === "completed" && available) {
          yield* finish("completed").pipe(Effect.uninterruptible);
        } else if (active?.state === "awaiting_result") {
          yield* status(
            hasPending
              ? "Kilo Cloud has an outstanding interaction. Remote completion does not resolve it."
              : "Kilo Cloud completed remotely. Awaiting its correlated result; Stop cancels result retrieval only.",
          );
        }
        needsHistoryRestore = active !== undefined && !scanComplete && !!cursor;
      });
      const lifecycle = Effect.gen(function* () {
        if (!thread || !binding) return;
        const sandbox = yield* options.client.sandbox(binding).pipe(
          Effect.timeout("4 seconds"),
          Effect.orElseSucceed(() => null),
        );
        const billing = yield* options.client.billing(binding).pipe(
          Effect.timeout("4 seconds"),
          Effect.orElseSucceed(() => null),
        );
        const snapshot = {
          repository: options.repository,
          branch: options.branch,
          sessionId: binding.cloudAgentSessionId,
          worktreeId: binding.worktreeId,
          task: taskState,
          ...(resultStatus ? { result: resultStatus } : {}),
          sandbox: sandbox?.status ?? ("unknown" as const),
          billing: billing?.phase ?? ("unknown" as const),
          billingAttribution: billing?.attribution ?? null,
          estimatedHourlyRateUsd:
            billing?.estimatedHourlyRateMicrodollars == null
              ? null
              : billing.estimatedHourlyRateMicrodollars / 1_000_000,
        };
        if (!active && sandbox?.status === "sleeping" && billing?.phase === "idle")
          monitorSandbox = false;
        const signature = encode(snapshot);
        if (signature !== lifecycleSignature) {
          lifecycleSignature = signature;
          thread = {
            ...thread,
            nativeMetadata: {
              ...thread.nativeMetadata,
              cloudExecution: { ...snapshot, observedAt: DateTime.formatIso(yield* DateTime.now) },
            },
          };
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        }
      });
      const watchEvents = Effect.gen(function* () {
        if (streamWatching || !binding) return;
        streamWatching = true;
        const ownedBinding = binding;
        streamFiber = yield* Effect.gen(function* () {
          // State is changed by the reconciler while this reader observes notifications.
          while (hasBackgroundWork()) {
            yield* options.client.events(ownedBinding, streamCursor).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  streamCursor = Math.max(streamCursor, event.eventId);
                  if (
                    event.streamEventType.startsWith("cloud.message.") ||
                    (event.streamEventType === "kilocode" &&
                      [
                        "permission.asked",
                        "question.asked",
                        "session.error",
                        "session.idle",
                      ].includes(String(event.data.type)))
                  )
                    yield* Queue.offer(wake, undefined);
                }),
              ),
              Effect.catch(() =>
                status(
                  "Cloud stream disconnected. Polling continues; remote execution and billing were not stopped.",
                ),
              ),
            );
            if (hasBackgroundWork()) yield* Effect.sleep("5 seconds");
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              streamWatching = false;
            }),
          ),
          Effect.forkIn(scope),
        );
      });
      const watch: Effect.Effect<void> = Effect.gen(function* () {
        if (watching) {
          yield* Queue.offer(wake, undefined);
          return;
        }
        watching = true;
        yield* Effect.gen(function* () {
          let polls = 0;
          // Reconcile and lifecycle update this session state.
          while (hasBackgroundWork()) {
            const pollStartedAt = yield* Clock.currentTimeMillis;
            yield* watchEvents;
            if (!admissionStoragePaused && (active || needsHistoryRestore))
              yield* gate
                .withPermit(reconcile().pipe(Effect.timeout("10 seconds")))
                .pipe(
                  Effect.catch(() =>
                    status(
                      taskState === "completed"
                        ? "Cloud result retrieval is unavailable. Remote execution completed; sandbox and billing are separate. No prompt was resubmitted."
                        : "Cloud connection unavailable. Task and billing status are unknown; no prompt was resubmitted.",
                    ),
                  ),
                );
            if (binding && (polls++ % 15 === 0 || !active))
              yield* gate.withPermit(lifecycle.pipe(Effect.timeout("10 seconds"), Effect.ignore));
            if (hasBackgroundWork())
              yield* Effect.raceFirst(
                Effect.sleep(active ? "2 seconds" : "15 seconds"),
                Queue.take(wake),
              ).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    // Stream notifications may reduce idle latency, but never amplify
                    // polling beyond one reconciliation per two seconds.
                    const elapsed = (yield* Clock.currentTimeMillis) - pollStartedAt;
                    if (elapsed < 2_000) yield* Effect.sleep(2_000 - elapsed);
                  }),
                ),
              );
          }
        }).pipe(
          Effect.onExit((exit) =>
            gate.withPermit(
              Effect.gen(function* () {
                if (streamFiber) yield* Fiber.interrupt(streamFiber);
                streamFiber = undefined;
                watching = false;
                // A turn may arrive while the previous socket is closing. Starting
                // and retiring the watcher share the turn gate, so its wake is not lost.
                if (Exit.isSuccess(exit) && hasBackgroundWork()) yield* watch;
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
      });
      const policyHash = (policy: Adapter.ProviderAdapterV2RuntimePolicy) =>
        wire(
          crypto.digest(
            "SHA-256",
            new TextEncoder().encode(
              encode({
                rules: openCodePermissionRules(policy),
                interactionMode: policy.interactionMode,
              }),
            ),
          ),
        ).pipe(Effect.map(Encoding.encodeHex));
      const bind = Effect.fn("KiloCloudAdapterV2.bind")(function* (
        saved: OrchestrationV2ProviderThread,
      ) {
        if (
          saved.providerInstanceId !== options.instanceId ||
          (saved.nativeMetadata?.continuationKey &&
            saved.nativeMetadata.continuationKey !== options.continuationKey)
        )
          return yield* error("Kilo Cloud account or repository changed; start a separate thread.");
        thread = {
          ...saved,
          providerSessionId: input.providerSessionId,
          nativeMetadata: {
            ...saved.nativeMetadata,
            continuationKey: options.continuationKey,
            cloudExecution: saved.nativeMetadata?.cloudExecution ?? {
              repository: options.repository,
              branch: options.branch,
              sessionId: null,
              worktreeId: null,
              task: "not_started",
              sandbox: "unknown",
              billing: "unknown",
              billingAttribution: null,
              estimatedHourlyRateUsd: null,
              observedAt: null,
            },
          },
        };
        const entries = yield* wire(options.journal.readThread(saved.id));
        const last = entries.at(-1);
        if (
          last &&
          (last.accountId !== options.accountId ||
            last.repository !== options.repository ||
            last.branch !== options.branch)
        )
          return yield* error("Cloud journal belongs to another account or repository.");
        binding = last?.binding ?? undefined;
        taskState =
          last?.submissionPhase === "preflight" || last?.submissionRejected
            ? "not_started"
            : (last?.remoteState ??
              (last?.state === "awaiting_result"
                ? "completed"
                : last?.state === "active"
                  ? "unknown"
                  : (last?.state ?? "not_started")));
        resultStatus = last?.resultStatus;
        monitorSandbox = !!last?.binding;
        active =
          last &&
          (last.state === "active" ||
            last.state === "admission_unknown" ||
            last.state === "awaiting_result")
            ? last
            : undefined;
        if (binding) thread = { ...thread, nativeThreadRef: nativeRef(binding.kiloSessionId) };
        if (active?.submissionPhase === "preflight" || active?.submissionRejected)
          yield* finish("failed").pipe(Effect.uninterruptible);
        if (active?.admissionRecoveryPaused)
          yield* status(
            "Cloud admission recovery is paused. Reopen history to retry reads; submission and billing remain unknown.",
          );
        return thread;
      });
      const unsupported = () =>
        Effect.fail(error("This capability is unavailable for Kilo Cloud sessions."));
      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromEffectRepeat(Queue.take(queue)),
        hasPendingBackgroundWork: Effect.sync(hasBackgroundWork),
        hasPendingBackgroundWorkForThread: (candidate) =>
          Effect.sync(() => candidate.id === thread?.id && hasBackgroundWork()),
        ensureThread: (request) =>
          gate.withPermit(
            Effect.gen(function* () {
              const existing = request.existingProviderThread;
              if (!existing) return yield* error("Kilo Cloud requires a preallocated T3 thread.");
              return yield* bind(existing);
            }),
          ),
        resumeThread: (request) => gate.withPermit(bind(request.providerThread)),
        startTurn: (request) =>
          gate.withPermit(
            Effect.gen(function* () {
              yield* owned(request.providerThread);
              if (request.reattach) {
                const saved = (yield* wire(
                  options.journal.readThread(request.providerThread.id),
                )).find(
                  (entry) =>
                    entry.providerThread.id === request.providerThread.id &&
                    entry.providerTurn.runAttemptId === request.attemptId,
                );
                if (!saved)
                  return yield* error(
                    "No durable cloud intent exists for this run. No task was resubmitted.",
                  );
                active = saved;
                yield* emit({
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: saved.providerTurn,
                });
                binding = saved.binding ?? undefined;
                monitorSandbox = !!binding;
                if (
                  saved.state === "completed" ||
                  saved.state === "failed" ||
                  saved.state === "interrupted"
                ) {
                  active = undefined;
                  needsHistoryRestore = true;
                  yield* reconcile().pipe(Effect.timeout("10 seconds"), Effect.ignore);
                  active =
                    (yield* wire(options.journal.readThread(thread!.id))).find(
                      (entry) => entry.operationKey === saved.operationKey,
                    ) ?? saved;
                  yield* finish(
                    saved.state,
                    saved.remoteState === "completed" && saved.state === "failed"
                      ? "Kilo Cloud completed remotely, but its result was unavailable before the recovery deadline."
                      : undefined,
                  );
                }
                yield* watch;
                return;
              }
              if (active)
                return yield* error(
                  "A cloud task is active or its admission is unknown. Do not resubmit.",
                );
              if (options.allowAdmission === false)
                return yield* error(
                  "Paid cloud execution is disabled. Existing tasks can still be recovered and interrupted.",
                );
              const rules = openCodePermissionRules(request.runtimePolicy);
              if (
                request.runtimePolicy.runtimeMode !== "full-access" ||
                rules.some((rule) => rule.action !== "allow")
              )
                return yield* error(
                  "This Kilo Cloud runtime cannot enforce restricted permissions or disable subagents. Select Full access explicitly or use local Kilo. No paid task was submitted.",
                );
              if (request.runtimePolicy.interactionMode !== "default")
                return yield* error(
                  "Plan mode is not yet supported for Kilo Cloud. No task was submitted.",
                );
              const selectedPolicyHash = yield* policyHash(request.runtimePolicy);
              const priorIntent = (yield* wire(
                options.journal.readThread(request.providerThread.id),
              )).findLast((entry) => entry.providerThread.id === request.providerThread.id);
              if (priorIntent && priorIntent.policyHash !== selectedPolicyHash)
                return yield* error(
                  "Cloud permissions changed. Start a separate cloud thread; the remote agent retains its original permissions.",
                );
              terminalSignal = yield* Deferred.make<void>();
              if (request.message.attachments.length)
                return yield* error(
                  "Cloud attachments are not supported; no local files were uploaded.",
                );
              const operationKey = yield* wire(crypto.randomUUIDv4);
              const at = yield* DateTime.now;
              const messageId = `msg_${DateTime.toEpochMillis(at).toString(16).padStart(12, "0")}${operationKey.replaceAll("-", "").slice(0, 14)}`;
              const model = request.modelSelection.model;
              const variant = getModelSelectionStringOptionValue(request.modelSelection, "variant");
              const payload = {
                operationKey,
                initialMessageId: messageId,
                prompt: request.message.text,
                repository: options.repository,
                branch: options.branch,
                model,
                ...(variant ? { variant } : {}),
              };
              const hash = yield* wire(
                crypto.digest("SHA-256", new TextEncoder().encode(encode(payload))),
              );
              const providerThread = {
                ...request.providerThread,
                nativeMetadata: {
                  ...request.providerThread.nativeMetadata,
                  continuationKey: options.continuationKey,
                  // Older correlations remain in their durable journal intents.
                  turnCorrelations: {
                    [messageId]: {
                      messageId: request.message.messageId,
                      nodeId: request.rootNodeId,
                      runId: request.runId,
                      attemptId: request.attemptId,
                      ordinal: request.providerTurnOrdinal,
                      attachments: [],
                      createdBy: request.message.createdBy,
                      creationSource: request.message.creationSource,
                    },
                  },
                },
              };
              const intent: Journal.CloudIntent = {
                revision: 0,
                accountId: options.accountId,
                repository: options.repository,
                branch: options.branch,
                operationKey,
                messageId,
                payloadHash: Encoding.encodeHex(hash),
                policyHash: selectedPolicyHash,
                binding: binding ?? null,
                prepared: null,
                state: "admission_unknown",
                submissionPhase: "preflight",
                interruptRequested: false,
                answeredRequestIds: [],
                providerThread,
                providerTurn: {
                  id: ids.derive.providerTurn({ driver, nativeTurnId: key(messageId) }),
                  providerThreadId: providerThread.id,
                  nodeId: request.rootNodeId,
                  runAttemptId: request.attemptId,
                  nativeTurnRef: nativeRef(messageId),
                  ordinal: request.providerTurnOrdinal,
                  status: "running",
                  startedAt: at,
                  completedAt: null,
                },
                runOrdinal: request.runOrdinal,
              };
              if (!(yield* wire(options.journal.reserve(intent))))
                return yield* error("A previous cloud admission still needs reconciliation.");
              resultStatus = undefined;
              active = intent;
              admissionProbeAt = 0;
              admissionProbeDelay = 2_000;
              admissionFailures = 0;
              admissionStoragePaused = false;
              taskState = "admission_unknown";
              monitorSandbox = true;
              thread = providerThread;
              if (thread.nativeMetadata?.cloudExecution) {
                const cloudExecution = { ...thread.nativeMetadata.cloudExecution };
                delete cloudExecution.result;
                thread = {
                  ...thread,
                  nativeMetadata: {
                    ...thread.nativeMetadata,
                    cloudExecution: {
                      ...cloudExecution,
                      task: taskState,
                      sandbox: "unknown",
                      billing: "unknown",
                      billingAttribution: null,
                      estimatedHourlyRateUsd: null,
                      observedAt: null,
                    },
                  },
                };
                lifecycleSignature = "";
              }
              yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
              yield* emit({
                type: "provider_turn.updated",
                driver,
                providerTurn: intent.providerTurn,
              });
              // This write is part of the client's dispatch boundary, after its
              // credentials/preflight reads and before the paid HTTP execute.
              const beforePaidPost = Effect.suspend(() =>
                save({ ...active!, submissionPhase: "post_attempted" }).pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    () =>
                      new KiloCloudError({ operation: "submission-journal", reason: "rejected" }),
                  ),
                ),
              );
              let submissionConfirmed = false;
              yield* Effect.gen(function* () {
                if (binding)
                  yield* options.client.send(
                    binding,
                    {
                      messageId,
                      prompt: request.message.text,
                      model,
                      ...(variant ? { variant } : {}),
                    },
                    beforePaidPost,
                  );
                else {
                  const prepared = yield* options.client.prepare(payload, beforePaidPost);
                  submissionConfirmed = true;
                  yield* save({ ...active!, prepared });
                  binding = yield* options.client.bind(
                    prepared,
                    options.repository,
                    messageId,
                    options.branch,
                  );
                }
                yield* save({ ...active!, binding, state: "active" });
                thread = { ...thread!, nativeThreadRef: nativeRef(binding.kiloSessionId) };
                yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
              }).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    if (active?.submissionPhase === "preflight") {
                      yield* finish("failed").pipe(Effect.uninterruptible);
                    } else if (
                      !submissionConfirmed &&
                      isCloudError(cause) &&
                      cause.reason === "rejected"
                    ) {
                      rejectedOperationKey = active?.operationKey;
                      // Commit the rejection and terminal state together. Refresh on
                      // a CAS conflict, but never retry the paid request. If storage
                      // stays unavailable, retain the outcome only in this adapter.
                      yield* settleKnownOutcome.pipe(
                        Effect.catch((cause) =>
                          Effect.gen(function* () {
                            if (!active) return;
                            admissionStoragePaused = true;
                            if (!binding) monitorSandbox = false;
                            yield* status(
                              isJournalConflict(cause)
                                ? "Cloud rejection recovery changed concurrently. Reopen history to retry local recovery; no request was resubmitted."
                                : "Kilo Cloud rejected this request, but the outcome could not be saved. Restore local storage and reopen history. The reservation remains held; no request was resubmitted.",
                            );
                          }),
                        ),
                      );
                    } else
                      yield* status(
                        "Cloud admission is uncertain. Its operation ID is saved; no automatic retry will start another paid task.",
                      );
                  }),
                ),
              );
              yield* watch;
            }),
          ),
        interruptTurn: (request) =>
          gate
            .withPermit(
              Effect.gen(function* () {
                yield* owned(request.providerThread);
                if (!active || active.providerTurn.id !== request.providerTurnId) return false;
                if (
                  rejectedOperationKey === active.operationKey ||
                  active.submissionRejected ||
                  admissionStoragePaused
                ) {
                  const finished = yield* settleKnownOutcome.pipe(
                    Effect.mapError((cause) =>
                      error(
                        isJournalConflict(cause)
                          ? "Cloud rejection recovery changed concurrently. Reopen history to retry local recovery. No remote interrupt was sent."
                          : "Kilo Cloud rejected this request, but its outcome cannot be saved. Restore local storage and reopen history. No remote interrupt was sent.",
                      ),
                    ),
                  );
                  if (finished || !active) {
                    yield* watch;
                    return false;
                  }
                  if (admissionStoragePaused) {
                    const settled = yield* resumeLocalStorage.pipe(
                      Effect.mapError((cause) =>
                        error(
                          isJournalConflict(cause)
                            ? "Cloud recovery changed concurrently. Reopen history to retry. No remote interrupt was sent."
                            : "Cloud recovery remains paused because its journal cannot be updated. Restore local storage and reopen history. No remote interrupt was sent.",
                        ),
                      ),
                    );
                    if (settled || !active) {
                      yield* watch;
                      return false;
                    }
                  }
                  // Newer prepared admission is authoritative, but not a binding.
                  // Resume its read-only recovery; Stop can be retried after binding.
                  if (!binding) yield* watch;
                }
                if (active.submissionPhase === "preflight") {
                  yield* finish("interrupted");
                  return false;
                }
                if (active.state === "awaiting_result") {
                  yield* save({ ...active, resultStatus: "cancelled" });
                  yield* finish("interrupted");
                  yield* status(
                    "Result retrieval cancelled locally. Kilo already reported completion; sandbox and billing were not stopped.",
                  );
                  return false;
                }
                if (!binding)
                  return yield* error(
                    "Cloud admission has no confirmed session ID. Remote Stop is unavailable; task and billing status remain unknown.",
                  );
                yield* watch;
                if (active.interruptRequested) {
                  // Another observer already persisted Stop. Resume observation
                  // without sending a duplicate interrupt.
                  admissionStoragePaused = false;
                  admissionFailures = 0;
                  return true;
                }
                yield* save({ ...active, interruptRequested: true });
                // A successful write retires the local storage pause so this
                // explicit Stop can observe remote confirmation. Keep durable
                // admission pauses intact.
                admissionStoragePaused = false;
                admissionFailures = 0;
                const accepted = yield* wire(
                  options.client
                    .interrupt(binding)
                    .pipe(
                      Effect.catch((cause) =>
                        cause.reason === "admission_unknown"
                          ? Effect.fail(cause)
                          : save({ ...active!, interruptRequested: false }).pipe(
                              Effect.andThen(Effect.fail(cause)),
                            ),
                      ),
                    ),
                );
                if (!accepted.success) yield* save({ ...active!, interruptRequested: false });
                yield* status(
                  accepted.success
                    ? "Interrupt requested. Waiting for remote task confirmation; sandbox and billing may remain active."
                    : "Kilo did not confirm interruption. The remote task may still be running.",
                );
                return true;
              }),
            )
            .pipe(
              Effect.flatMap((wait) =>
                wait
                  ? Deferred.await(terminalSignal).pipe(
                      Effect.timeout("45 seconds"),
                      Effect.mapError(() =>
                        error(
                          "Remote interruption is still unconfirmed. The task may still be running; sandbox and billing status are separate.",
                        ),
                      ),
                    )
                  : Effect.void,
              ),
            ),
        readThreadSnapshot: (request) =>
          gate.withPermit(
            Effect.gen(function* () {
              yield* owned(request.providerThread);
              const resumeAdmissionWatch =
                active?.admissionRecoveryPaused === true || admissionStoragePaused;
              if (resumeAdmissionWatch) {
                yield* Effect.gen(function* () {
                  yield* refreshIntent;
                  if (
                    active &&
                    (active.state === "admission_unknown" ||
                      active.state === "active" ||
                      active.state === "awaiting_result")
                  )
                    yield* save({
                      ...active,
                      admissionRecoveryPaused: false,
                      admissionRecoveryFailures: 0,
                    });
                  admissionProbeAt = 0;
                  admissionProbeDelay = 2_000;
                  admissionFailures = 0;
                  admissionStoragePaused = false;
                }).pipe(
                  Effect.retry({ times: 1 }),
                  Effect.timeout("8 seconds"),
                  Effect.mapError((cause) =>
                    error(
                      isJournalConflict(cause)
                        ? "Cloud recovery changed concurrently. Reopen history to retry reads. No request was resubmitted."
                        : "Cloud recovery remains paused because its journal cannot be updated. Restore local storage and reopen history. No request was resubmitted.",
                    ),
                  ),
                );
              }
              yield* reconcile().pipe(
                Effect.timeout("10 seconds"),
                Effect.mapError(() =>
                  error(
                    taskState === "completed"
                      ? "Cloud history is unavailable. Remote execution completed; sandbox and billing are separate."
                      : "Cloud history is temporarily unavailable. Remote execution may still be active.",
                  ),
                ),
              );
              yield* lifecycle;
              if (resumeAdmissionWatch && hasBackgroundWork()) yield* watch;
              const intents = yield* wire(options.journal.readThread(thread!.id));
              return {
                providerThread: thread!,
                providerTurns: intents.map((entry) => entry.providerTurn),
                messages: [...messages.values()],
                runtimeRequests: [...requests.values()].map((entry) => entry.runtime),
              };
            }),
          ),
        respondToRuntimeRequest: (response) =>
          gate.withPermit(
            Effect.gen(function* () {
              const pending = requests.get(response.requestId);
              if (!pending || pending.runtime.status !== "pending" || !active || !binding)
                return yield* error("Cloud interaction is not pending for this turn.");
              if (active.answeredRequestIds.includes(pending.native.id))
                return yield* error(
                  "The previous answer has an uncertain outcome; it was not resubmitted.",
                );
              const current = yield* wire(options.client.pending(binding));
              if (
                ![...current.questions, ...current.permissions].some(
                  (request) => request.id === pending.native.id,
                )
              )
                return yield* error("The cloud interaction has already ended.");
              let reply;
              if ("questions" in pending.native) {
                const answers = kiloQuestionAnswers(
                  pending.native.questions,
                  response.answers ?? {},
                );
                if (!answers) return yield* error("Each cloud question requires an answer.");
                reply = options.client.replyQuestion(binding, pending.native.id, answers);
              } else {
                if (!response.decision)
                  return yield* error("A cloud permission decision is required.");
                reply = options.client.replyPermission(
                  binding,
                  pending.native.id,
                  kiloPermissionReply(response.decision),
                );
              }
              yield* save({
                ...active,
                answeredRequestIds: [...active.answeredRequestIds, pending.native.id],
              });
              const resetAnswer = () =>
                save({
                  ...active!,
                  answeredRequestIds: active!.answeredRequestIds.filter(
                    (id) => id !== pending.native.id,
                  ),
                });
              const accepted = yield* wire(
                reply.pipe(
                  Effect.catch((cause) =>
                    cause.reason === "admission_unknown"
                      ? Effect.fail(cause)
                      : resetAnswer().pipe(Effect.andThen(Effect.fail(cause))),
                  ),
                ),
              );
              if (!accepted.success) {
                yield* resetAnswer();
                return yield* error(
                  "Kilo did not confirm delivery of the answer. Task status remains unknown.",
                );
              }
              yield* resolveRequest(pending);
            }),
          ),
        steerTurn: unsupported,
        rollbackThread: unsupported,
        forkThread: unsupported,
      };
      return runtime;
    }),
  });
});
