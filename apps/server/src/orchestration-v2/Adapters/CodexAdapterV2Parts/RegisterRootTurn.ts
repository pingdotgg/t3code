import { pipe } from "effect/Function";
import { makeCodexTurnTokenUsageState, getCodexTurnAccumulator, type CodexTurnTokenUsageState } from "../../../provider/CodexTurnTokenUsage.ts";
import { buildCodexInitializeParams } from "../../../provider/CodexProvider.ts";
import { type CodexRateLimitSnapshot } from "../../../provider/codexUsageLimits.ts";
import { OrchestrationV2ProviderGoal, ProviderSetupError } from "@t3tools/contracts";
import type { ModelSelection, OrchestrationV2PlanArtifact, OrchestrationV2ProviderThread, OrchestrationV2TurnItem, ProviderRequestKind, ProviderThreadId, ProviderTurnId, RuntimeMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
export interface PendingMcpAppCapture {
        readonly item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>;
        readonly fiber: Fiber.Fiber<void>;
      }

import { CODEX_CLIENT_CAPABILITIES, CODEX_PROVIDER, type CodexDynamicToolItem, type CodexTurnStartParamsWithCollaborationMode } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { codexRetryTurnItem, isDescendantCodexTurn, isPersistentCodexDynamicTool, providerGoalsEqual, providerSession, type ActiveCodexProviderRetry, type ActiveCodexTurnContext, type CodexGoalHold, type CodexSubagentThreadContext, type DeferredCodexRootTerminal, type PendingCodexRuntimeRequest, type PendingCodexSubagentTurnStarted, type TrackedRunningCommandItem } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
type Deps = CodexAdapterScope;

export const installRegisterRootTurn = Effect.fnUntraced(function* (deps: Deps) {
  const { adapterOptions, clientFactory, idAllocator, input } = deps;

const scope = yield* Scope.Scope;

const resolvedRuntime =
        adapterOptions.resolveRuntime === undefined
          ? undefined
          : yield* adapterOptions.resolveRuntime.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );

const client = yield* clientFactory.open({
        instanceId: adapterOptions.instanceId,
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
        runtimePolicy: input.runtimePolicy,
        settings: resolvedRuntime?.config ?? adapterOptions.settings,
        environment: resolvedRuntime?.environment ?? adapterOptions.environment,
      });

const additionalContextByThread = yield* Ref.make(
        new Map<
          string,
          NonNullable<CodexTurnStartParamsWithCollaborationMode["additionalContext"]>
        >(),
      );

const restoreAdditionalContext = Effect.fn("CodexAdapterV2.restoreAdditionalContext")(
        function* (threadId: string) {
          const context = (yield* Ref.get(additionalContextByThread)).get(threadId);
          if (!context) return;
          yield* client.request("thread/inject_items", {
            threadId,
            items: Object.entries(context).map(([key, entry]) =>
              entry.kind === "untrusted"
                ? {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: `<external_${key}>${entry.value}</external_${key}>`,
                      },
                    ],
                  }
                : {
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                  },
            ),
          });
        },
        Effect.timeout("10 seconds"),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to restore Codex additional context after compaction.", {
            cause,
          }),
        ),
      );

const initialized = yield* Ref.make(false);

const initializePermit = yield* Semaphore.make(1);

const ensureInitialized = initializePermit.withPermit(
        Effect.gen(function* () {
          const alreadyInitialized = yield* Ref.get(initialized);
          if (alreadyInitialized) {
            return;
          }

          const userAgent = yield* client
            .request("initialize", {
              clientInfo: buildCodexInitializeParams().clientInfo,
              capabilities: CODEX_CLIENT_CAPABILITIES,
            })
            .pipe(
              Effect.map((response) => response.userAgent),
              Effect.catchTags({
                // Interruption can leave Codex initialized before the local flag is set.
                CodexAppServerRequestError: (error) =>
                  error.code === -32600 && error.errorMessage === "Already initialized"
                    ? Effect.succeed(null)
                    : Effect.fail(error),
              }),
            );
          const version = userAgent && /\/(\S+)/u.exec(userAgent)?.[1];
          const advisory =
            version && adapterOptions.compatibility
              ? yield* adapterOptions.compatibility(version)
              : undefined;
          if (advisory?.status === "broken") {
            const target =
              advisory.recommendedVersion ?? advisory.recommendedRange ?? "a newer version";
            return yield* new ProviderSetupError({
              instanceId: adapterOptions.instanceId,
              operation: "runtime",
              detail: `Codex ${version} does not work with this T3 Code release. Update Codex to ${target}, then retry.`,
            });
          }
          yield* client.notify("initialized", undefined);
          yield* Ref.set(initialized, true);
        }),
      );

if (adapterOptions.compatibility !== undefined) yield* ensureInitialized;

const now = yield* DateTime.now;

const session = providerSession({
        providerSessionId: input.providerSessionId,
        providerInstanceId: adapterOptions.instanceId,
        cwd: input.runtimePolicy.cwd,
        model: input.modelSelection.model,
        now,
      });

const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterEventStreamError
      >();

yield* client.awaitTermination.pipe(
        Effect.catch((cause) =>
          Queue.fail(
            events,
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver: CODEX_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
          ),
        ),
        Effect.forkScoped,
      );

const rateLimitSnapshot = yield* Ref.make<CodexRateLimitSnapshot | undefined>(undefined);

const limitedTurnItems = yield* Ref.make(
        new Map<ProviderThreadId, Extract<OrchestrationV2TurnItem, { type: "error" }>>(),
      );

const activeTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());

const turnTokenUsageByThread = new Map<string, CodexTurnTokenUsageState>();

const usageStateForThread = (nativeThreadId: string) => {
        let state = turnTokenUsageByThread.get(nativeThreadId);
        if (!state) {
          state = makeCodexTurnTokenUsageState();
          turnTokenUsageByThread.set(nativeThreadId, state);
        }
        return state;
      };

const beginTurnTokenUsage = (context: ActiveCodexTurnContext) => {
        const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
        if (!nativeThreadId) return;
        const state = usageStateForThread(nativeThreadId);
        if (state.activeTurnId !== context.nativeTurnId) {
          state.byTurnId.clear();
          state.activeTurnId = context.nativeTurnId;
          getCodexTurnAccumulator(state, context.nativeTurnId);
        }
      };

const markSubagentUsage = (context: ActiveCodexTurnContext) => {
        const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
        if (!nativeThreadId) return;
        getCodexTurnAccumulator(
          usageStateForThread(nativeThreadId),
          context.nativeTurnId,
        ).hasSubagents = true;
      };

const pendingRootTurns = yield* Ref.make(
        new Map<string, ProviderAdapter.ProviderAdapterV2TurnInput>(),
      );

const turnWaiters = yield* Ref.make(new Map<string, Deferred.Deferred<void, never>>());

const subagentThreads = yield* Ref.make(new Map<string, CodexSubagentThreadContext>());

const subagentSelections = new Map<string, Omit<ModelSelection, "instanceId">>();

const reroutedTurnModels = new Map<string, string>();

const reroutedThreads = new Set<string>();

const reportedTurnModel = (nativeThreadId: string, nativeTurnId: string) => {
        const rerouted = reroutedTurnModels.get(nativeTurnId);
        reroutedTurnModels.delete(nativeTurnId);
        if (rerouted !== undefined) return rerouted;
        return reroutedThreads.has(nativeThreadId)
          ? undefined
          : subagentSelections.get(nativeThreadId)?.model;
      };

const pendingSubagentTurns = yield* Ref.make(
        new Map<string, ReadonlyArray<PendingCodexSubagentTurnStarted>>(),
      );

const nextProviderTurnOrdinals = yield* Ref.make(new Map<string, number>());

const providerRetries = yield* Ref.make(
        new Map<ProviderTurnId, ActiveCodexProviderRetry>(),
      );

const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());

const pendingRuntimeRequests = yield* Ref.make(
        new Map<string, PendingCodexRuntimeRequest>(),
      );

const sessionApprovals = new Map<
        string,
        { readonly runtimeMode: RuntimeMode; readonly kinds: Set<ProviderRequestKind> }
      >();

const endSessionApprovalsOnModeChange = (context: ActiveCodexTurnContext) => {
        const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
        if (
          nativeThreadId != null &&
          sessionApprovals.get(nativeThreadId)?.runtimeMode !==
            context.input.runtimePolicy.runtimeMode
        ) {
          sessionApprovals.delete(nativeThreadId);
        }
      };

const sessionAllowance = (
        nativeThreadId: string,
        context: ActiveCodexTurnContext,
      ): Set<ProviderRequestKind> => {
        const runtimeMode = context.input.runtimePolicy.runtimeMode;
        const allowed = sessionApprovals.get(nativeThreadId);
        if (allowed?.runtimeMode === runtimeMode) return allowed.kinds;
        if (allowed !== undefined) return new Set();
        const kinds = new Set<ProviderRequestKind>();
        sessionApprovals.set(nativeThreadId, { runtimeMode, kinds });
        return kinds;
      };

const settledTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());

const runningCommandItemsByTurn = yield* Ref.make(
        new Map<string, Map<string, TrackedRunningCommandItem>>(),
      );

const runningDynamicToolsByTurn = yield* Ref.make(
        new Map<string, Map<string, CodexDynamicToolItem>>(),
      );

const interruptingNativeTurns = yield* Ref.make(new Set<string>());

const terminalizedNonCompletedNativeTurns = yield* Ref.make(new Set<string>());

const deferredRootTerminals = yield* Ref.make(new Map<string, DeferredCodexRootTerminal>());

const offeredContinuationItemsByTurn = yield* Ref.make(new Map<string, Set<string>>());

const finalAnswerItemIdsByTurn = yield* Ref.make(new Map<string, Set<string>>());

const completedFinalAnswerTextsByTurn = yield* Ref.make(new Map<string, Set<string>>());

const imageTurns = new Map<
        string,
        {
          readonly running: Set<string>;
          readonly saved: Map<string, string>;
          pending: boolean;
          answer?: { readonly id: string; readonly text: string };
        }
      >();

const imageTurn = (nativeTurnId: string) => {
        let state = imageTurns.get(nativeTurnId);
        if (state === undefined) {
          state = { running: new Set(), saved: new Map(), pending: false };
          imageTurns.set(nativeTurnId, state);
        }
        return state;
      };

const turnTerminalizationPermit = yield* Semaphore.make(1);

const goalsByNativeThread = new Map<string, OrchestrationV2ProviderGoal | null>();

const rootProviderThreads = new Map<string, OrchestrationV2ProviderThread>();

const goalHolds = new Map<string, CodexGoalHold>();

const continuedRuns = new Map<ProviderTurnId, Array<ActiveCodexTurnContext>>();

const capacityContinuations = new Map<
        string,
        { readonly context: ActiveCodexTurnContext; readonly retry: ActiveCodexProviderRetry }
      >();

const goalActivations = new Map<string, { stopped: boolean }>();

const goalStops = new Map<string, number>();

const latestRunTurnId = (providerTurnId: ProviderTurnId) =>
        continuedRuns.get(providerTurnId)?.at(-1)?.providerTurnId ?? providerTurnId;

const isContinuedRunDescendant = (
        candidate: ActiveCodexTurnContext,
        context: ActiveCodexTurnContext,
      ) =>
        (continuedRuns.get(context.providerTurnId) ?? [context]).some((ancestor) =>
          isDescendantCodexTurn(candidate, ancestor),
        );

const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

const emitImageWorkState =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (context: ActiveCodexTurnContext, pending: boolean) {
          const state = imageTurns.get(context.nativeTurnId);
          if (state === undefined || state.pending === pending) return;
          state.pending = pending;
          yield* emitProviderEvent({
            type: "background_work.updated",
            driver: CODEX_PROVIDER,
            providerTurnId: context.providerTurnId,
            pending,
          });
        });

const clearImageWork = Effect.fn("CodexAdapterV2.clearImageWork")(function* (
        context: ActiveCodexTurnContext,
      ) {
        yield* emitImageWorkState(context, false);
        imageTurns.delete(context.nativeTurnId);
      });

const goalUpdatesHeld = new Set<string>();

const emitGoalUpdate = Effect.fnUntraced(function* (nativeThreadId: string) {
        const providerThread = rootProviderThreads.get(nativeThreadId);
        if (
          providerThread === undefined ||
          !goalsByNativeThread.has(nativeThreadId) ||
          goalUpdatesHeld.has(nativeThreadId)
        ) {
          return;
        }
        const goal = goalsByNativeThread.get(nativeThreadId) ?? null;
        if (providerGoalsEqual(providerThread.goal ?? null, goal)) return;
        const updated = { ...providerThread, goal, updatedAt: yield* DateTime.now };
        rootProviderThreads.set(nativeThreadId, updated);
        yield* emitProviderEvent({
          type: "provider_thread.updated",
          driver: CODEX_PROVIDER,
          providerThread: updated,
        });
      });

const rememberRootProviderThread = Effect.fnUntraced(function* (
        providerThread: OrchestrationV2ProviderThread,
      ) {
        const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
        if (nativeThreadId == null) return;
        rootProviderThreads.set(nativeThreadId, providerThread);
        yield* emitGoalUpdate(nativeThreadId);
      });

const releaseGoalUpdates = (nativeThreadId: string) =>
        Effect.suspend(() => {
          goalUpdatesHeld.delete(nativeThreadId);
          return emitGoalUpdate(nativeThreadId);
        });

const completeProviderRetry = Effect.fnUntraced(function* (
        context: ActiveCodexTurnContext,
        updatedAt: DateTime.Utc,
      ) {
        const providerRetry = yield* Ref.modify(providerRetries, (current) => {
          const retry = current.get(context.providerTurnId);
          if (retry === undefined) {
            return [undefined, current] as const;
          }
          const updated = new Map(current);
          updated.delete(context.providerTurnId);
          return [retry, updated] as const;
        });
        if (providerRetry === undefined) {
          return;
        }
        yield* emitProviderEvent({
          type: "turn_item.updated",
          driver: CODEX_PROVIDER,
          turnItem: codexRetryTurnItem(context, providerRetry, "completed", updatedAt),
        }).pipe(Effect.withSpan("CodexAdapterV2.completeProviderRetry"));
      });

const registerRootTurn = Effect.fn("CodexAdapterV2.registerRootTurn")(function* (input: {
        readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly nativeTurnId: string;
        readonly startedAt: DateTime.Utc;
        readonly waitForNativeStart?: boolean;
      }) {
        const existing = (yield* Ref.get(activeTurns)).get(input.nativeTurnId);
        if (existing !== undefined) {
          return existing;
        }
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_PROVIDER,
          nativeTurnId: input.nativeTurnId,
        });
        const context: ActiveCodexTurnContext = {
          ...(input.waitForNativeStart ? { nativeStartReady: yield* Deferred.make<void>() } : {}),
          input: input.turnInput,
          projectionAppThread: input.turnInput.appThread,
          projectionThreadId: input.turnInput.threadId,
          projectionRunId: input.turnInput.runId,
          nativeTurnId: input.nativeTurnId,
          providerThread: input.turnInput.providerThread,
          providerTurnId,
          providerTurnOrdinal: input.turnInput.providerTurnOrdinal,
          providerNodeId: input.turnInput.rootNodeId,
          providerNodeStartedAt: input.startedAt,
          itemParentNodeId: input.turnInput.rootNodeId,
          rootNodeId: input.turnInput.rootNodeId,
          subagent: null,
          startedAt: input.startedAt,
          itemPositions: new Map(),
          fileChangeKindsByItem: new Map(),
          runningCompactionItemIds: new Set(),
        };
        const nativeThreadId = input.turnInput.providerThread.nativeThreadRef?.nativeId;
        const continuation =
          nativeThreadId == null ? undefined : capacityContinuations.get(nativeThreadId);
        if (continuation !== undefined) {
          context.capacityRetryAttempt = continuation.context.capacityRetryAttempt ?? 0;
          yield* Ref.update(providerRetries, (current) =>
            new Map(current).set(providerTurnId, continuation.retry),
          );
          const turns = continuedRuns.get(continuation.context.providerTurnId) ?? [
            continuation.context,
          ];
          turns.push(context);
          continuedRuns.set(continuation.context.providerTurnId, turns);
          continuedRuns.set(providerTurnId, turns);
          if (continuation.context.capacityRetryPending !== undefined) {
            yield* Deferred.succeed(continuation.context.capacityRetryPending, context);
          }
        }
        yield* Ref.update(limitedTurnItems, (current) => {
          const next = new Map(current);
          next.delete(context.providerThread.id);
          return next;
        });
        beginTurnTokenUsage(context);
        endSessionApprovalsOnModeChange(context);
        yield* Ref.update(activeTurns, (current) => {
          const updated = new Map(current);
          updated.set(input.nativeTurnId, context);
          return updated;
        });
        if (continuation !== undefined && nativeThreadId != null) {
          capacityContinuations.delete(nativeThreadId);
        }
        yield* emitProviderEvent({
          type: "provider_turn.updated",
          driver: CODEX_PROVIDER,
          threadId: input.turnInput.threadId,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: input.turnInput.providerThread.id,
            nodeId: input.turnInput.rootNodeId,
            runAttemptId: input.turnInput.attemptId,
            nativeTurnRef: {
              driver: CODEX_PROVIDER,
              nativeId: input.nativeTurnId,
              strength: "strong",
            },
            ordinal: input.turnInput.providerTurnOrdinal,
            status: "running",
            startedAt: input.startedAt,
            completedAt: null,
          },
        });
        yield* rememberRootProviderThread(input.turnInput.providerThread);
        return context;
      });

const findActiveTurnByNativeThreadId =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (nativeThreadId: string) {
          const turns = Array.from((yield* Ref.get(activeTurns)).values());
          return turns.find(
            (context) => context.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
          );
        });

const awaitActiveTurn = Effect.fnUntraced(function* (
        nativeTurnId: string,
        attemptsRemaining = 1_000,
      ): Effect.fn.Return<ActiveCodexTurnContext | undefined> {
        const context = (yield* Ref.get(activeTurns)).get(nativeTurnId);
        if (context !== undefined || attemptsRemaining <= 0) {
          return context;
        }
        yield* Effect.yieldNow;
        return yield* awaitActiveTurn(nativeTurnId, attemptsRemaining - 1);
      });

const resolveItemEventContext =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (nativeTurnId: string) {
          const settled = (yield* Ref.get(settledTurns)).get(nativeTurnId);
          if (settled !== undefined) {
            return { context: settled, settled: true } as const;
          }
          const context = yield* awaitActiveTurn(nativeTurnId);
          return context === undefined ? undefined : ({ context, settled: false } as const);
        });

const trackRunningCommandItem = (nativeTurnId: string, item: TrackedRunningCommandItem) =>
        Ref.update(runningCommandItemsByTurn, (current) => {
          const updated = new Map(current);
          const items = new Map(updated.get(nativeTurnId) ?? []);
          items.set(item.id, item);
          updated.set(nativeTurnId, items);
          return updated;
        });

const clearRunningCommandItem = (nativeTurnId: string, nativeItemId: string) =>
        Ref.modify(runningCommandItemsByTurn, (current) => {
          const items = current.get(nativeTurnId);
          if (items === undefined || !items.has(nativeItemId)) {
            return [items === undefined || items.size === 0, current] as const;
          }
          const remaining = new Map(items);
          remaining.delete(nativeItemId);
          const updated = new Map(current);
          if (remaining.size === 0) {
            updated.delete(nativeTurnId);
          } else {
            updated.set(nativeTurnId, remaining);
          }
          return [remaining.size === 0, updated] as const;
        });

const pendingMcpAppCaptures = yield* Ref.make(
        new Map<string, ReadonlyMap<string, PendingMcpAppCapture>>(),
      );

const takePendingMcpAppCapture = (nativeTurnId: string, nativeItemId: string) =>
        Ref.modify(pendingMcpAppCaptures, (current) => {
          const captures = current.get(nativeTurnId);
          if (captures === undefined || !captures.has(nativeItemId)) {
            return [false, current] as const;
          }
          const remaining = new Map(captures);
          remaining.delete(nativeItemId);
          const updated = new Map(current);
          if (remaining.size === 0) updated.delete(nativeTurnId);
          else updated.set(nativeTurnId, remaining);
          return [true, updated] as const;
        });

const trackRunningDynamicTool = (nativeTurnId: string, item: CodexDynamicToolItem) =>
        Ref.update(runningDynamicToolsByTurn, (current) => {
          const updated = new Map(current);
          const items = new Map(updated.get(nativeTurnId) ?? []);
          items.set(item.id, item);
          updated.set(nativeTurnId, items);
          return updated;
        });

const clearRunningDynamicTool = (nativeTurnId: string, nativeItemId: string) =>
        Ref.update(runningDynamicToolsByTurn, (current) => {
          const items = current.get(nativeTurnId);
          if (items === undefined || !items.has(nativeItemId)) {
            return current;
          }
          const remaining = new Map(items);
          remaining.delete(nativeItemId);
          const updated = new Map(current);
          if (remaining.size === 0) {
            updated.delete(nativeTurnId);
          } else {
            updated.set(nativeTurnId, remaining);
          }
          return updated;
        });

const turnHasRetainedBackgroundWork =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (nativeTurnId: string) {
          const commands = (yield* Ref.get(runningCommandItemsByTurn)).get(nativeTurnId);
          if (commands !== undefined && commands.size > 0) {
            return true;
          }
          if ((yield* Ref.get(pendingMcpAppCaptures)).has(nativeTurnId)) {
            return true;
          }
          const images = imageTurns.get(nativeTurnId);
          if (images !== undefined && (images.running.size > 0 || images.saved.size > 0)) {
            return true;
          }
          const tools = (yield* Ref.get(runningDynamicToolsByTurn)).get(nativeTurnId);
          if (tools === undefined) {
            return false;
          }
          for (const item of tools.values()) {
            if (isPersistentCodexDynamicTool(item)) {
              return true;
            }
          }
          return false;
        });

  return { scope, resolvedRuntime, client, additionalContextByThread, restoreAdditionalContext, initialized, initializePermit, ensureInitialized, now, session, events, rateLimitSnapshot, limitedTurnItems, activeTurns, turnTokenUsageByThread, usageStateForThread, beginTurnTokenUsage, markSubagentUsage, pendingRootTurns, turnWaiters, subagentThreads, subagentSelections, reroutedTurnModels, reroutedThreads, reportedTurnModel, pendingSubagentTurns, nextProviderTurnOrdinals, providerRetries, planIds, pendingRuntimeRequests, sessionApprovals, endSessionApprovalsOnModeChange, sessionAllowance, settledTurns, runningCommandItemsByTurn, runningDynamicToolsByTurn, interruptingNativeTurns, terminalizedNonCompletedNativeTurns, deferredRootTerminals, offeredContinuationItemsByTurn, finalAnswerItemIdsByTurn, completedFinalAnswerTextsByTurn, imageTurns, imageTurn, turnTerminalizationPermit, goalsByNativeThread, rootProviderThreads, goalHolds, continuedRuns, capacityContinuations, goalActivations, goalStops, latestRunTurnId, isContinuedRunDescendant, emitProviderEvent, emitImageWorkState, clearImageWork, goalUpdatesHeld, emitGoalUpdate, rememberRootProviderThread, releaseGoalUpdates, completeProviderRetry, registerRootTurn, findActiveTurnByNativeThreadId, awaitActiveTurn, resolveItemEventContext, trackRunningCommandItem, clearRunningCommandItem, pendingMcpAppCaptures, takePendingMcpAppCapture, trackRunningDynamicTool, clearRunningDynamicTool, turnHasRetainedBackgroundWork };
});

export type RegisterRootTurnPart = ReturnType<typeof installRegisterRootTurn> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRegisterRootTurn>;
