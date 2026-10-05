import {
  type EnvironmentId,
  HOME_LAUNCHED_THREAD_ID_PREFIX,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { refuseHomeFolder } from "../../../home/FleetService.ts";
import * as HomeService from "../../../home/HomeService.ts";
import { callerIsHome, routeHome, runAsHome } from "../../homeRouting.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import {
  newCommandId,
  readCaller,
  readFullAccessCaller,
  readMutationCaller,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
const mutation = Effect.gen(function* () {
  yield* readFullAccessCaller(
    "Project changes require a live full-access/default calling thread or a full-access client.",
  );
  return yield* Project.ProjectService;
});
/**
 * Threads Home launches are watched for it, wherever they run. The watch is
 * saved before the launch, and a launch whose watch cannot be saved does not
 * run. A failed launch keeps its watch: a relay timeout does not prove the
 * thread was not created, and a watch whose thread never appears ends at the
 * next start.
 */
const watchLaunched = (homeThreadId: ThreadId, environmentId: EnvironmentId, threadId: ThreadId) =>
  HomeService.HomeService.pipe(
    Effect.flatMap((home) =>
      home.updateWatches(homeThreadId, (current) =>
        HomeService.addWatch(current, { environmentId, threadId, reason: "launched" }),
      ),
    ),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Home could not watch the new thread, so it was not launched.",
        }),
    ),
  );

export const ProjectHandlersLive = ProjectToolkit.toLayer({
  t3_thread_launch: (input) =>
    Effect.gen(function* () {
      const context = yield* readMutationCaller();
      const { caller, limits, scope } = context;
      // A thread caller launches only as itself (full-access/default), as before. A client
      // launches anything up to its ceiling.
      if (
        caller !== undefined &&
        (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Project launches require a full-access/default calling thread.",
        });
      const runtimeMode = yield* resolveRuntimeMode(
        limits.runtimeMode,
        input.runtimeMode ?? caller?.runtimeMode,
      );
      // Home is always a thread caller; its id scopes the watches it saves.
      const homeThreadId = (yield* callerIsHome()) ? caller?.id : undefined;
      const isHome = homeThreadId !== undefined;
      const targetEnvironmentId = input.environmentId ?? scope.environmentId;
      const remote = targetEnvironmentId !== scope.environmentId;
      // Home's folder carries Home's own instructions, so nothing launches there.
      if (isHome && input.projectId === undefined && input.scratch !== true)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Home must pass projectId or scratch:true. Threads never launch in Home's folder.",
        });
      if (remote && !isHome)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can act in another environment.",
        });
      const attachments = input.attachments ?? [];
      if (remote && attachments.length > 0)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Attachments cannot be sent to another environment.",
        });
      if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A new thread accepts only pending attachment uploads.",
        });
      if (
        input.scratch === true &&
        (input.projectId !== undefined || input.workspaceStrategy !== undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
        });
      // Checked before the watch is saved, so a refused launch leaves no watch.
      // Another environment checks its own Home folder in FleetService.
      if (isHome && !remote && input.projectId !== undefined)
        yield* refuseHomeFolder(
          {
            projects: yield* Project.ProjectService,
            folders: yield* ManagedProjectFolders.ManagedProjectFolders,
          },
          { projectId: input.projectId, workspaceStrategy: input.workspaceStrategy },
        );
      const commandId = yield* newCommandId();
      const threadId = ThreadId.make(
        isHome ? `${HOME_LAUNCHED_THREAD_ID_PREFIX}${commandId}` : commandId,
      );
      const messageId = MessageId.make(commandId);
      if (homeThreadId !== undefined && attachments.length === 0) {
        // Provider instances differ per machine, so another machine uses its own default.
        const modelSelection =
          input.modelSelection ?? (remote ? undefined : caller?.modelSelection);
        yield* watchLaunched(homeThreadId, targetEnvironmentId, threadId);
        return yield* runAsHome(input.environmentId, "threads.launch", {
          threadId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.scratch === undefined ? {} : { scratch: input.scratch }),
          title: input.title,
          ...(modelSelection === undefined ? {} : { modelSelection }),
          runtimeMode,
          interactionMode: input.interactionMode ?? caller?.interactionMode ?? "default",
          ...(input.workspaceStrategy === undefined
            ? {}
            : { workspaceStrategy: input.workspaceStrategy }),
          ...(input.message === undefined ? {} : { message: input.message }),
        });
      }
      const projectId =
        input.scratch === true
          ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
              Effect.flatMap((folders) => folders.ensureScratchProject),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            )).projectId
          : yield* resolveProjectId(context, input.projectId);
      const modelSelection =
        input.modelSelection ??
        caller?.modelSelection ??
        (yield* Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map((project) =>
            Option.getOrUndefined(Option.flatMapNullishOr(project, (p) => p.defaultModelSelection)),
          ),
        ));
      if (modelSelection === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
        });
      if (homeThreadId !== undefined)
        yield* watchLaunched(homeThreadId, scope.environmentId, threadId);
      const result = yield* ThreadMessageIntake.launchThread({
        commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode,
        interactionMode: input.interactionMode ?? caller?.interactionMode ?? "default",
        workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
        ...(input.message === undefined && attachments.length === 0
          ? {}
          : {
              initialMessage: {
                messageId,
                ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                text: input.message ?? "",
                attachments,
              },
            }),
        createdBy: "agent",
        creationSource: "mcp",
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "AttachmentClaimError"
            ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
            : unavailable(),
        ),
      );
      const thread = result.projection.thread;
      const run = result.projection.runs.find((run) => run.userMessageId === messageId);
      return {
        threadId: thread.id,
        link: formatThreadLink({
          environmentId: scope.environmentId,
          threadId: thread.id,
          title: thread.title,
        }),
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
  t3_project_list: (input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "projects.list", input);
      if (Option.isSome(routed)) return routed.value;
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  t3_project_read: (input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  t3_project_create: ({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_update: (input) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_delete: (input) =>
    Effect.gen(function* () {
      // Home archives and settles; it never deletes.
      if (yield* callerIsHome())
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Home cannot delete projects. Archive or settle their threads instead.",
        });
      const projects = yield* mutation;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_clone: (input) =>
    Effect.gen(function* () {
      yield* mutation;
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
});
