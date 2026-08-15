import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
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
import * as Ref from "effect/Ref";
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

export interface OperatorResumeTask {
  readonly taskId: ThreadId;
  readonly prompt: string;
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
  const latestTurn = thread.latestTurn;
  const latestAssistantMessage =
    latestTurn === null
      ? undefined
      : thread.messages.findLast(
          (message) =>
            message.role === "assistant" &&
            !message.streaming &&
            message.turnId === latestTurn.turnId,
        );
  const waiting = shell.hasPendingApprovals || shell.hasPendingUserInput;
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
    result: status === "completed" ? (latestAssistantMessage?.text ?? null) : null,
    error: status === "failed" ? (thread.session?.lastError ?? "The task failed.") : null,
  };
}

function isSettled(status: OperatorTaskStatus["status"]): boolean {
  return (
    status === "waiting" || status === "completed" || status === "failed" || status === "stopped"
  );
}

function isResumable(status: OperatorTaskStatus["status"]): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function canStillSettle(shell: OrchestrationThreadShell): boolean {
  return (
    shell.latestUserMessageAt !== null ||
    shell.latestTurn !== null ||
    shell.session !== null ||
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput
  );
}

function canChangeTaskStatus(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
    case "thread.session-set":
    case "thread.turn-diff-completed":
      return true;
    case "thread.message-sent":
      return !event.payload.streaming;
    case "thread.activity-appended":
      return (
        event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "approval.resolved" ||
        event.payload.activity.kind === "user-input.requested" ||
        event.payload.activity.kind === "user-input.resolved" ||
        event.payload.activity.kind === "provider.approval.respond.failed" ||
        event.payload.activity.kind === "provider.user-input.respond.failed"
      );
    default:
      return false;
  }
}

const CHILD_TASK_INSTRUCTIONS = `

<operator-task>
You are a top-level T3 Code task created by Operator. You are not a native subagent. Work only on the scope assigned above.
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
    readonly resume: (
      coordinatorThreadId: ThreadId,
      tasks: ReadonlyArray<OperatorResumeTask>,
    ) => Effect.Effect<ReadonlyArray<OperatorTaskStatus>, OperatorError>;
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
              "Operator is disabled. Enable it in Settings > Operator before using Operator tools.",
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

      const readShellStatuses = Effect.fn("OperatorService.readShellStatuses")(function* (
        shells: ReadonlyArray<OrchestrationThreadShell>,
      ) {
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

      const readStatuses = Effect.fn("OperatorService.readStatuses")(function* (
        coordinatorThreadId: ThreadId,
        taskIds?: ReadonlyArray<ThreadId>,
      ) {
        yield* getCoordinator(coordinatorThreadId);
        const shells = yield* getOwnedShells(coordinatorThreadId, taskIds);
        return yield* readShellStatuses(shells);
      });

      const startTurns = Effect.fn("OperatorService.startTurns")(function* (
        coordinatorThreadId: ThreadId,
        tasks: ReadonlyArray<{
          readonly taskId: ThreadId;
          readonly title: string;
          readonly prompt: string;
          readonly modelSelection: ModelSelection;
          readonly runtimeMode: OrchestrationThreadShell["runtimeMode"];
          readonly interactionMode: OrchestrationThreadShell["interactionMode"];
        }>,
        operation: "start-task" | "resume-task",
      ) {
        const startOutcomes = yield* Effect.forEach(
          tasks,
          (task) =>
            Effect.gen(function* () {
              const turnCreatedAt = yield* nowIso;
              yield* engine.dispatch({
                type: "thread.turn.start",
                commandId: yield* commandId(operation),
                threadId: task.taskId,
                message: {
                  messageId: MessageId.make(yield* randomUuid),
                  role: "user",
                  text: `${task.prompt.trim()}${CHILD_TASK_INSTRUCTIONS}`,
                  attachments: [],
                },
                modelSelection: task.modelSelection,
                runtimeMode: task.runtimeMode,
                interactionMode: task.interactionMode,
                createdAt: turnCreatedAt,
              });
              return { _tag: "Started" as const, taskId: task.taskId };
            }).pipe(
              Effect.mapError((error) =>
                isOperatorError(error)
                  ? error
                  : new OperatorError({
                      operation,
                      reason: "dispatch-failed",
                      detail: errorDetail(error),
                    }),
              ),
              Effect.catch((error) =>
                nowIso.pipe(
                  Effect.map((failedAt) => ({
                    _tag: "Failed" as const,
                    taskId: task.taskId,
                    title: task.title,
                    error,
                    failedAt,
                  })),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );

        const failedStarts = startOutcomes.filter((outcome) => outcome._tag === "Failed");
        if (startOutcomes.length > 0 && failedStarts.length === startOutcomes.length) {
          const action = operation === "resume-task" ? "resume" : "start";
          return yield* new OperatorError({
            operation,
            reason: "dispatch-failed",
            detail: `Every Operator task failed to ${action}: ${failedStarts
              .map((outcome) => `${outcome.title}: ${outcome.error.detail}`)
              .join("; ")}`,
          });
        }

        const statuses = yield* readStatuses(
          coordinatorThreadId,
          tasks.map((task) => task.taskId),
        );
        const failedStartByTaskId = new Map(
          failedStarts.map((outcome) => [outcome.taskId, outcome] as const),
        );
        return statuses.map((task) => {
          const failure = failedStartByTaskId.get(task.taskId);
          return failure === undefined
            ? task
            : {
                ...task,
                status: "failed" as const,
                completedAt: failure.failedAt,
                error: failure.error.detail,
              };
        });
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

        const rememberedWorkspace =
          input.workspaceMode !== "current" &&
          (coordinator.operatorWorkspacePath !== workspacePath ||
            coordinator.operatorWorkspaceBranch !== branch);
        if (rememberedWorkspace) {
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

        const restoreRememberedWorkspace = Effect.gen(function* () {
          if (!rememberedWorkspace) return;
          yield* engine
            .dispatch({
              type: "thread.meta.update",
              commandId: yield* commandId("restore-workspace"),
              threadId: coordinator.id,
              operatorWorkspacePath: coordinator.operatorWorkspacePath,
              operatorWorkspaceBranch: coordinator.operatorWorkspaceBranch,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Failed to restore Operator workspace metadata", {
                  threadId: coordinator.id,
                  cause: error,
                }),
              ),
            );
        });
        const retainedWorktreeDetail =
          input.workspaceMode === "new-worktree"
            ? ` The new Operator worktree remains available at '${workspacePath}'${
                branch === null ? "" : ` on branch '${branch}'`
              }.`
            : "";

        const batchId = yield* randomUuid;
        const createdAt = yield* nowIso;
        const createOutcomes = yield* Effect.forEach(input.tasks, (task) =>
          Effect.gen(function* () {
            const taskId = ThreadId.make(yield* randomUuid);
            return yield* Effect.gen(function* () {
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
              return { _tag: "Created" as const, task, taskId };
            }).pipe(
              Effect.catch((error) =>
                nowIso.pipe(
                  Effect.map((failedAt) => ({
                    _tag: "Failed" as const,
                    task,
                    taskId,
                    error,
                    failedAt,
                  })),
                ),
              ),
            );
          }),
        );
        const pendingTasks = createOutcomes.filter((outcome) => outcome._tag === "Created");
        const failedCreates = createOutcomes.filter((outcome) => outcome._tag === "Failed");
        if (input.tasks.length > 0 && pendingTasks.length === 0) {
          yield* restoreRememberedWorkspace;
          return yield* new OperatorError({
            operation: "create-task",
            reason: "dispatch-failed",
            detail: `Every Operator task failed to be created: ${failedCreates
              .map((outcome) => `${outcome.task.title}: ${outcome.error.detail}`)
              .join("; ")}${retainedWorktreeDetail}`,
          });
        }

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

        const cleanupFailedSpawn = Effect.gen(function* () {
          yield* Effect.forEach(
            pendingTasks,
            ({ taskId }) =>
              commandId("cleanup-task").pipe(
                Effect.flatMap((cleanupCommandId) =>
                  engine.dispatch({
                    type: "thread.delete",
                    commandId: cleanupCommandId,
                    threadId: taskId,
                  }),
                ),
                Effect.catch((error) =>
                  Effect.logWarning("Failed to clean up an unstarted Operator task", {
                    threadId: taskId,
                    cause: error,
                  }),
                ),
              ),
            { concurrency: "unbounded" },
          );

          yield* restoreRememberedWorkspace;
        });

        const startedTasks = yield* startTurns(
          coordinator.id,
          pendingTasks.map(({ task, taskId }) => ({
            taskId,
            title: task.title,
            prompt: task.prompt,
            modelSelection: task.modelSelection,
            runtimeMode: coordinator.runtimeMode,
            interactionMode: "default",
          })),
          "start-task",
        ).pipe(
          Effect.catch((error) =>
            error.operation === "start-task" && error.reason === "dispatch-failed"
              ? cleanupFailedSpawn.pipe(
                  Effect.andThen(
                    Effect.fail(
                      retainedWorktreeDetail.length === 0
                        ? error
                        : new OperatorError({
                            operation: error.operation,
                            reason: error.reason,
                            detail: `${error.detail}${retainedWorktreeDetail}`,
                          }),
                    ),
                  ),
                )
              : Effect.fail(error),
          ),
        );
        const startedTaskById = new Map(startedTasks.map((task) => [task.taskId, task] as const));
        const tasks = createOutcomes.map((outcome): OperatorTaskStatus => {
          if (outcome._tag === "Failed") {
            return {
              taskId: outcome.taskId,
              batchId,
              title: outcome.task.title,
              modelSelection: outcome.task.modelSelection,
              status: "failed",
              startedAt: outcome.failedAt,
              completedAt: outcome.failedAt,
              result: null,
              error: outcome.error.detail,
            };
          }
          return startedTaskById.get(outcome.taskId)!;
        });
        return { batchId, workspacePath, branch, tasks };
      });

      const resume = Effect.fn("OperatorService.resume")(function* (
        coordinatorThreadId: ThreadId,
        tasks: ReadonlyArray<OperatorResumeTask>,
      ) {
        yield* getCoordinator(coordinatorThreadId);
        if (tasks.length === 0 || tasks.length > 8) {
          return yield* new OperatorError({
            operation: "resume-task",
            reason: "invalid-task",
            detail: "Resume requires between one and eight Operator tasks.",
          });
        }

        const seenTaskIds = new Set<string>();
        for (const task of tasks) {
          if (task.prompt.trim().length === 0) {
            return yield* new OperatorError({
              operation: "resume-task",
              reason: "invalid-task",
              detail: `Task '${task.taskId}' requires a non-empty resume instruction.`,
            });
          }
          if (seenTaskIds.has(task.taskId)) {
            return yield* new OperatorError({
              operation: "resume-task",
              reason: "invalid-task",
              detail: `Task '${task.taskId}' can only be resumed once per call.`,
            });
          }
          seenTaskIds.add(task.taskId);
        }

        const taskIds = tasks.map((task) => task.taskId);
        const shells = yield* getOwnedShells(coordinatorThreadId, taskIds);
        const statuses = yield* readShellStatuses(shells);
        const unavailable = statuses.find((task) => !isResumable(task.status));
        if (unavailable) {
          return yield* new OperatorError({
            operation: "resume-task",
            reason: "invalid-task",
            detail: `Task '${unavailable.title}' (${unavailable.taskId}) is ${unavailable.status}. Only completed, failed, or stopped Operator tasks can be resumed.`,
          });
        }

        return yield* startTurns(
          coordinatorThreadId,
          shells.map((shell, index) => ({
            taskId: shell.id,
            title: shell.title,
            prompt: tasks[index]!.prompt,
            modelSelection: shell.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
          })),
          "resume-task",
        );
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
        yield* getCoordinator(coordinatorThreadId);
        const selectedIds = (yield* getOwnedShells(coordinatorThreadId, taskIds))
          .filter(canStillSettle)
          .map((task) => task.id);
        if (selectedIds.length === 0) {
          return [];
        }
        const cursor = yield* engine.latestSequence;
        const readSelectedStatuses = getOwnedShells(coordinatorThreadId, selectedIds).pipe(
          Effect.flatMap(readShellStatuses),
        );
        const initial = yield* readSelectedStatuses;
        if (initial.every((task) => isSettled(task.status))) {
          return initial;
        }

        yield* setWaitStartedAt(coordinatorThreadId, yield* nowIso);
        return yield* Effect.gen(function* () {
          const selected = new Set<string>(selectedIds);
          const seenSequences = yield* Ref.make(new Set<number>());
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
          ).pipe(
            Stream.filter(canChangeTaskStatus),
            Stream.filterEffect((event) =>
              Ref.modify(seenSequences, (seen) => {
                if (seen.has(event.sequence)) return [false, seen];
                const next = new Set(seen);
                next.add(event.sequence);
                return [true, next];
              }),
            ),
          );
          const completed = yield* eventTriggers.pipe(
            Stream.mapEffect(() => readSelectedStatuses),
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

      return OperatorService.of({ listModels, spawn, resume, status, wait });
    }),
  );
}
