import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderOptionDescriptor,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export class OperatorError extends Schema.TaggedErrorClass<OperatorError>()("OperatorError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "disabled",
    "not-found",
    "invalid-model",
    "invalid-options",
    "invalid-task",
    "workspace-failed",
    "dispatch-failed",
    "read-failed",
  ]),
  detail: Schema.String,
}) {}

const isOperatorError = Schema.is(OperatorError);

export interface OperatorSpawnTask {
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
}

export interface OperatorSpawnInput {
  readonly coordinatorThreadId: ThreadId;
  readonly tasks: ReadonlyArray<OperatorSpawnTask>;
  readonly workspaceMode: "operator" | "current" | "new-worktree";
  readonly branch?: string | undefined;
  readonly baseBranch?: string | undefined;
}

export interface OperatorTaskStatus {
  readonly taskId: ThreadId;
  readonly batchId: string | null;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly status: "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly result: string | null;
  readonly error: string | null;
}

export interface OperatorModelInventory {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly capabilities: {
      readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
    } | null;
  }>;
}

export interface OperatorSpawnResult {
  readonly batchId: string;
  readonly workspacePath: string;
  readonly branch: string | null;
  readonly tasks: ReadonlyArray<OperatorTaskStatus>;
}

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

function providerIsAvailable(provider: {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly auth: { readonly status: string };
  readonly availability?: string | undefined;
}): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
  );
}

function validateSelectionOptions(
  selection: ModelSelection,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string | null {
  for (const option of selection.options ?? []) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) {
      return `Option '${option.id}' is not supported by model '${selection.model}'.`;
    }
    if (descriptor.type === "boolean") {
      if (typeof option.value !== "boolean") {
        return `Option '${option.id}' requires a boolean value.`;
      }
      continue;
    }
    if (typeof option.value !== "string") {
      return `Option '${option.id}' requires a string value.`;
    }
    const isChoice = descriptor.options.some((choice) => choice.id === option.value);
    const isPromptInjected = descriptor.promptInjectedValues?.includes(option.value) === true;
    if (!isChoice && !isPromptInjected) {
      return `Value '${option.value}' is not valid for option '${option.id}'.`;
    }
  }
  return null;
}

function deriveTaskStatus(
  thread: OrchestrationThread,
  shell: OrchestrationThreadShell,
): OperatorTaskStatus {
  const latestAssistantMessage = thread.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming,
  );
  const waiting = shell.hasPendingApprovals || shell.hasPendingUserInput;
  const latestTurn = thread.latestTurn;
  const status: OperatorTaskStatus["status"] = waiting
    ? "waiting"
    : latestTurn?.state === "completed"
      ? "completed"
      : latestTurn?.state === "error" || thread.session?.status === "error"
        ? "failed"
        : latestTurn?.state === "interrupted" ||
            thread.session?.status === "interrupted" ||
            thread.session?.status === "stopped"
          ? "stopped"
          : latestTurn === null
            ? "queued"
            : "running";

  return {
    taskId: thread.id,
    batchId: thread.operatorBatchId ?? null,
    title: thread.title,
    modelSelection: thread.modelSelection,
    status,
    startedAt: latestTurn?.startedAt ?? latestTurn?.requestedAt ?? thread.createdAt,
    completedAt: latestTurn?.completedAt ?? null,
    result: latestAssistantMessage?.text ?? null,
    error: status === "failed" ? (thread.session?.lastError ?? "The task failed.") : null,
  };
}

function isSettled(status: OperatorTaskStatus["status"]): boolean {
  return (
    status === "waiting" || status === "completed" || status === "failed" || status === "stopped"
  );
}

const CHILD_TASK_INSTRUCTIONS = `

<operator-task>
You are a top-level T3 Code task created by Agentic Operator. You are not a native subagent. Work only on the scope assigned above.
Other Operator tasks may edit this same checkout concurrently, so preserve unrelated changes and never overwrite their work.
Stay in the assigned checkout and branch. Do not create, switch, or remove worktrees or branches.
Do not commit, push, or open a pull request unless the task explicitly asks for it.
Run focused verification for your scope. End with a concise handoff covering what changed, validation, and anything the integrating task must know.
</operator-task>`;

export class OperatorService extends Context.Service<
  OperatorService,
  {
    readonly listModels: (
      coordinatorThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OperatorModelInventory>, OperatorError>;
    readonly spawn: (
      input: OperatorSpawnInput,
    ) => Effect.Effect<OperatorSpawnResult, OperatorError>;
    readonly status: (
      coordinatorThreadId: ThreadId,
      taskIds?: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<OperatorTaskStatus>, OperatorError>;
    readonly wait: (
      coordinatorThreadId: ThreadId,
      taskIds?: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<OperatorTaskStatus>, OperatorError>;
  }
>()("t3/operator/OperatorService") {
  static readonly layer = Layer.effect(
    OperatorService,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const providers = yield* ProviderRegistry;
      const git = yield* GitWorkflowService;
      const setupScripts = yield* ProjectSetupScriptRunner;
      const settings = yield* ServerSettingsService;

      const randomUuid = crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (error) =>
            new OperatorError({
              operation: "identifier",
              reason: "dispatch-failed",
              detail: errorDetail(error),
            }),
        ),
      );
      const commandId = (operation: string) =>
        randomUuid.pipe(Effect.map((uuid) => CommandId.make(`operator:${operation}:${uuid}`)));
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      const getCoordinator = Effect.fn("OperatorService.getCoordinator")(function* (
        coordinatorThreadId: ThreadId,
      ) {
        const serverSettings = yield* settings.getSettings.pipe(
          Effect.mapError(
            (error) =>
              new OperatorError({
                operation: "read-settings",
                reason: "read-failed",
                detail: errorDetail(error),
              }),
          ),
        );
        if (!serverSettings.agenticOperatorEnabled) {
          return yield* new OperatorError({
            operation: "authorize",
            reason: "disabled",
            detail:
              "Agentic Operator is disabled. Enable it in Settings > Agentic Operator before using Operator tools.",
          });
        }
        const coordinator = yield* query.getThreadDetailById(coordinatorThreadId).pipe(
          Effect.mapError(
            (error) =>
              new OperatorError({
                operation: "read-coordinator",
                reason: "read-failed",
                detail: errorDetail(error),
              }),
          ),
        );
        if (Option.isNone(coordinator)) {
          return yield* new OperatorError({
            operation: "read-coordinator",
            reason: "not-found",
            detail: `Coordinator thread '${coordinatorThreadId}' was not found.`,
          });
        }
        return coordinator.value;
      });

      const listModels = Effect.fn("OperatorService.listModels")(function* (
        coordinatorThreadId: ThreadId,
      ) {
        yield* getCoordinator(coordinatorThreadId);
        return (yield* providers.getProviders).filter(providerIsAvailable).map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? provider.instanceId,
          available: true,
          models: provider.models.map((model) => ({
            slug: model.slug,
            name: model.name,
            capabilities: model.capabilities,
          })),
        }));
      });

      const validateTasks = Effect.fn("OperatorService.validateTasks")(function* (
        tasks: ReadonlyArray<OperatorSpawnTask>,
      ) {
        const snapshots = yield* providers.getProviders;
        for (const task of tasks) {
          const provider = snapshots.find(
            (candidate) => candidate.instanceId === task.modelSelection.instanceId,
          );
          if (!provider || !providerIsAvailable(provider)) {
            return yield* new OperatorError({
              operation: "validate-task",
              reason: "invalid-model",
              detail: `Provider instance '${task.modelSelection.instanceId}' is not available. Call operator_models and choose an available instance.`,
            });
          }
          const model = provider.models.find(
            (candidate) => candidate.slug === task.modelSelection.model,
          );
          if (!model) {
            return yield* new OperatorError({
              operation: "validate-task",
              reason: "invalid-model",
              detail: `Model '${task.modelSelection.model}' is not available on provider instance '${provider.instanceId}'. Call operator_models for exact slugs.`,
            });
          }
          const invalidOption = validateSelectionOptions(
            task.modelSelection,
            model.capabilities?.optionDescriptors ?? [],
          );
          if (invalidOption) {
            return yield* new OperatorError({
              operation: "validate-task",
              reason: "invalid-options",
              detail: invalidOption,
            });
          }
        }
      });

      const getOwnedShells = Effect.fn("OperatorService.getOwnedShells")(function* (
        coordinatorThreadId: ThreadId,
        taskIds?: ReadonlyArray<ThreadId>,
      ) {
        if (taskIds) {
          return yield* Effect.forEach(
            taskIds,
            (taskId) =>
              query.getThreadShellById(taskId).pipe(
                Effect.mapError(
                  (error) =>
                    new OperatorError({
                      operation: "read-task",
                      reason: "read-failed",
                      detail: errorDetail(error),
                    }),
                ),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      new OperatorError({
                        operation: "read-tasks",
                        reason: "invalid-task",
                        detail: `Task '${taskId}' does not belong to this Operator thread.`,
                      }),
                    onSome: (thread) =>
                      thread.operatorParentThreadId === coordinatorThreadId
                        ? Effect.succeed(thread)
                        : new OperatorError({
                            operation: "read-tasks",
                            reason: "invalid-task",
                            detail: `Task '${taskId}' does not belong to this Operator thread.`,
                          }),
                  }),
                ),
              ),
            { concurrency: "unbounded" },
          );
        }
        const shell = yield* query.getShellSnapshot().pipe(
          Effect.mapError(
            (error) =>
              new OperatorError({
                operation: "read-tasks",
                reason: "read-failed",
                detail: errorDetail(error),
              }),
          ),
        );
        const owned = shell.threads.filter(
          (thread) => thread.operatorParentThreadId === coordinatorThreadId,
        );
        return owned;
      });

      const readStatuses = Effect.fn("OperatorService.readStatuses")(function* (
        coordinatorThreadId: ThreadId,
        taskIds?: ReadonlyArray<ThreadId>,
      ) {
        yield* getCoordinator(coordinatorThreadId);
        const shells = yield* getOwnedShells(coordinatorThreadId, taskIds);
        return yield* Effect.forEach(
          shells,
          (shell) =>
            query.getThreadDetailById(shell.id).pipe(
              Effect.mapError(
                (error) =>
                  new OperatorError({
                    operation: "read-task",
                    reason: "read-failed",
                    detail: errorDetail(error),
                  }),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    new OperatorError({
                      operation: "read-task",
                      reason: "not-found",
                      detail: `Operator task '${shell.id}' was not found.`,
                    }),
                  onSome: (thread) => Effect.succeed(deriveTaskStatus(thread, shell)),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
      });

      const spawn = Effect.fn("OperatorService.spawn")(function* (input: OperatorSpawnInput) {
        const coordinator = yield* getCoordinator(input.coordinatorThreadId);
        yield* validateTasks(input.tasks);
        const project = yield* query.getProjectShellById(coordinator.projectId).pipe(
          Effect.mapError(
            (error) =>
              new OperatorError({
                operation: "read-project",
                reason: "read-failed",
                detail: errorDetail(error),
              }),
          ),
        );
        if (Option.isNone(project)) {
          return yield* new OperatorError({
            operation: "read-project",
            reason: "not-found",
            detail: `Project '${coordinator.projectId}' was not found.`,
          });
        }

        let workspacePath: string;
        let branch: string | null;
        if (input.workspaceMode === "new-worktree") {
          if (!input.branch || !input.baseBranch) {
            return yield* new OperatorError({
              operation: "create-worktree",
              reason: "invalid-task",
              detail: "new-worktree mode requires both branch and baseBranch.",
            });
          }
          const worktree = yield* git
            .createWorktree({
              cwd: project.value.workspaceRoot,
              refName: input.baseBranch,
              newRefName: input.branch,
              baseRefName: input.baseBranch,
              path: null,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new OperatorError({
                    operation: "create-worktree",
                    reason: "workspace-failed",
                    detail: errorDetail(error),
                  }),
              ),
            );
          workspacePath = worktree.worktree.path;
          branch = worktree.worktree.refName;
        } else if (input.workspaceMode === "current") {
          workspacePath = coordinator.worktreePath ?? project.value.workspaceRoot;
          branch = coordinator.branch;
        } else {
          workspacePath =
            coordinator.operatorWorkspacePath ??
            coordinator.worktreePath ??
            project.value.workspaceRoot;
          branch = coordinator.operatorWorkspaceBranch ?? coordinator.branch;
        }

        if (
          coordinator.operatorWorkspacePath !== workspacePath ||
          coordinator.operatorWorkspaceBranch !== branch
        ) {
          yield* engine
            .dispatch({
              type: "thread.meta.update",
              commandId: yield* commandId("remember-workspace"),
              threadId: coordinator.id,
              operatorWorkspacePath: workspacePath,
              operatorWorkspaceBranch: branch,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new OperatorError({
                    operation: "remember-workspace",
                    reason: "dispatch-failed",
                    detail: errorDetail(error),
                  }),
              ),
            );
        }

        const batchId = yield* randomUuid;
        const createdAt = yield* nowIso;
        const pendingTasks = yield* Effect.forEach(input.tasks, (task) =>
          Effect.gen(function* () {
            const taskId = ThreadId.make(yield* randomUuid);
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: yield* commandId("create-task"),
                threadId: taskId,
                projectId: coordinator.projectId,
                title: task.title,
                modelSelection: task.modelSelection,
                runtimeMode: coordinator.runtimeMode,
                interactionMode: "default",
                branch,
                worktreePath: workspacePath,
                operatorParentThreadId: coordinator.id,
                operatorBatchId: batchId,
                createdAt,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OperatorError({
                      operation: "create-task",
                      reason: "dispatch-failed",
                      detail: errorDetail(error),
                    }),
                ),
              );
            return { task, taskId };
          }),
        );

        if (input.workspaceMode === "new-worktree") {
          const setupThread = pendingTasks[0];
          if (setupThread) {
            yield* setupScripts
              .runForThread({
                threadId: setupThread.taskId,
                projectId: coordinator.projectId,
                projectCwd: project.value.workspaceRoot,
                worktreePath: workspacePath,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Operator worktree setup script failed", {
                    threadId: setupThread.taskId,
                    worktreePath: workspacePath,
                    cause: error,
                  }),
                ),
              );
          }
        }

        yield* Effect.forEach(
          pendingTasks,
          ({ task, taskId }) =>
            Effect.gen(function* () {
              const turnCreatedAt = yield* nowIso;
              yield* engine.dispatch({
                type: "thread.turn.start",
                commandId: yield* commandId("start-task"),
                threadId: taskId,
                message: {
                  messageId: MessageId.make(yield* randomUuid),
                  role: "user",
                  text: `${task.prompt.trim()}${CHILD_TASK_INSTRUCTIONS}`,
                  attachments: [],
                },
                modelSelection: task.modelSelection,
                runtimeMode: coordinator.runtimeMode,
                interactionMode: "default",
                createdAt: turnCreatedAt,
              });
            }).pipe(
              Effect.mapError((error) =>
                isOperatorError(error)
                  ? error
                  : new OperatorError({
                      operation: "start-task",
                      reason: "dispatch-failed",
                      detail: errorDetail(error),
                    }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );

        const tasks = yield* readStatuses(
          coordinator.id,
          pendingTasks.map(({ taskId }) => taskId),
        );
        return { batchId, workspacePath, branch, tasks };
      });

      const status = Effect.fn("OperatorService.status")(function* (
        coordinatorThreadId: ThreadId,
        taskIds?: ReadonlyArray<ThreadId>,
      ) {
        return yield* readStatuses(coordinatorThreadId, taskIds);
      });

      const setWaitStartedAt = Effect.fn("OperatorService.setWaitStartedAt")(function* (
        coordinatorThreadId: ThreadId,
        startedAt: string | null,
      ) {
        yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId(startedAt === null ? "finish-wait" : "start-wait"),
            threadId: coordinatorThreadId,
            operatorWaitStartedAt: startedAt,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OperatorError({
                  operation: startedAt === null ? "finish-wait" : "start-wait",
                  reason: "dispatch-failed",
                  detail: errorDetail(error),
                }),
            ),
          );
      });

      const wait = Effect.fn("OperatorService.wait")(function* (
        coordinatorThreadId: ThreadId,
        taskIds?: ReadonlyArray<ThreadId>,
      ) {
        const selectedIds =
          taskIds ?? (yield* getOwnedShells(coordinatorThreadId)).map((t) => t.id);
        if (selectedIds.length === 0) {
          return [];
        }
        const cursor = yield* engine.latestSequence;
        const initial = yield* readStatuses(coordinatorThreadId, selectedIds);
        if (initial.every((task) => isSettled(task.status))) {
          return initial;
        }

        yield* setWaitStartedAt(coordinatorThreadId, yield* nowIso);
        return yield* Effect.gen(function* () {
          const selected = new Set<string>(selectedIds);
          const relevant = (event: { readonly aggregateId: string }) =>
            selected.has(event.aggregateId);
          const eventTriggers = Stream.merge(
            engine.readEvents(cursor, Number.MAX_SAFE_INTEGER).pipe(
              Stream.filter(relevant),
              Stream.mapError(
                (error) =>
                  new OperatorError({
                    operation: "wait",
                    reason: "read-failed",
                    detail: errorDetail(error),
                  }),
              ),
            ),
            engine.streamDomainEvents.pipe(Stream.filter(relevant)),
          );
          const completed = yield* eventTriggers.pipe(
            Stream.mapEffect(() => readStatuses(coordinatorThreadId, selectedIds)),
            Stream.filter((tasks) => tasks.every((task) => isSettled(task.status))),
            Stream.runHead,
          );
          if (Option.isNone(completed)) {
            return yield* new OperatorError({
              operation: "wait",
              reason: "read-failed",
              detail: "The Operator event stream ended before the tasks settled.",
            });
          }
          return completed.value;
        }).pipe(
          Effect.ensuring(
            setWaitStartedAt(coordinatorThreadId, null).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Failed to clear Operator wait state", {
                  coordinatorThreadId,
                  cause: error,
                }),
              ),
            ),
          ),
        );
      });

      return OperatorService.of({ listModels, spawn, status, wait });
    }),
  );
}
