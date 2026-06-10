import type {
  OrchestrationCommand,
  OrchestrationQueuedTurn,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function threadHasInFlightTurn(thread: OrchestrationThread): boolean {
  if (thread.latestTurn?.state === "running") {
    return true;
  }

  if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
    return true;
  }

  const latestMessage = thread.messages.at(-1);
  if (latestMessage?.role !== "user") {
    return false;
  }
  if (thread.latestTurn === null || thread.latestTurn.completedAt === null) {
    return true;
  }
  return latestMessage.createdAt >= thread.latestTurn.completedAt;
}

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

function threadHasUnresolvedActivity(
  thread: OrchestrationThread,
  requestedKind: string,
  resolvedKind: string,
): boolean {
  const pending = new Set<string>();
  for (const activity of thread.activities
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) continue;
    if (activity.kind === requestedKind) {
      pending.add(requestId);
    } else if (activity.kind === resolvedKind) {
      pending.delete(requestId);
    }
  }
  return pending.size > 0;
}

export function threadHasPendingInteraction(thread: OrchestrationThread): boolean {
  return (
    threadHasUnresolvedActivity(thread, "approval.requested", "approval.resolved") ||
    threadHasUnresolvedActivity(thread, "user-input.requested", "user-input.resolved")
  );
}

export function isThreadReadyForQueuedDispatch(thread: OrchestrationThread): boolean {
  return !threadHasInFlightTurn(thread) && !threadHasPendingInteraction(thread);
}

export function findQueuedTurnById(
  thread: OrchestrationThread,
  queuedTurnId: string,
): OrchestrationQueuedTurn | undefined {
  return (thread.queuedTurns ?? []).find((queuedTurn) => queuedTurn.id === queuedTurnId);
}

export function requireQueuedTurn(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
  readonly queuedTurnId: string;
}): Effect.Effect<
  { readonly thread: OrchestrationThread; readonly queuedTurn: OrchestrationQueuedTurn },
  OrchestrationCommandInvariantError
> {
  return requireThread({
    readModel: input.readModel,
    command: input.command,
    threadId: input.threadId,
  }).pipe(
    Effect.flatMap((thread) => {
      const queuedTurn = findQueuedTurnById(thread, input.queuedTurnId);
      return queuedTurn
        ? Effect.succeed({ thread, queuedTurn })
        : Effect.fail(
            invariantError(
              input.command.type,
              `Queued turn '${input.queuedTurnId}' does not exist on thread '${input.threadId}'.`,
            ),
          );
    }),
  );
}

export function requireThreadReadyForTurnStart(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      threadHasInFlightTurn(thread)
        ? Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' already has a turn in flight. Wait for it to finish or interrupt it before starting another turn.`,
            ),
          )
        : Effect.succeed(thread),
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
