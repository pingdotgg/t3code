/**
 * WorkflowEngine - Orchestrates multi-agent workflows.
 *
 * Executes JSON-defined workflows with multiple phases and tasks,
 * supporting sequential, parallel, and pipeline execution modes.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Array from "effect/Array";
import type {
  WorkflowDefinition,
  WorkflowExecutionResult,
  WorkflowPhaseResult,
  WorkflowTaskResult,
  WorkflowTask,
  WorkflowPhase,
} from "./WorkflowSchema.ts";
import { createUnifiedSubAgentToolHandler } from "../integration.ts";
import type { ThreadId, ProviderInstanceId } from "@t3tools/contracts";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface WorkflowExecutionContext {
  readonly workflowId: string;
  readonly callerThreadId: ThreadId;
  readonly callerProviderInstanceId: ProviderInstanceId;
  readonly variables: Map<string, string>;
}

export interface WorkflowEngineShape {
  readonly execute: (
    definition: WorkflowDefinition,
    context: WorkflowExecutionContext,
  ) => Effect.Effect<WorkflowExecutionResult, WorkflowError>;

  readonly cancel: (workflowId: string) => Effect.Effect<void, WorkflowError>;
}

export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()(
  "t3/subagent/WorkflowEngine",
) {}

const makeWorkflowEngine = Effect.gen(function* () {
  // Active workflow tracking
  const activeWorkflows = new Map<string, boolean>();

  const executeTask = (
    task: WorkflowTask,
    context: WorkflowExecutionContext,
    phaseResults: Map<string, WorkflowTaskResult>,
  ): Effect.Effect<WorkflowTaskResult, WorkflowError> =>
    Effect.gen(function* () {
      const startTime = Date.now();
      const handler = createUnifiedSubAgentToolHandler({
        threadId: context.callerThreadId,
        providerInstanceId: context.callerProviderInstanceId,
      });

      try {
        // Resolve dependencies - replace {{taskId}} with results
        let resolvedPrompt = task.prompt ?? "";
        if (task.dependencies) {
          for (const depId of task.dependencies) {
            const depResult = phaseResults.get(depId);
            if (depResult?.result) {
              resolvedPrompt = resolvedPrompt.replace(
                new RegExp(`\\{\\{${depId}\\}\\}`, "g"),
                depResult.result,
              );
            }
          }
        }

        // Also resolve from variables
        for (const [key, value] of context.variables.entries()) {
          resolvedPrompt = resolvedPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
        }

        switch (task.type) {
          case "spawn": {
            if (!task.provider || !resolvedPrompt) {
              throw new WorkflowError(
                `Task ${task.id}: spawn requires provider and prompt`,
                "INVALID_TASK",
              );
            }

            const spawnResult = yield* handler({
              action: "spawn",
              providerInstanceId: task.provider,
              model: task.model,
              prompt: resolvedPrompt,
            });

            return {
              taskId: task.id,
              status: "completed" as const,
              threadId: spawnResult.threadId,
              result: `Spawned on ${task.provider}`,
              startedAt: new Date(startTime).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - startTime,
            };
          }

          case "wait": {
            // Get threadId from dependencies
            const depThreadId = task.dependencies?.[0]
              ? phaseResults.get(task.dependencies[0])?.threadId
              : undefined;

            if (!depThreadId) {
              throw new WorkflowError(
                `Task ${task.id}: wait requires threadId from dependency`,
                "INVALID_TASK",
              );
            }

            const waitResult = yield* handler({
              action: "wait",
              threadId: depThreadId,
              timeoutSeconds: task.timeout ?? 60,
            });

            return {
              taskId: task.id,
              status: waitResult.status === "completed" ? "completed" : "failed",
              threadId: depThreadId,
              result: waitResult.finalText ?? "No result",
              startedAt: new Date(startTime).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - startTime,
            };
          }

          case "send": {
            const depThreadId = task.dependencies?.[0]
              ? phaseResults.get(task.dependencies[0])?.threadId
              : undefined;

            if (!depThreadId || !resolvedPrompt) {
              throw new WorkflowError(
                `Task ${task.id}: send requires threadId and prompt`,
                "INVALID_TASK",
              );
            }

            yield* handler({
              action: "send",
              threadId: depThreadId,
              prompt: resolvedPrompt,
            });

            return {
              taskId: task.id,
              status: "completed" as const,
              threadId: depThreadId,
              result: "Sent message",
              startedAt: new Date(startTime).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - startTime,
            };
          }

          case "aggregate": {
            // Aggregate results from dependencies
            const results: string[] = [];
            if (task.dependencies) {
              for (const depId of task.dependencies) {
                const depResult = phaseResults.get(depId);
                if (depResult?.result) {
                  results.push(`${depId}: ${depResult.result}`);
                }
              }
            }

            return {
              taskId: task.id,
              status: "completed" as const,
              result: results.join("\n\n"),
              startedAt: new Date(startTime).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - startTime,
            };
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Handle retry
        if (task.retryPolicy && task.onError === "retry") {
          // TODO: Implement retry logic
        }

        if (task.onError === "continue") {
          return {
            taskId: task.id,
            status: "failed" as const,
            error: errorMessage,
            startedAt: new Date(startTime).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
          };
        }

        throw new WorkflowError(`Task ${task.id} failed: ${errorMessage}`, "TASK_FAILED");
      }
    });

  const executePhase = (
    phase: WorkflowPhase,
    context: WorkflowExecutionContext,
    allResults: Map<string, WorkflowTaskResult>,
  ): Effect.Effect<WorkflowPhaseResult, WorkflowError> =>
    Effect.gen(function* () {
      const startTime = Date.now();
      const phaseResults: WorkflowTaskResult[] = [];

      switch (phase.execution) {
        case "sequential": {
          // Execute tasks one by one
          for (const task of phase.tasks) {
            // Check dependencies
            if (task.dependencies) {
              for (const depId of task.dependencies) {
                if (!allResults.has(depId)) {
                  throw new WorkflowError(
                    `Task ${task.id} depends on ${depId} which hasn't run yet`,
                    "DEPENDENCY_ERROR",
                  );
                }
              }
            }

            const result = yield* executeTask(task, context, allResults);
            phaseResults.push(result);
            allResults.set(task.id, result);

            if (result.status === "failed") {
              return {
                phaseId: phase.id,
                status: "failed" as const,
                tasks: phaseResults,
                startedAt: new Date(startTime).toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: Date.now() - startTime,
              };
            }
          }
          break;
        }

        case "parallel": {
          // Execute all tasks concurrently
          const taskEffects = phase.tasks.map((task) => executeTask(task, context, allResults));

          const results = yield* Effect.all(taskEffects, { concurrency: "unbounded" });

          phaseResults.push(...results);
          for (const result of results) {
            allResults.set(result.taskId, result);
          }
          break;
        }

        case "pipeline": {
          // Execute tasks in pipeline mode - each result flows to next
          for (const task of phase.tasks) {
            const result = yield* executeTask(task, context, allResults);
            phaseResults.push(result);
            allResults.set(task.id, result);
          }
          break;
        }
      }

      return {
        phaseId: phase.id,
        status: phaseResults.every((r) => r.status === "completed") ? "completed" : "failed",
        tasks: phaseResults,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      };
    });

  const execute: WorkflowEngineShape["execute"] = (definition, context) =>
    Effect.gen(function* () {
      const startTime = Date.now();
      activeWorkflows.set(context.workflowId, true);

      const phaseResults: WorkflowPhaseResult[] = [];
      const allTaskResults = new Map<string, WorkflowTaskResult>();

      try {
        // Execute phases sequentially
        for (const phase of definition.phases) {
          if (!activeWorkflows.get(context.workflowId)) {
            throw new WorkflowError("Workflow cancelled", "CANCELLED");
          }

          const phaseResult = yield* executePhase(phase, context, allTaskResults);
          phaseResults.push(phaseResult);

          if (phaseResult.status === "failed") {
            break;
          }
        }

        const allTaskResultsArray = Array.fromIterable(allTaskResults.values());
        const completedTasks = allTaskResultsArray.filter((r) => r.status === "completed").length;
        const failedTasks = allTaskResultsArray.filter((r) => r.status === "failed").length;
        const totalTokens = allTaskResultsArray.reduce((sum, r) => sum + (r.tokens ?? 0), 0);

        return {
          workflowId: context.workflowId,
          name: definition.name,
          status: phaseResults.every((p) => p.status === "completed") ? "completed" : "failed",
          phases: phaseResults,
          startedAt: new Date(startTime).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          metrics: {
            totalDurationMs: Date.now() - startTime,
            totalTokens,
            totalTasks: allTaskResultsArray.length,
            completedTasks,
            failedTasks,
          },
        };
      } finally {
        activeWorkflows.delete(context.workflowId);
      }
    });

  const cancel: WorkflowEngineShape["cancel"] = (workflowId) =>
    Effect.sync(() => {
      activeWorkflows.delete(workflowId);
    });

  return WorkflowEngine.of({ execute, cancel });
});

export const WorkflowEngineLive = Layer.effect(WorkflowEngine, makeWorkflowEngine);
