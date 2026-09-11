import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { threadHasQueuedTurnStart } from "../../../orchestration/ThreadSettlementPolicy.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceMcpError } from "./errors.ts";
import {
  projectBrief,
  providerBrief,
  resolveProviderSelection,
  threadBrief,
  threadDetail,
  titleFromPrompt,
  type WorkspaceThreadShelf,
  type WorkspaceThreadStatus,
} from "./mapping.ts";
import { requireWorkspaceOperate, requireWorkspaceRead } from "./principal.ts";
import { WorkspaceToolkit } from "./tools.ts";

const newId = Effect.fn("workspaceMcp.newId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4.pipe(Effect.orDie);
});

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const isWorkspaceMcpError = Schema.is(WorkspaceMcpError);

const failDispatch = (cause: unknown) =>
  new WorkspaceMcpError({
    code: "conflict",
    detail: cause instanceof Error ? cause.message : "The workspace command was rejected.",
  });

export function buildCreateProjectCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing: boolean;
  readonly createdAt: string;
}): OrchestrationCommand {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
    createdAt: input.createdAt,
  };
}

export function buildStartThreadCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default" | "plan";
  readonly createdAt: string;
}): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}

export function buildSettleThreadCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}): OrchestrationCommand {
  return { type: "thread.settle", ...input };
}

export function buildUnsettleThreadCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}): OrchestrationCommand {
  return { type: "thread.unsettle", ...input, reason: "user" };
}

function settlementConflict(threadId: ThreadId, reason: string) {
  return new WorkspaceMcpError({
    code: "conflict",
    detail: `Thread ${threadId} cannot be settled: ${reason}. History and artifacts were not changed. There is no deferred settle; resolve the blocker and retry once the thread is completed or idle.`,
  });
}

export const handlers = {
  list_projects: (input: { readonly query?: string | undefined }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceRead();
      const query = yield* ProjectionSnapshotQuery;
      const snapshot = yield* query.getShellSnapshot();
      const needle = input.query?.trim().toLowerCase();
      const projects = snapshot.projects
        .map(projectBrief)
        .filter(
          (project) =>
            needle == null ||
            needle.length === 0 ||
            project.title.toLowerCase().includes(needle) ||
            project.workspaceRoot.toLowerCase().includes(needle),
        );
      return { projects };
    }).pipe(Effect.mapError(toWorkspaceError)),

  create_project: (input: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createWorkspaceRootIfMissing?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make(yield* newId());
      const createdAt = yield* nowIso;
      yield* engine.dispatch(
        buildCreateProjectCommand({
          commandId: CommandId.make(yield* newId()),
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing ?? true,
          createdAt,
        }),
      );
      return {
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
      };
    }).pipe(Effect.mapError(toWorkspaceError)),

  list_threads: (input: {
    readonly projectId?: string | undefined;
    readonly shelf?: WorkspaceThreadShelf | "all" | undefined;
    readonly status?: WorkspaceThreadStatus | undefined;
    readonly includeArchived?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceRead();
      const query = yield* ProjectionSnapshotQuery;
      const snapshot = yield* query.getShellSnapshot();
      const includeArchived =
        (input.includeArchived ?? false) || input.shelf === "archived" || input.shelf === "all";
      const archived = includeArchived ? (yield* query.getArchivedShellSnapshot()).threads : [];
      const clock = Date.parse(yield* nowIso);
      const threads = [...snapshot.threads, ...archived]
        .map((thread) => threadBrief(thread, clock))
        .filter((thread) => matchesThreadFilter(thread, input));
      return { threads };
    }).pipe(Effect.mapError(toWorkspaceError)),

  get_thread: (input: {
    readonly threadId: ThreadId;
    readonly turnLimit?: number | undefined;
    readonly beforeCursor?: string | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceRead();
      const query = yield* ProjectionSnapshotQuery;
      const snapshot = yield* query.getThreadDetailSnapshot(input.threadId, {
        turnLimit: input.turnLimit ?? 40,
        ...(input.beforeCursor ? { beforeCursor: input.beforeCursor } : {}),
      });
      if (Option.isNone(snapshot)) {
        return yield* new WorkspaceMcpError({
          code: "not_found",
          detail: `Thread ${input.threadId} was not found.`,
        });
      }
      const now = Date.parse(yield* nowIso);
      // A paginated transcript can omit request resolutions; use the shell's
      // authoritative flags for the same live status returned by list_threads.
      const brief = threadBrief(yield* loadThreadShell(query, input.threadId), now);
      return {
        ...threadDetail(snapshot.value, now),
        shelf: brief.shelf,
        status: brief.status,
        hasPendingApprovals: brief.hasPendingApprovals,
        hasPendingUserInput: brief.hasPendingUserInput,
      };
    }).pipe(Effect.mapError(toWorkspaceError)),

  list_providers: (input: { readonly includeDisabled?: boolean | undefined }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceRead();
      const registry = yield* ProviderRegistry;
      const providers = yield* registry.getProviders;
      return {
        providers: providers
          .filter((provider) => (input.includeDisabled ?? false) || provider.enabled)
          .map(providerBrief),
      };
    }).pipe(Effect.mapError(toWorkspaceError)),

  start_thread: (input: {
    readonly projectId: ProjectId;
    readonly prompt: string;
    readonly title?: string | undefined;
    readonly provider?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly model?: string | undefined;
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: "default" | "plan" | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      const query = yield* ProjectionSnapshotQuery;
      const registry = yield* ProviderRegistry;
      const engine = yield* OrchestrationEngineService;
      const project = yield* query.getProjectShellById(input.projectId);
      if (Option.isNone(project)) {
        return yield* new WorkspaceMcpError({
          code: "not_found",
          detail: `Project ${input.projectId} was not found.`,
        });
      }
      const providers = yield* registry.getProviders;
      const selection = resolveProviderSelection(
        {
          provider: input.provider,
          instanceId: input.instanceId,
          model: input.model,
        },
        providers,
        project.value.defaultModelSelection,
      );
      if ("error" in selection) {
        return yield* new WorkspaceMcpError({
          code: "invalid_input",
          detail: selection.error,
        });
      }
      const threadId = ThreadId.make(yield* newId());
      const title = input.title ?? titleFromPrompt(input.prompt);
      const createdAt = yield* nowIso;
      yield* engine.dispatch(
        buildStartThreadCommand({
          commandId: CommandId.make(yield* newId()),
          threadId,
          messageId: MessageId.make(yield* newId()),
          projectId: input.projectId,
          title,
          prompt: input.prompt,
          modelSelection: {
            instanceId: ProviderInstanceId.make(selection.instanceId),
            model: selection.model,
          },
          runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }),
      );
      return {
        threadId,
        title,
        provider: selection.instanceId,
        model: selection.model,
      };
    }).pipe(Effect.mapError(toWorkspaceError)),

  follow_up: (input: { readonly threadId: ThreadId; readonly prompt: string }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const thread = yield* loadThreadShell(query, input.threadId);
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(yield* newId()),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(yield* newId()),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });
      return { threadId: input.threadId, accepted: true };
    }).pipe(Effect.mapError(toWorkspaceError)),

  interrupt_thread: (input: { readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      yield* loadThreadShell(query, input.threadId);
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(yield* newId()),
        threadId: input.threadId,
        createdAt: yield* nowIso,
      });
      return { threadId: input.threadId, accepted: true };
    }).pipe(Effect.mapError(toWorkspaceError)),

  settle_thread: (input: { readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const thread = yield* loadThreadShell(query, input.threadId);
      const now = yield* nowIso;
      const blocker =
        thread.archivedAt != null
          ? "it is archived; restore it from Archived threads first"
          : thread.session?.status === "starting" || thread.session?.status === "running"
            ? "it is still working; the turn must finish first"
            : thread.hasPendingApprovals || thread.hasPendingUserInput
              ? "it has a pending approval or user-input request"
              : threadHasQueuedTurnStart(thread, now)
                ? "it has a queued turn start"
                : null;
      if (blocker !== null) return yield* settlementConflict(input.threadId, blocker);
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      yield* engine
        .dispatch(
          buildSettleThreadCommand({
            threadId: input.threadId,
            commandId: CommandId.make(yield* newId()),
          }),
        )
        .pipe(
          Effect.catchTags({
            OrchestrationCommandInvariantError: (error) =>
              Effect.fail(settlementConflict(input.threadId, error.detail)),
            OrchestrationThreadSettleBlockedError: () =>
              Effect.fail(
                settlementConflict(input.threadId, "it still has active work or a pending request"),
              ),
          }),
        );
      const settled = yield* loadThreadShell(query, input.threadId);
      if (settled.settledAt === null || settled.settledOverride !== "settled") {
        return yield* new WorkspaceMcpError({
          code: "conflict",
          detail:
            "The thread changed after settlement. History and artifacts are preserved; read the thread again before retrying.",
        });
      }
      return {
        threadId: input.threadId,
        shelf: "settled" as const,
        status: threadBrief(settled, Date.parse(now)).status,
        settledAt: settled.settledAt,
        alreadySettled,
      };
    }).pipe(Effect.mapError(toWorkspaceError)),

  unsettle_thread: (input: { readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      yield* loadThreadShell(query, input.threadId);
      yield* engine.dispatch(
        buildUnsettleThreadCommand({
          threadId: input.threadId,
          commandId: CommandId.make(yield* newId()),
        }),
      );
      const thread = yield* loadThreadShell(query, input.threadId);
      return {
        threadId: input.threadId,
        shelf: "active" as const,
        status: threadBrief(thread, Date.parse(yield* nowIso)).status,
        unsettled: true as const,
      };
    }).pipe(Effect.mapError(toWorkspaceError)),

  respond_to_approval: (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
    readonly confirmed?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireWorkspaceOperate();
      if (
        (input.decision === "accept" ||
          input.decision === "acceptForSession" ||
          input.decision === "acceptAlways") &&
        input.confirmed !== true
      ) {
        return yield* new WorkspaceMcpError({
          code: "invalid_input",
          detail:
            "Restate the approval risk to the user, then call again with confirmed=true after they say yes.",
        });
      }
      const query = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      yield* loadThreadShell(query, input.threadId);
      yield* engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make(yield* newId()),
        threadId: input.threadId,
        requestId: input.requestId as never,
        decision: input.decision,
        createdAt: yield* nowIso,
      });
      return {
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision,
      };
    }).pipe(Effect.mapError(toWorkspaceError)),
} satisfies Parameters<typeof WorkspaceToolkit.toLayer>[0];

function matchesThreadFilter(
  thread: ReturnType<typeof threadBrief>,
  input: {
    readonly projectId?: string | undefined;
    readonly shelf?: WorkspaceThreadShelf | "all" | undefined;
    readonly status?: WorkspaceThreadStatus | undefined;
  },
): boolean {
  if (input.projectId != null && thread.projectId !== input.projectId) {
    return false;
  }
  if (input.shelf != null && input.shelf !== "all" && thread.shelf !== input.shelf) {
    return false;
  }
  if (input.status != null && thread.status !== input.status) {
    return false;
  }
  return true;
}

const loadThreadShell = Effect.fn("workspaceMcp.loadThreadShell")(function* (
  query: ProjectionSnapshotQuery["Service"],
  threadId: ThreadId,
): Effect.fn.Return<OrchestrationThreadShell, WorkspaceMcpError> {
  const thread = yield* query.getThreadShellById(threadId).pipe(Effect.mapError(toWorkspaceError));
  if (Option.isNone(thread)) {
    return yield* new WorkspaceMcpError({
      code: "not_found",
      detail: `Thread ${threadId} was not found.`,
    });
  }
  return thread.value;
});

function toWorkspaceError(cause: unknown): WorkspaceMcpError {
  if (isWorkspaceMcpError(cause)) {
    return cause;
  }
  return failDispatch(cause);
}

export const WorkspaceToolkitHandlersLive = WorkspaceToolkit.toLayer(handlers);
