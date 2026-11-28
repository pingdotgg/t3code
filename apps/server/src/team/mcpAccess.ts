import {
  AuthSessionId,
  OrchestratorMcpFailure,
  type EnvironmentAuthorizationError,
  type EnvironmentId,
  type OrchestrationV2Command,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type TeamMemberId,
  type TeamViewId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as TeamService from "./TeamService.ts";

export interface ResolvedTeamMcpCaller {
  readonly teamService: TeamService.TeamService["Service"];
  readonly actor: TeamService.TeamActor;
  readonly memberId: TeamMemberId | null;
  readonly teamAutomation: McpInvocationContext.McpTeamAutomationPrincipal | null;
  readonly callerThreadId: ThreadId | undefined;
}

const toMcpForbidden = (error: EnvironmentAuthorizationError) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: error.message,
  });

const forbiddenFailure = (message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message,
  });

/**
 * Resolves the team member bound to the current MCP invocation when the server has an active team.
 * Returns `Option.none()` in personal mode (or when `TeamService` is not mounted).
 * Fails closed with `OrchestratorMcpFailure(forbidden)` whenever a team is configured and the caller
 * is not bound to an active team member.
 */
const resolveTeamMcpCaller = Effect.fn("TeamMcpAccess.resolveTeamMcpCaller")(function* () {
  const teamOption = yield* Effect.serviceOption(TeamService.TeamService);
  if (Option.isNone(teamOption)) {
    return Option.none<ResolvedTeamMcpCaller>();
  }
  const teamService = teamOption.value;
  if (!(yield* teamService.isTeamConfigured())) {
    return Option.none<ResolvedTeamMcpCaller>();
  }
  const scopeOption = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  if (Option.isNone(scopeOption)) {
    return yield* forbiddenFailure("Missing MCP invocation context for team authorization.");
  }
  const scope = scopeOption.value;
  if (scope.thread !== undefined && scope.thread !== null) {
    // Team agent tokens must carry either an immutable teamAutomation principal or actingMemberId.
    if (scope.thread.teamAutomation !== undefined) {
      const actor: TeamService.TeamActor = {
        kind: "team_automation",
        principal: scope.thread.teamAutomation,
      };
      yield* teamService.assertActorIsActiveMember(actor).pipe(Effect.mapError(toMcpForbidden));
      return Option.some<ResolvedTeamMcpCaller>({
        teamService,
        actor,
        memberId: null,
        teamAutomation: scope.thread.teamAutomation,
        callerThreadId: scope.thread.threadId,
      });
    }
    const memberId = scope.thread.actingMemberId;
    if (memberId === undefined) {
      return yield* forbiddenFailure("This agent MCP token is not bound to an active team member.");
    }
    const actor: TeamService.TeamActor = { kind: "member", memberId };
    yield* teamService.assertActorIsActiveMember(actor).pipe(Effect.mapError(toMcpForbidden));
    return Option.some<ResolvedTeamMcpCaller>({
      teamService,
      actor,
      memberId,
      teamAutomation: null,
      callerThreadId: scope.thread.threadId,
    });
  }
  if (scope.client !== undefined) {
    const memberId = yield* teamService.resolveMemberIdForSession(
      AuthSessionId.make(scope.client.sessionId),
    );
    if (Option.isNone(memberId)) {
      return yield* forbiddenFailure(
        "This MCP client session is not bound to an active team member.",
      );
    }
    const actor: TeamService.TeamActor = { kind: "member", memberId: memberId.value };
    yield* teamService.assertActorIsActiveMember(actor).pipe(Effect.mapError(toMcpForbidden));
    return Option.some<ResolvedTeamMcpCaller>({
      teamService,
      actor,
      memberId: memberId.value,
      teamAutomation: null,
      callerThreadId: undefined,
    });
  }
  return yield* forbiddenFailure("This MCP caller is not bound to an active team member.");
});

export const assertActiveMemberIfTeamConfigured = resolveTeamMcpCaller().pipe(Effect.asVoid);

export const assertCanAccessCallerThread = Effect.fn("TeamMcpAccess.assertCanAccessCallerThread")(
  function* (mode: "read" | "write") {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller) || caller.value.callerThreadId === undefined) return;
    const { teamService, actor, callerThreadId } = caller.value;
    if (mode === "read") {
      yield* teamService
        .assertActorCanReadThread(actor, callerThreadId)
        .pipe(Effect.mapError(toMcpForbidden));
    } else {
      yield* teamService
        .assertActorCanPostInThread(actor, callerThreadId)
        .pipe(Effect.mapError(toMcpForbidden));
      yield* teamService
        .assertActorCanExecuteOnThreadEnvironment(actor, callerThreadId)
        .pipe(Effect.mapError(toMcpForbidden));
    }
  },
);

export const assertCanReadThread = Effect.fn("TeamMcpAccess.assertCanReadThread")(function* (
  threadId: ThreadId,
) {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return;
  yield* caller.value.teamService
    .assertActorCanReadThread(caller.value.actor, threadId)
    .pipe(Effect.mapError(toMcpForbidden));
});

export const filterReadableThreadIds = Effect.fn("TeamMcpAccess.filterReadableThreadIds")(
  function* (threadIds: ReadonlyArray<ThreadId>) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) {
      return new Set<ThreadId>(threadIds) as ReadonlySet<ThreadId>;
    }
    return yield* caller.value.teamService.filterReadableThreadIdsForActor(
      caller.value.actor,
      threadIds,
    );
  },
);

export const assertCanPostInThread = Effect.fn("TeamMcpAccess.assertCanPostInThread")(function* (
  threadId: ThreadId,
) {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return;
  yield* caller.value.teamService
    .assertActorCanPostInThread(caller.value.actor, threadId)
    .pipe(Effect.mapError(toMcpForbidden));
  yield* caller.value.teamService
    .assertActorCanExecuteOnThreadEnvironment(caller.value.actor, threadId)
    .pipe(Effect.mapError(toMcpForbidden));
});

export const assertCanAccessEnvironment = Effect.fn("TeamMcpAccess.assertCanAccessEnvironment")(
  function* (environmentId: EnvironmentId) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanAccessEnvironment(caller.value.actor, environmentId)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const filterAccessibleEnvironmentIds = Effect.fn(
  "TeamMcpAccess.filterAccessibleEnvironmentIds",
)(function* (environmentIds: ReadonlyArray<EnvironmentId>) {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) {
    return new Set<EnvironmentId>(environmentIds) as ReadonlySet<EnvironmentId>;
  }
  return yield* caller.value.teamService.filterAccessibleEnvironmentIdsForActor(
    caller.value.actor,
    environmentIds,
  );
});

export const getMinimalAutomationProjectId = Effect.fn(
  "TeamMcpAccess.getMinimalAutomationProjectId",
)(function* () {
  const caller = yield* resolveTeamMcpCaller();
  if (
    Option.isSome(caller) &&
    caller.value.teamAutomation !== null &&
    caller.value.teamAutomation.mcpAccessLevel === "minimal"
  ) {
    return Option.some(caller.value.teamAutomation.projectId);
  }
  return Option.none<ProjectId>();
});

export const assertCanAccessProject = Effect.fn("TeamMcpAccess.assertCanAccessProject")(function* (
  projectId: ProjectId,
) {
  const scopedProjectId = yield* getMinimalAutomationProjectId();
  if (Option.isSome(scopedProjectId) && scopedProjectId.value !== projectId) {
    return yield* forbiddenFailure(
      "Minimal team automations can only access their configured project.",
    );
  }
});

export const assertCanUseScratchProject = Effect.fn("TeamMcpAccess.assertCanUseScratchProject")(
  function* () {
    const scopedProjectId = yield* getMinimalAutomationProjectId();
    if (Option.isSome(scopedProjectId)) {
      return yield* forbiddenFailure(
        "Minimal team automations cannot launch threads in the Scratch project.",
      );
    }
  },
);

export const canSteerActiveTurn = Effect.fn("TeamMcpAccess.canSteerActiveTurn")(function* (
  threadId: ThreadId,
) {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return true;
  return yield* caller.value.teamService.canActorSteerActiveTurn(caller.value.actor, threadId);
});

export const assertCanSteerActiveTurn = Effect.fn("TeamMcpAccess.assertCanSteerActiveTurn")(
  function* (threadId: ThreadId) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanExecuteOnThreadEnvironment(caller.value.actor, threadId)
      .pipe(Effect.mapError(toMcpForbidden));
    yield* caller.value.teamService
      .assertActorCanSteerActiveTurn(caller.value.actor, threadId)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const assertCanPromoteQueuedRun = Effect.fn("TeamMcpAccess.assertCanPromoteQueuedRun")(
  function* (threadId: ThreadId) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanExecuteOnThreadEnvironment(caller.value.actor, threadId)
      .pipe(Effect.mapError(toMcpForbidden));
    yield* caller.value.teamService
      .assertActorCanPromoteQueuedRun(caller.value.actor, threadId)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const assertCanInterruptThread = Effect.fn("TeamMcpAccess.assertCanInterruptThread")(
  function* (threadId: ThreadId, runId?: string | null) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanExecuteOnThreadEnvironment(caller.value.actor, threadId)
      .pipe(Effect.mapError(toMcpForbidden));
    yield* caller.value.teamService
      .assertActorCanInterruptThread(caller.value.actor, threadId, runId)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const assertCanRespondToRuntimeRequest = Effect.fn(
  "TeamMcpAccess.assertCanRespondToRuntimeRequest",
)(function* (threadId: ThreadId, runId?: string | null) {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return;
  yield* caller.value.teamService
    .assertActorCanExecuteOnThreadEnvironment(caller.value.actor, threadId)
    .pipe(Effect.mapError(toMcpForbidden));
  yield* caller.value.teamService
    .assertActorCanRespondToRuntimeRequest(caller.value.actor, threadId, runId)
    .pipe(Effect.mapError(toMcpForbidden));
});

export const assertCanManageQueuedRun = Effect.fn("TeamMcpAccess.assertCanManageQueuedRun")(
  function* (threadId: ThreadId, runId: string) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanExecuteOnThreadEnvironment(caller.value.actor, threadId)
      .pipe(Effect.mapError(toMcpForbidden));
    yield* caller.value.teamService
      .assertActorCanManageQueuedRun(caller.value.actor, threadId, runId)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const assertCanUseWorkflows = Effect.fn("TeamMcpAccess.assertCanUseWorkflows")(function* () {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return;
  yield* caller.value.teamService
    .assertActorCanUseWorkflows(caller.value.actor)
    .pipe(Effect.mapError(toMcpForbidden));
});

export const assertCanUseScheduledTasks = Effect.fn("TeamMcpAccess.assertCanUseScheduledTasks")(
  function* () {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanUseScheduledTasks(caller.value.actor)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const filterReadableScheduledTasks = Effect.fn("TeamMcpAccess.filterReadableScheduledTasks")(
  function* (tasks: ReadonlyArray<ScheduledTask>) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return tasks;
    return yield* caller.value.teamService.filterReadableScheduledTasksForActor(
      caller.value.actor,
      tasks,
    );
  },
);

export const authorizeScheduledTaskUpsert = Effect.fn("TeamMcpAccess.authorizeScheduledTaskUpsert")(
  function* (args: {
    readonly input: ScheduledTaskUpsertInput;
    readonly existingTask: ScheduledTask | null;
  }) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) {
      return Option.none<{
        readonly teamService: TeamService.TeamService["Service"];
        readonly meta: TeamService.AuthorizedTeamScheduledTaskUpsert;
      }>();
    }
    const meta = yield* caller.value.teamService
      .authorizeScheduledTaskUpsertForActor({
        actor: caller.value.actor,
        input: args.input,
        existingTask: args.existingTask,
      })
      .pipe(Effect.mapError(toMcpForbidden));
    if (Option.isNone(meta)) {
      return Option.none<{
        readonly teamService: TeamService.TeamService["Service"];
        readonly meta: TeamService.AuthorizedTeamScheduledTaskUpsert;
      }>();
    }
    return Option.some({
      teamService: caller.value.teamService,
      meta: meta.value,
    });
  },
);

export const assertCanMutateScheduledTask = Effect.fn("TeamMcpAccess.assertCanMutateScheduledTask")(
  function* (
    taskId: ScheduledTaskId,
    boundThreadId?: ThreadId | null,
    options?: { readonly isRunNow?: boolean },
  ) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .assertActorCanMutateScheduledTask(caller.value.actor, taskId, boundThreadId, options)
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const assertIsAdmin = Effect.fn("TeamMcpAccess.assertIsAdmin")(function* (
  message?: string,
  requiredPermission?: string,
) {
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return;
  yield* caller.value.teamService
    .assertActorIsAdmin(caller.value.actor, message, requiredPermission)
    .pipe(Effect.mapError(toMcpForbidden));
});

/**
 * Authorizes creating a child/spawned thread via MCP and computes the narrowest View
 * (`sourceThreadId` or calling thread's View when present; default View otherwise) so an agent
 * can never widen visibility by spawning a thread.
 */
export const authorizeChildThreadCreation = Effect.fn("TeamMcpAccess.authorizeChildThreadCreation")(
  function* (input?: {
    readonly sourceThreadId?: ThreadId;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
    readonly projectId?: ProjectId;
  }) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) {
      return Option.none<{
        readonly teamService: TeamService.TeamService["Service"];
        readonly memberId: TeamMemberId | null;
        readonly teamAutomation: McpInvocationContext.McpTeamAutomationPrincipal | null;
        readonly inheritedViewId: TeamViewId | undefined;
      }>();
    }
    const { teamService, actor, memberId, teamAutomation, callerThreadId } = caller.value;
    const parentThreadId = input?.sourceThreadId ?? callerThreadId;
    let inheritedViewId = input?.viewId;
    if (inheritedViewId === undefined && parentThreadId !== undefined) {
      yield* teamService
        .assertActorCanReadThread(actor, parentThreadId)
        .pipe(Effect.mapError(toMcpForbidden));
      const parentAttr = yield* teamService.getThreadAttribution(parentThreadId);
      if (Option.isSome(parentAttr)) {
        inheritedViewId = parentAttr.value.viewId;
      }
    }
    if (teamAutomation !== null && teamAutomation.mcpAccessLevel === "minimal") {
      if (inheritedViewId === undefined) {
        inheritedViewId = teamAutomation.viewId;
      }
    }
    const scopeOption = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (Option.isSome(scopeOption)) {
      yield* teamService
        .assertActorCanAccessEnvironment(actor, scopeOption.value.environmentId)
        .pipe(Effect.mapError(toMcpForbidden));
    }
    yield* teamService
      .assertActorCanCreateThreadInView({
        actor,
        ...(inheritedViewId !== undefined ? { viewId: inheritedViewId } : {}),
        ...(input?.locked !== undefined ? { locked: input.locked } : {}),
        ...(input?.projectId !== undefined ? { projectId: input.projectId } : {}),
      })
      .pipe(Effect.mapError(toMcpForbidden));
    return Option.some({
      teamService,
      memberId,
      teamAutomation,
      inheritedViewId,
    });
  },
);

export const canUseWorkflows = Effect.fn("TeamMcpAccess.canUseWorkflows")(function* () {
  const callerResult = yield* Effect.result(resolveTeamMcpCaller());
  // Fail closed when a team is configured and the caller is unbound/revoked; allow personal mode.
  if (callerResult._tag === "Failure") return false;
  const caller = callerResult.success;
  if (Option.isNone(caller)) return true;
  return yield* caller.value.teamService.assertActorCanUseWorkflows(caller.value.actor).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

export const recordTurnAuthoredByCaller = Effect.fn("TeamMcpAccess.recordTurnAuthoredByCaller")(
  function* (input: { readonly threadId: ThreadId; readonly turnId: string }) {
    const caller = yield* resolveTeamMcpCaller();
    if (Option.isNone(caller)) return;
    if (caller.value.teamAutomation !== null) {
      yield* caller.value.teamService
        .requireTeamAutomationTurn({
          threadId: input.threadId,
          turnId: input.turnId,
          principal: caller.value.teamAutomation,
        })
        .pipe(Effect.mapError(toMcpForbidden));
      return;
    }
    if (caller.value.memberId === null) {
      return yield* forbiddenFailure("This MCP caller is not bound to an active team member.");
    }
    yield* caller.value.teamService
      .requireTurnAuthoredByMember({
        memberId: caller.value.memberId,
        threadId: input.threadId,
        turnId: input.turnId,
      })
      .pipe(Effect.mapError(toMcpForbidden));
  },
);

export const notifyTurnInterruptedByCaller = Effect.fn(
  "TeamMcpAccess.notifyTurnInterruptedByCaller",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly runId?: string | null;
  readonly reason: TeamService.TeamTurnInterruptEvent["reason"];
}) {
  const caller = yield* resolveTeamMcpCaller().pipe(
    Effect.orElseSucceed(() => Option.none<ResolvedTeamMcpCaller>()),
  );
  if (Option.isNone(caller)) return;
  yield* caller.value.teamService.notifyTurnInterrupted({
    actor: caller.value.actor,
    threadId: input.threadId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    reason: input.reason,
  });
});

export const notifyQueuedMessageByCaller = Effect.fn("TeamMcpAccess.notifyQueuedMessageByCaller")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly queuedRunId: string;
    readonly commandId?: string | null;
    readonly activeRunId?: string | null;
    readonly messageText?: string | null;
  }) {
    const caller = yield* resolveTeamMcpCaller().pipe(
      Effect.orElseSucceed(() => Option.none<ResolvedTeamMcpCaller>()),
    );
    if (Option.isNone(caller)) return;
    yield* caller.value.teamService
      .notifyQueuedMessage({
        actor: caller.value.actor,
        threadId: input.threadId,
        queuedRunId: input.queuedRunId,
        ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
        ...(input.activeRunId !== undefined ? { activeRunId: input.activeRunId } : {}),
        ...(input.messageText !== undefined ? { messageText: input.messageText } : {}),
      })
      .pipe(Effect.asVoid);
  },
);

export const loadThreadSnoozes = Effect.fn("TeamMcpAccess.loadThreadSnoozes")(function* (
  threadIds?: ReadonlyArray<ThreadId>,
) {
  const caller = yield* resolveTeamMcpCaller();
  return Option.isNone(caller)
    ? null
    : yield* caller.value.teamService.listActorThreadSnoozes(caller.value.actor, threadIds);
});

export const interceptThreadSnooze = Effect.fn("TeamMcpAccess.interceptThreadSnooze")(function* (
  command: OrchestrationV2Command,
) {
  if (
    command.type !== "thread.snooze" &&
    command.type !== "thread.unsnooze" &&
    command.type !== "thread.mark-unread"
  )
    return false;
  const caller = yield* resolveTeamMcpCaller();
  if (Option.isNone(caller)) return false;
  yield* caller.value.teamService
    .updateActorThreadSnooze({
      actor: caller.value.actor,
      threadId: command.threadId,
      snoozedUntil: command.type === "thread.snooze" ? command.snoozedUntil : null,
      expiredOnly: command.type === "thread.mark-unread",
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.code === "invalid_input" ? "invalid_request" : "capability_denied",
            message: error.message,
          }),
      ),
    );
  return command.type !== "thread.mark-unread";
});
