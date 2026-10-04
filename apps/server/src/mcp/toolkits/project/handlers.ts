import { MessageId, ThreadId, OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
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
const hostPathAccess = readFullAccessCaller(
  "Host folders and agent sessions require a live full-access/default calling thread or a full-access client.",
);
function paginate<T>(
  rows: ReadonlyArray<T>,
  input: { readonly cursor?: number | undefined; readonly limit?: number | undefined },
) {
  const start = input.cursor ?? 0,
    end = start + (input.limit ?? 20);
  return { rows: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
}
export const ProjectHandlersLive = ProjectToolkit.toLayer({
  t3_thread_launch: (input) =>
    Effect.gen(function* () {
      const context = yield* readMutationCaller();
      const { caller, limits } = context;
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
      const commandId = yield* newCommandId();
      const threadId = ThreadId.make(commandId);
      const messageId = MessageId.make(commandId);
      const attachments = input.attachments ?? [];
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
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
  t3_project_list: (input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const { rows: page, nextCursor } = paginate(rows, input);
      return { projects: page, nextCursor };
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
  t3_folder_browse: (input) =>
    Effect.gen(function* () {
      yield* hostPathAccess;
      const entries = yield* WorkspaceEntries.WorkspaceEntries;
      const path = input.path ?? "~";
      // A trailing separator makes the browse service list the folder itself, not filter its parent.
      const result = yield* entries
        .browse({ partialPath: path === "~" || /[\\/]$/.test(path) ? path : `${path}/` })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  error._tag === "WorkspaceEntriesCurrentProjectRequiredError"
                    ? "Pass an absolute or ~ path."
                    : error.message,
              }),
          ),
        );
      const { rows, nextCursor } = paginate(result.entries, input);
      return { path: result.parentPath, folders: rows, nextCursor };
    }),
  t3_agent_session_scan: (input) =>
    Effect.gen(function* () {
      yield* hostPathAccess;
      const scanner = yield* AgentSessionScanner.AgentSessionScanner;
      const result = yield* scanner.scan.pipe(Effect.mapError(unavailable));
      const { rows, nextCursor } = paginate(result.candidates, input);
      return {
        candidates: rows,
        nextCursor,
        scannedAt: result.scannedAt,
        truncated: result.truncated ?? false,
      };
    }),
  t3_agent_session_import: (input) =>
    Effect.gen(function* () {
      yield* hostPathAccess;
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      return yield* importer
        .importRecentAgentThreads(input)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "AgentSessionScanError"
              ? unavailable()
              : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
});
