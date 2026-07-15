/**
 * WorkflowEngine - Orchestrates multi-agent workflows.
 *
 * Executes JSON-defined workflows with multiple phases and tasks,
 * supporting sequential, dependency-aware parallel, and pipeline modes.
 */
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type SubAgentError,
  type SubAgentSendInput,
  type SubAgentSendResult,
  type SubAgentSpawnInput,
  type SubAgentSpawnResult,
  type SubAgentWaitInput,
  type SubAgentWaitResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ConcurrencyLimits } from "../ConcurrencyLimits.ts";
import { SubAgentProviderRegistry } from "../SubAgentProviderRegistry.ts";
import { handleSend, handleSpawn, handleWait } from "../UnifiedSubAgentHandlers.ts";
import {
  UniversalSubAgentCoordinator,
  type UniversalSubAgentContext,
} from "../UniversalSubAgentCoordinator.ts";
import type {
  WorkflowDefinition,
  WorkflowExecutionResult,
  WorkflowPhase,
  WorkflowPhaseResult,
  WorkflowTask,
  WorkflowTaskResult,
} from "./WorkflowSchema.ts";

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()("WorkflowError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export interface WorkflowExecutionContext {
  readonly workflowId: string;
  readonly callerThreadId: ThreadId;
  readonly callerProviderInstanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
  readonly variables: Map<string, string>;
}

type WorkflowHandlerRequirements =
  | ConcurrencyLimits
  | SubAgentProviderRegistry
  | UniversalSubAgentCoordinator;

export interface WorkflowTaskHandlers<R = WorkflowHandlerRequirements> {
  readonly spawn: (
    context: UniversalSubAgentContext,
    input: SubAgentSpawnInput,
  ) => Effect.Effect<SubAgentSpawnResult, SubAgentError, R>;
  readonly send: (
    context: UniversalSubAgentContext,
    input: SubAgentSendInput,
  ) => Effect.Effect<SubAgentSendResult, SubAgentError, R>;
  readonly wait: (
    context: UniversalSubAgentContext,
    input: SubAgentWaitInput,
  ) => Effect.Effect<SubAgentWaitResult, SubAgentError, R>;
}

export interface WorkflowEngineShape<R = WorkflowHandlerRequirements> {
  readonly execute: (
    definition: WorkflowDefinition,
    context: WorkflowExecutionContext,
  ) => Effect.Effect<WorkflowExecutionResult, WorkflowError, R>;
  readonly cancel: (workflowId: string) => Effect.Effect<void, WorkflowError>;
}

export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()(
  "t3/subagent/workflows/WorkflowEngine",
) {}

const workflowError = (message: string, code: string) => new WorkflowError({ message, code });

const literalReplace = (value: string, key: string, replacement: string): string =>
  value.split(`{{${key}}}`).join(replacement);

const defaultHandlers: WorkflowTaskHandlers = {
  spawn: handleSpawn,
  send: handleSend,
  wait: handleWait,
};

export const makeWorkflowEngine = <R>(
  handlers: WorkflowTaskHandlers<R>,
): WorkflowEngineShape<R> => {
  const activeWorkflows = new Map<string, Deferred.Deferred<void>>();

  const cancellationEffect = (signal: Deferred.Deferred<void>) =>
    Deferred.await(signal).pipe(
      Effect.flatMap(() => workflowError("Workflow cancelled", "CANCELLED")),
    );

  const withCancellation = <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
    signal: Deferred.Deferred<void>,
  ): Effect.Effect<A, E | WorkflowError, R2> =>
    Effect.raceFirst(effect, cancellationEffect(signal));

  const executeTask = (
    task: WorkflowTask,
    context: WorkflowExecutionContext,
    allResults: Map<string, WorkflowTaskResult>,
    signal: Deferred.Deferred<void>,
  ): Effect.Effect<WorkflowTaskResult, WorkflowError, R> =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const universalContext: UniversalSubAgentContext = {
        threadId: context.callerThreadId,
        providerInstanceId: context.callerProviderInstanceId,
        environmentId: context.environmentId,
      };

      let resolvedPrompt = "prompt" in task ? task.prompt : "";
      for (const depId of task.dependencies ?? []) {
        const dependency = allResults.get(depId);
        if (dependency?.result !== undefined) {
          resolvedPrompt = literalReplace(resolvedPrompt, depId, dependency.result);
        }
      }
      for (const [key, value] of context.variables) {
        resolvedPrompt = literalReplace(resolvedPrompt, key, value);
      }

      const complete = (
        result: Omit<WorkflowTaskResult, "startedAt" | "completedAt" | "durationMs">,
      ) =>
        Effect.gen(function* () {
          const completedAtMs = yield* Clock.currentTimeMillis;
          return {
            ...result,
            startedAt,
            completedAt: DateTime.formatIso(yield* DateTime.now),
            durationMs: Math.max(0, completedAtMs - startedAtMs),
          } satisfies WorkflowTaskResult;
        });

      const runAttempt: Effect.Effect<WorkflowTaskResult, WorkflowError, R> = Effect.gen(
        function* () {
          switch (task.type) {
            case "spawn": {
              const result = yield* handlers
                .spawn(universalContext, {
                  providerInstanceId: task.provider,
                  prompt: resolvedPrompt,
                  ...(task.model !== undefined ? { model: task.model } : {}),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    workflowError(`Task ${task.id} failed: ${cause.message}`, "TASK_FAILED"),
                  ),
                );
              return yield* complete({
                taskId: task.id,
                status: "completed",
                threadId: result.threadId,
                result: `Spawned on ${task.provider}`,
              });
            }

            case "wait": {
              const dependencyId = task.dependencies[0];
              const threadId = allResults.get(dependencyId)?.threadId;
              if (threadId === undefined) {
                return yield* workflowError(
                  `Task ${task.id}: wait requires a spawned thread from ${dependencyId}`,
                  "INVALID_TASK",
                );
              }
              const result = yield* handlers
                .wait(universalContext, {
                  threadId,
                  ...(task.timeout !== undefined ? { timeoutSeconds: task.timeout } : {}),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    workflowError(`Task ${task.id} failed: ${cause.message}`, "TASK_FAILED"),
                  ),
                );
              return yield* complete({
                taskId: task.id,
                status: result.status === "completed" ? "completed" : "failed",
                threadId,
                result: result.finalText ?? "No result",
              });
            }

            case "send": {
              const dependencyId = task.dependencies[0];
              const threadId = allResults.get(dependencyId)?.threadId;
              if (threadId === undefined) {
                return yield* workflowError(
                  `Task ${task.id}: send requires a spawned thread from ${dependencyId}`,
                  "INVALID_TASK",
                );
              }
              yield* handlers
                .send(universalContext, { threadId, prompt: resolvedPrompt })
                .pipe(
                  Effect.mapError((cause) =>
                    workflowError(`Task ${task.id} failed: ${cause.message}`, "TASK_FAILED"),
                  ),
                );
              return yield* complete({
                taskId: task.id,
                status: "completed",
                threadId,
                result: "Sent message",
              });
            }

            case "aggregate": {
              const results = task.dependencies.flatMap((dependencyId) => {
                const result = allResults.get(dependencyId)?.result;
                return result === undefined ? [] : [`${dependencyId}: ${result}`];
              });
              return yield* complete({
                taskId: task.id,
                status: "completed",
                result: results.join("\n\n"),
              });
            }
          }
        },
      );

      const attempted =
        task.onError === "retry" && task.retryPolicy !== undefined
          ? runAttempt.pipe(
              Effect.retry(
                Schedule.addDelay(Schedule.recurs(task.retryPolicy.maxAttempts - 1), () =>
                  Effect.succeed(Duration.millis(task.retryPolicy!.backoffMs)),
                ),
              ),
            )
          : runAttempt;

      return yield* withCancellation(attempted, signal).pipe(
        Effect.catch((error) =>
          error.code === "CANCELLED" || task.onError !== "continue"
            ? error
            : complete({
                taskId: task.id,
                status: "failed",
                error: error.message,
              }),
        ),
      );
    });

  const executePhase = (
    phase: WorkflowPhase,
    context: WorkflowExecutionContext,
    allResults: Map<string, WorkflowTaskResult>,
    signal: Deferred.Deferred<void>,
    parallelismLimit: number,
  ): Effect.Effect<WorkflowPhaseResult, WorkflowError, R> =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const phaseResults = new Map<string, WorkflowTaskResult>();

      const record = (taskId: string, result: WorkflowTaskResult) => {
        phaseResults.set(taskId, result);
        allResults.set(taskId, result);
      };

      const assertDependenciesReady = (task: WorkflowTask) => {
        const missing = (task.dependencies ?? []).filter(
          (dependencyId) => !allResults.has(dependencyId),
        );
        return missing.length === 0
          ? Effect.void
          : workflowError(
              `Task ${task.id} depends on tasks that have not completed: ${missing.join(", ")}`,
              "DEPENDENCY_ERROR",
            );
      };

      switch (phase.execution) {
        case "sequential":
        case "pipeline": {
          for (const task of phase.tasks) {
            yield* assertDependenciesReady(task);
            const result = yield* executeTask(task, context, allResults, signal);
            record(task.id, result);
          }
          break;
        }

        case "parallel": {
          let pending = [...phase.tasks];
          while (pending.length > 0) {
            const ready = pending.filter((task) =>
              (task.dependencies ?? []).every((dependencyId) => allResults.has(dependencyId)),
            );
            if (ready.length === 0) {
              return yield* workflowError(
                `Parallel phase ${phase.id} has missing or cyclic dependencies`,
                "DEPENDENCY_ERROR",
              );
            }

            const batch = yield* Effect.all(
              ready.map((task) => executeTask(task, context, allResults, signal)),
              { concurrency: parallelismLimit },
            );
            ready.forEach((task, index) => record(task.id, batch[index]!));
            const completedIds = new Set(ready.map((task) => task.id));
            pending = pending.filter((task) => !completedIds.has(task.id));
          }
          break;
        }
      }

      const orderedResults = phase.tasks.flatMap((task) => {
        const result = phaseResults.get(task.id);
        return result === undefined ? [] : [result];
      });
      const completedAtMs = yield* Clock.currentTimeMillis;
      return {
        phaseId: phase.id,
        status: orderedResults.every((result) => result.status === "completed")
          ? "completed"
          : "failed",
        tasks: orderedResults,
        startedAt,
        completedAt: DateTime.formatIso(yield* DateTime.now),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
      };
    });

  const execute: WorkflowEngineShape<R>["execute"] = (definition, context) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const signal = yield* Deferred.make<void>();
      activeWorkflows.set(context.workflowId, signal);

      const phaseResults: WorkflowPhaseResult[] = [];
      const allTaskResults = new Map<string, WorkflowTaskResult>();

      const buildResult = (status: WorkflowExecutionResult["status"]) =>
        Effect.gen(function* () {
          const completedAtMs = yield* Clock.currentTimeMillis;
          const taskResults = [...allTaskResults.values()];
          return {
            workflowId: context.workflowId,
            name: definition.name,
            status,
            phases: phaseResults,
            startedAt,
            completedAt: DateTime.formatIso(yield* DateTime.now),
            durationMs: Math.max(0, completedAtMs - startedAtMs),
            metrics: {
              totalDurationMs: Math.max(0, completedAtMs - startedAtMs),
              totalTokens: taskResults.reduce((sum, result) => sum + (result.tokens ?? 0), 0),
              totalTasks: taskResults.length,
              completedTasks: taskResults.filter((result) => result.status === "completed").length,
              failedTasks: taskResults.filter((result) => result.status === "failed").length,
            },
          } satisfies WorkflowExecutionResult;
        });

      const program = Effect.gen(function* () {
        for (const phase of definition.phases) {
          const phaseResult = yield* withCancellation(
            executePhase(phase, context, allTaskResults, signal, definition.parallelismLimit ?? 10),
            signal,
          );
          phaseResults.push(phaseResult);
          if (phaseResult.status === "failed") break;
        }
        return yield* buildResult(
          phaseResults.every((phase) => phase.status === "completed") ? "completed" : "failed",
        );
      });

      return yield* program.pipe(
        Effect.catch((error) => (error.code === "CANCELLED" ? buildResult("cancelled") : error)),
        Effect.ensuring(
          Effect.sync(() => {
            activeWorkflows.delete(context.workflowId);
          }),
        ),
      );
    });

  const cancel: WorkflowEngineShape<R>["cancel"] = (workflowId) =>
    Effect.gen(function* () {
      const signal = activeWorkflows.get(workflowId);
      if (signal !== undefined) {
        yield* Deferred.succeed(signal, undefined);
      }
    });

  return { execute, cancel };
};

export const WorkflowEngineLive = Layer.succeed(
  WorkflowEngine,
  WorkflowEngine.of(makeWorkflowEngine(defaultHandlers)),
);
