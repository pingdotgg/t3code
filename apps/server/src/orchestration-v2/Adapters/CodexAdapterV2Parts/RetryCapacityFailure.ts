import { pipe } from "effect/Function";
import { type OrchestrationV2GoalCommand } from "@t3tools/contracts";
import type { OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, ProviderTurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
// @effect-diagnostics anyUnknownInErrorContext:off
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { codexErrorInfoCode, codexRetryTurnItem, describeCodexGoal, getNativeThreadId, providerGoalFromCodex, type ActiveCodexProviderRetry, type ActiveCodexTurnContext, validateCodexGoalObjective } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { CODEX_CAPACITY_MAX_RETRIES, CODEX_PROVIDER, codexTimestamp, mapCodexTurnStatus } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";
import type { EmitRootTerminalPart } from "./EmitRootTerminal.ts";
import type { ProjectGeneratedImagesPart } from "./ProjectGeneratedImages.ts";
import type { MakeRootTerminalEventPart } from "./MakeRootTerminalEvent.ts";
import type { FinalizeCodexTurnPart } from "./FinalizeCodexTurn.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart & ProjectGeneratedImagesPart & MakeRootTerminalEventPart & FinalizeCodexTurnPart;

export const installRetryCapacityFailure = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, buildAgentMessageArtifacts, capacityContinuations, client, continuedRuns, emitOrDeferRootTerminal, emitProviderEvent, emitRootTerminal, ensureInitialized, finalizeCodexTurn, goalActivations, goalHolds, goalStops, goalUpdatesHeld, goalsByNativeThread, idAllocator, interruptingNativeTurns, latestRunTurnId, now, providerRetries, releaseGoalHold, releaseGoalUpdates, rememberRootProviderThread, resolveItemOrdinal, rootProviderThreads, scope, settleGoalHold, startNativeTurn, toCodexInput, turnTerminalizationPermit } = deps;

const retryCapacityFailure = Effect.fn("CodexAdapterV2.retryCapacityFailure")(function* (
        terminal: Parameters<typeof finalizeCodexTurn>[0],
      ) {
        const context = terminal.context;
        const code =
          terminal.failureErrorInfo == null
            ? context.latestProviderFailure?.nativeCode
            : codexErrorInfoCode(terminal.failureErrorInfo);
        if (
          terminal.status !== "failed" ||
          code !== "serverOverloaded" ||
          context.subagent !== null ||
          (context.input.message.attachments.length === 0 &&
            context.input.message.text.trim().toLowerCase() === "/compact")
        )
          return false;

        return yield* turnTerminalizationPermit.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* Ref.get(activeTurns)).get(terminal.nativeTurnId) !== context) return true;
            if (context.capacityRetryPending !== undefined) return true;
            if (
              (context.capacityRetryAttempt ?? 0) >= CODEX_CAPACITY_MAX_RETRIES ||
              (yield* Ref.get(interruptingNativeTurns)).has(terminal.nativeTurnId)
            )
              return false;

            const attempt = (context.capacityRetryAttempt ?? 0) + 1;
            context.capacityRetryAttempt = attempt;
            const pending = yield* Deferred.make<ActiveCodexTurnContext | undefined>();
            context.capacityRetryPending = pending;
            const retryDelayMs = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
            const now = yield* DateTime.now;
            const previous = (yield* Ref.get(providerRetries)).get(context.providerTurnId);
            const state: ActiveCodexProviderRetry = {
              context: previous?.context ?? context,
              nativeMessage:
                terminal.failureMessage ??
                context.latestProviderFailure?.nativeMessage ??
                "Selected model is at capacity.",
              nativeCode: code,
              failure: makeProviderFailure({
                message:
                  context.latestProviderFailure?.failure.message ?? terminal.failureMessage,
                code,
                class: "provider_error",
                retryable: true,
              }),
              retry: { attempt, maxAttempts: CODEX_CAPACITY_MAX_RETRIES, retryDelayMs },
              itemOrdinal:
                previous?.itemOrdinal ??
                (yield* resolveItemOrdinal(
                  context,
                  `terminal-failure:${context.providerTurnId}`,
                )),
              startedAt: previous?.startedAt ?? now,
            };
            yield* Ref.update(providerRetries, (current) =>
              new Map(current).set(context.providerTurnId, state),
            );
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: codexRetryTurnItem(context, state, "running", now),
            });
            yield* Effect.sleep(retryDelayMs).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const nativeThreadId = yield* getNativeThreadId(context.providerThread);
                  const claimed = yield* turnTerminalizationPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (
                        (yield* Ref.get(activeTurns)).get(terminal.nativeTurnId) !== context ||
                        goalStops.has(nativeThreadId) ||
                        (yield* Ref.get(interruptingNativeTurns)).has(terminal.nativeTurnId)
                      )
                        return false;
                      capacityContinuations.set(nativeThreadId, { context, retry: state });
                      yield* finalizeCodexTurn({ ...terminal, continueRun: true });
                      return true;
                    }),
                  );
                  if (!claimed) return;
                  // Notifications before the RPC response also take the terminalization permit.
                  yield* startNativeTurn(
                    {
                      ...context.input,
                      providerTurnOrdinal: context.providerTurnOrdinal + 1,
                    },
                    [],
                  ).pipe(
                    Effect.catch((cause) =>
                      Effect.gen(function* () {
                        if (yield* Deferred.isDone(pending)) return;
                        yield* Effect.logWarning(
                          "orchestration-v2.codex-capacity-retry-start-failed",
                          {
                            providerTurnId: context.providerTurnId,
                            cause,
                          },
                        );
                        yield* emitProviderEvent({
                          type: "turn_item.updated",
                          driver: CODEX_PROVIDER,
                          turnItem: codexRetryTurnItem(
                            context,
                            state,
                            "failed",
                            yield* DateTime.now,
                          ),
                        });
                        yield* Deferred.succeed(pending, undefined);
                        yield* turnTerminalizationPermit.withPermits(1)(
                          emitOrDeferRootTerminal({ ...terminal, providerRetry: state }),
                        );
                      }),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (capacityContinuations.get(nativeThreadId)?.context === context)
                          capacityContinuations.delete(nativeThreadId);
                      }),
                    ),
                  );
                }),
              ),
              Effect.forkIn(scope, { startImmediately: true }),
            );
            return true;
          }),
        );
      });

yield* client.handleServerNotification("turn/completed", (payload) =>
        Effect.gen(function* () {
          const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
          if (context === undefined) {
            return;
          }
          const nativeStatus = mapCodexTurnStatus(payload.turn.status);
          const status =
            nativeStatus === "completed" &&
            (yield* Ref.get(interruptingNativeTurns)).has(payload.turn.id)
              ? "interrupted"
              : nativeStatus;
          const terminal = {
            context,
            nativeTurnId: payload.turn.id,
            status,
            completedAt: codexTimestamp(payload.turn.completedAt),
            ...(payload.turn.error?.message === undefined
              ? {}
              : {
                  failureMessage: payload.turn.error.message,
                  ...(payload.turn.error.codexErrorInfo == null
                    ? {}
                    : { failureErrorInfo: payload.turn.error.codexErrorInfo }),
                }),
          };
          if (!(yield* retryCapacityFailure(terminal))) yield* finalizeCodexTurn(terminal);
        }),
      );

const completeGoalCommandTurn = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        reply: string | null,
      ) {
        const now = yield* DateTime.now;
        const nativeId = `goal-command:${turnInput.attemptId}`;
        const context: ActiveCodexTurnContext = {
          input: turnInput,
          projectionAppThread: turnInput.appThread,
          projectionThreadId: turnInput.threadId,
          projectionRunId: turnInput.runId,
          nativeTurnId: nativeId,
          providerThread: turnInput.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_PROVIDER,
            nativeTurnId: nativeId,
          }),
          providerTurnOrdinal: turnInput.providerTurnOrdinal,
          providerNodeId: turnInput.rootNodeId,
          providerNodeStartedAt: now,
          itemParentNodeId: turnInput.rootNodeId,
          rootNodeId: turnInput.rootNodeId,
          subagent: null,
          startedAt: now,
          itemPositions: new Map(),
          fileChangeKindsByItem: new Map(),
          runningCompactionItemIds: new Set(),
        };
        const providerTurn = {
          id: context.providerTurnId,
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: null,
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt: now,
          completedAt: null,
        } satisfies OrchestrationV2ProviderTurn;
        yield* emitProviderEvent({
          type: "provider_turn.updated",
          driver: CODEX_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn,
        });
        yield* rememberRootProviderThread(turnInput.providerThread);
        if (reply !== null) {
          const artifacts = yield* buildAgentMessageArtifacts(
            context,
            { id: nativeId, text: reply },
            true,
          );
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: CODEX_PROVIDER,
            message: artifacts.message,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
        }
        yield* emitProviderEvent({
          type: "provider_turn.updated",
          driver: CODEX_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn: { ...providerTurn, status: "completed", completedAt: now },
        });
        yield* emitRootTerminal(context, {
          type: "turn.terminal",
          driver: CODEX_PROVIDER,
          providerThreadId: turnInput.providerThread.id,
          providerTurnId: context.providerTurnId,
          runOrdinal: turnInput.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
      });

const heldGoalTurn = (
        providerThread: OrchestrationV2ProviderThread,
        providerTurnId: ProviderTurnId,
      ) => {
        const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
        const hold = nativeThreadId == null ? undefined : goalHolds.get(nativeThreadId);
        return hold?.context.providerTurnId === providerTurnId && nativeThreadId != null
          ? { nativeThreadId, hold }
          : undefined;
      };

const resolveGoalStopTarget = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput,
      ) {
        const goalThreadId = turnInput.providerThread.nativeThreadRef?.nativeId;
        if (goalThreadId == null) {
          return { turnInput, goalTurns: [] as ReadonlyArray<ActiveCodexTurnContext> };
        }
        goalStops.set(goalThreadId, (goalStops.get(goalThreadId) ?? 0) + 1);
        return yield* Effect.gen(function* () {
          // The run can settle while the pause is in flight, which drops its record.
          const requestedTurnId = latestRunTurnId(turnInput.providerTurnId);
          const heldBefore = goalHolds.get(goalThreadId)?.context;
          const turnsBefore = [
            ...(continuedRuns.get(requestedTurnId) ?? []),
            ...Array.from((yield* Ref.get(activeTurns)).values()).filter(
              (context) => context.providerTurnId === requestedTurnId,
            ),
            ...(heldBefore?.providerTurnId === requestedTurnId ? [heldBefore] : []),
          ];
          const activation = goalActivations.get(goalThreadId);
          if (activation !== undefined) activation.stopped = true;
          if (goalsByNativeThread.get(goalThreadId)?.status === "active") {
            yield* client
              .request("thread/goal/set", { threadId: goalThreadId, status: "paused" })
              .pipe(
                Effect.tap(({ goal }) =>
                  Effect.sync(() =>
                    goalsByNativeThread.set(goalThreadId, providerGoalFromCodex(goal)),
                  ),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
                ),
              );
          }
          return yield* turnTerminalizationPermit.withPermits(1)(
            Effect.gen(function* () {
              const providerTurnId = latestRunTurnId(turnInput.providerTurnId);
              const hold = goalHolds.get(goalThreadId);
              const held = hold !== undefined && hold.context.providerTurnId === providerTurnId;
              const goalTurns: ReadonlyArray<ActiveCodexTurnContext> = Array.from(
                new Set([
                  ...turnsBefore,
                  ...(continuedRuns.get(providerTurnId) ?? []),
                  ...(held ? [hold.context] : []),
                ]),
              );
              if (!held) return { turnInput: { ...turnInput, providerTurnId }, goalTurns };
              goalHolds.delete(goalThreadId);
              yield* settleGoalHold(hold, "interrupted");
              return {
                turnInput: { ...turnInput, providerTurnId, requestRuntimeRestart: true },
                goalTurns,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const stops = (goalStops.get(goalThreadId) ?? 1) - 1;
              if (stops > 0) goalStops.set(goalThreadId, stops);
              else goalStops.delete(goalThreadId);
            }),
          ),
        );
      });

const resumeNativeThread = Effect.fn("CodexAdapterV2.resumeNativeThread")(function* (
        threadId: string,
        params: Record<string, unknown>,
      ) {
        const resume = client.raw.request("thread/resume", { threadId, ...params });
        return yield* resume.pipe(
          Effect.catchTags({
            CodexAppServerRequestError: (cause) =>
              /\bsession \S+ is archived\b|\bcodex unarchive\b/i.test(cause.errorMessage)
                ? client.raw
                    .request("thread/unarchive", { threadId })
                    .pipe(Effect.andThen(resume))
                : Effect.fail(cause),
          }),
        );
      });

const runGoalCommand = Effect.fn("CodexAdapterV2.runGoalCommand")(
        function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          command: OrchestrationV2GoalCommand,
        ) {
          if (command.type === "set") yield* validateCodexGoalObjective(command.objective);
          const threadId = yield* getNativeThreadId(turnInput.providerThread);
          rootProviderThreads.set(threadId, turnInput.providerThread);
          const readGoal = client
            .request("thread/goal/get", { threadId })
            .pipe(
              Effect.map((response) =>
                response.goal == null ? null : providerGoalFromCodex(response.goal),
              ),
            );
          const current = yield* readGoal;
          goalsByNativeThread.set(threadId, current);
          if (command.type === "show") {
            return yield* completeGoalCommandTurn(
              turnInput,
              current === null ? "No goal is set." : describeCodexGoal(current),
            );
          }
          if (command.type === "clear") {
            const { cleared } = yield* client.request("thread/goal/clear", { threadId });
            goalsByNativeThread.set(threadId, null);
            return yield* completeGoalCommandTurn(turnInput, cleared ? null : "No goal is set.");
          }
          if (current === null && command.type !== "set") {
            return yield* completeGoalCommandTurn(turnInput, "No goal is set.");
          }
          if (command.type === "pause") {
            const { goal } = yield* client.request("thread/goal/set", {
              threadId,
              status: "paused",
            });
            goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
            return yield* completeGoalCommandTurn(turnInput, null);
          }
          if (command.type === "set") {
            goalUpdatesHeld.add(threadId);
            if (current !== null) yield* client.request("thread/goal/clear", { threadId });
            // Keep paused until our turn starts so Codex cannot start one first.
            const { goal } = yield* client.request("thread/goal/set", {
              threadId,
              objective: command.objective,
              status: "paused",
            });
            goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
          }
          // Hold fast first turns until activation; Stop cancels activation.
          const activation = { stopped: false };
          goalActivations.set(threadId, activation);
          yield* Effect.gen(function* () {
            // A bare objective reads like a statement, so the model echoes it back.
            yield* startNativeTurn(
              turnInput,
              command.type === "set"
                ? yield* toCodexInput({
                    ...turnInput,
                    message: {
                      ...turnInput.message,
                      text: `Start working toward this goal: ${command.objective}`,
                    },
                  })
                : [],
            );
            if (activation.stopped) return;
            const { goal } = yield* client.request("thread/goal/set", {
              threadId,
              status: "active",
            });
            goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
            if (activation.stopped) {
              const paused = yield* client.request("thread/goal/set", {
                threadId,
                status: "paused",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(paused.goal));
            }
          }).pipe(
            Effect.ensuring(
              turnTerminalizationPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (goalActivations.get(threadId) === activation) {
                    goalActivations.delete(threadId);
                  }
                  if (goalsByNativeThread.get(threadId)?.status !== "active") {
                    yield* releaseGoalHold(threadId);
                  }
                }),
              ),
            ),
          );
        },
        (effect, turnInput) =>
          effect.pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                const threadId = turnInput.providerThread.nativeThreadRef?.nativeId;
                return threadId == null || !goalUpdatesHeld.has(threadId)
                  ? Effect.void
                  : releaseGoalUpdates(threadId);
              }),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: CODEX_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
      );

const mcpAppsError = (detail: string) => (cause: unknown) =>
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CODEX_PROVIDER,
          detail,
          payload: cause,
        });

const mcpApps: ProviderAdapter.ProviderAdapterV2McpApps = {
        listTools: Effect.fn("CodexAdapterV2.listTools")(
          function* (toolsInput) {
            const threadId = yield* getNativeThreadId(toolsInput.providerThread);
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(
                client.request("mcpServerStatus/list", {
                  threadId,
                  serverName: toolsInput.server,
                  detail: "toolsAndAuthOnly",
                }),
              ),
            );
            const server = response.data.find((entry) => entry.name === toolsInput.server);
            return Object.values(server?.tools ?? {});
          },
          Effect.mapError(mcpAppsError("Failed to list Codex MCP tools.")),
        ),
        callTool: Effect.fn("CodexAdapterV2.callTool")(
          function* (callInput) {
            const threadId = yield* getNativeThreadId(callInput.providerThread);
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(
                client.request("mcpServer/tool/call", {
                  threadId,
                  server: callInput.server,
                  tool: callInput.tool,
                  arguments: callInput.arguments as Schema.Json,
                }),
              ),
            );
            return {
              content: response.content,
              ...(response.structuredContent === undefined
                ? {}
                : { structuredContent: response.structuredContent }),
              ...(response.isError === true ? { isError: true } : {}),
              ...(response._meta === undefined ? {} : { _meta: response._meta }),
            };
          },
          Effect.mapError(mcpAppsError("Codex MCP tool call failed.")),
        ),
        readResource: Effect.fn("CodexAdapterV2.readResource")(
          function* (readInput) {
            const threadId = yield* getNativeThreadId(readInput.providerThread);
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(
                client.request("mcpServer/resource/read", {
                  threadId,
                  server: readInput.server,
                  uri: readInput.uri,
                }),
              ),
            );
            return { contents: response.contents };
          },
          Effect.mapError(mcpAppsError("Codex MCP resource read failed.")),
        ),
      };

  return { retryCapacityFailure, completeGoalCommandTurn, heldGoalTurn, resolveGoalStopTarget, resumeNativeThread, runGoalCommand, mcpAppsError, mcpApps };
});

export type RetryCapacityFailurePart = ReturnType<typeof installRetryCapacityFailure> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRetryCapacityFailure>;
