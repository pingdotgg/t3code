import {
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsError,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import { mutateProjectWithClone } from "../../../project/ProjectMutation.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as DateTime from "effect/DateTime";
import { resolveUsageFallbackModelSelection } from "@t3tools/shared/usageLimits";
import {
  clearProjectSettingsOverrides,
  resolveProjectFileBackedSetting,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestrationMcp from "../../OrchestratorMcpService.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { hiddenModelMessage, hiddenModelSlugs } from "../../ModelVisibility.ts";
import { ProjectToolkit } from "./tools.ts";

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectInvalidError"
      ? error.detail
      : error._tag === "ProjectNotFoundError"
        ? "The project was not found."
        : error._tag === "ProjectConflictError"
          ? "The workspace is already registered to a project."
          : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

export function worktreeCheckHint(
  error:
    | ThreadLaunch.ThreadLaunchBaseRefError
    | ThreadLaunch.ThreadLaunchBranchExistsError
    | ThreadLaunch.ThreadLaunchBranchConflictError
    | ThreadLaunch.ThreadLaunchNotRepositoryError,
  strategy: { readonly startFromOrigin?: boolean | undefined },
) {
  if (error._tag === "ThreadLaunchNotRepositoryError")
    return `Use workspaceStrategy: {type: "root"}, or pass the projectId of a Git repository.`;
  if (error._tag === "ThreadLaunchBranchExistsError")
    return "Pass a branch name that does not exist yet, or omit branch to get a generated name.";
  if (error._tag === "ThreadLaunchBranchConflictError") {
    const sibling = error.branch.replaceAll("/", "-");
    return `Use a name that does not nest under or contain an existing branch${
      sibling === error.branch ? "" : `, such as "${sibling}"`
    }.`;
  }
  return `Pass a branch, tag, or commit that exists there${
    strategy.startFromOrigin === true
      ? "; no remote of the project has it either."
      : ", or set startFromOrigin:true if it exists only on a remote."
  }`;
}

/** Require project worktrees so launches cannot target arbitrary host directories. */
export const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
}): Effect.fn.Return<string, OrchestratorMcpFailure> {
  const { git, fileSystem, workspaceRoot, worktreePath } = input;
  // A listed worktree that vanished falls back to its raw path; a resolvable
  // request can never equal it, so the fallback admits nothing.
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  // Callers store the resolved path: a symlink stored raw could be repointed
  // elsewhere between this check and an unattended run. A path whose real
  // path cannot be read does not exist, so refuse rather than compare the
  // raw string.
  const resolved = yield* fileSystem.realPath(worktreePath).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "worktreePath does not exist. t3_worktree_list shows the project's git worktrees.",
        }),
    ),
  );
  if (!worktrees.includes(resolved))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
    });
  return resolved;
});

/** The composer falls back to the project's t3.json when no setting picks the mode. */
const projectFileThreadEnvMode = Effect.fn("mcp.projectFileThreadEnvMode")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(`${workspaceRoot}/${T3_PROJECT_FILE_NAME}`)
    .pipe(Effect.orElseSucceed(() => null));
  return resolveProjectFileBackedSetting(
    "defaultThreadEnvMode",
    null,
    contents === null ? null : parseT3ProjectFile(contents),
  ).value;
});

/** Branches from the checkout's current branch, as the composer does; a checkout with no commit or a detached HEAD stays shared. */
const defaultWorktreeStrategy = Effect.fn("mcp.defaultWorktreeStrategy")(function* (
  workspaceRoot: string,
): Effect.fn.Return<
  OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined,
  OrchestratorMcpFailure,
  GitVcsDriver.GitVcsDriver
> {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const hasCommit = yield* git.resolveCommit({ cwd: workspaceRoot, revision: "HEAD" }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!hasCommit) return undefined;
  // symbolic-ref skips the index, so a held index lock cannot drop the launch into the shared checkout.
  const head = yield* git
    .execute({
      operation: "mcp.defaultWorktreeStrategy",
      cwd: workspaceRoot,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (head?.exitCode === 1) return undefined;
  const branch = head?.exitCode === 0 ? head.stdout.trim() : "";
  if (branch.length === 0)
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message:
        "Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.",
    });
  return { type: "worktree" as const, baseRef: branch };
});

/** A fixed-length id, so a long key fits in the scratch folder name derived from it. */
const launchCommandId = Effect.fn("mcp.launchCommandId")(function* (
  namespace: string,
  key: string,
) {
  const crypto = yield* Digest.Digest;
  // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON pair keeps the caller apart from the key.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, key]));
  const digest = yield* crypto.digest(Digest.sha256, bytes).pipe(Effect.mapError(unavailable));
  return CommandId.make(`mcp:launch:${Hex.encode(digest)}`);
});

/**
 * Resolves the project first so an unknown id fails before `load` runs, which
 * keeps an update from writing overrides for a project that does not exist.
 */
const projectSettingsView = Effect.fn("mcp.projectSettingsView")(function* (
  projectId: ProjectId,
  load: (
    settings: ServerSettings.ServerSettingsService["Service"],
  ) => Effect.Effect<ServerSettingsValue, ServerSettingsError>,
) {
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap(load),
    Effect.mapError(unavailable),
  );
  // The loader is stateless; building it here keeps t3.json-backed values
  // resolving the same way the composer resolves them.
  const loader = yield* T3ProjectFileLoader.make;
  const projectFile = yield* loader.load(project.value.workspaceRoot);
  const { settings: effective, sources } = resolveProjectSettings(
    settings,
    projectId,
    project.value,
    Option.getOrNull(projectFile),
  );
  const read = <K extends keyof typeof sources & keyof typeof effective>(key: K) => ({
    value: effective[key],
    source: sources[key],
  });
  return {
    projectId,
    settings: {
      worktreeCleanup: read("worktreeCleanup"),
      defaultModelSelection: read("defaultModelSelection"),
      defaultThreadEnvMode: read("defaultThreadEnvMode"),
      newWorktreesStartFromOrigin: read("newWorktreesStartFromOrigin"),
      defaultAutoPull: read("defaultAutoPull"),
      textGenerationModelSelection: read("textGenerationModelSelection"),
      sourceControlWriterModelSelection: read("sourceControlWriterModelSelection"),
      reviewGuideModelSelection: read("reviewGuideModelSelection"),
      removeAgentCreditsOnMerge: read("removeAgentCreditsOnMerge"),
      branchNamingMode: read("branchNamingMode"),
      branchNamePrefix: read("branchNamePrefix"),
      pullRequestMergeMethod: read("pullRequestMergeMethod"),
      sidebarAutoSettleOnMerge: read("sidebarAutoSettleOnMerge"),
      sidebarAutoSettleAfterDays: read("sidebarAutoSettleAfterDays"),
      sidebarAutoSettleKeepPullRequests: read("sidebarAutoSettleKeepPullRequests"),
      responseStreamingMode: read("responseStreamingMode"),
    },
  };
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const context = yield* readCaller();
        const { caller } = context;
        // A retry with the same key replays the first launch: the ids derive
        // from the caller and the key, and the launch service replays a
        // command it already accepted.
        const commandId =
          input.clientRequestId === undefined
            ? yield* newCommandId()
            : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
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
        // A retry of an accepted launch replays it: it keeps the model it started
        // with and skips the checks only a new launch needs, which the project
        // may no longer pass, such as a base branch deleted since.
        const launched =
          input.clientRequestId === undefined
            ? null
            : yield* context.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        const launchedModel =
          launched === null || launched.deletedAt !== null ? undefined : launched.modelSelection;
        const replaying = launchedModel !== undefined;
        if (launched !== null && replaying && launched.projectId !== projectId)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A launch retry must use the original project.",
          });
        const project =
          replaying && input.workspaceStrategy?.type !== "existing_worktree"
            ? undefined
            : yield* Project.ProjectService.pipe(
                Effect.flatMap((projects) => projects.getById(projectId)),
                Effect.mapError(unavailable),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new OrchestratorMcpFailure({
                          code: "invalid_request",
                          message: "The project was not found.",
                        }),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );
        if (project !== undefined && input.workspaceStrategy?.type === "existing_worktree")
          yield* assertProjectWorktree({
            git: yield* GitVcsDriver.GitVcsDriver,
            fileSystem: yield* FileSystem.FileSystem,
            workspaceRoot: project.workspaceRoot,
            worktreePath: input.workspaceStrategy.worktreePath,
          });
        if (!replaying && input.modelSelection !== undefined) {
          const { instanceId, model } = input.modelSelection;
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          // An agent-named model must be visible; inheriting the caller's or
          // project's selection stays allowed even when hidden (the user picked it).
          const settings = yield* ServerSettings.ServerSettingsService;
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          if (hiddenModelSlugs(current, instanceId).has(model)) {
            const hiddenReason = hiddenModelMessage({
              settings: current,
              providers,
              selection: input.modelSelection,
            });
            if (hiddenReason !== null)
              return yield* new OrchestratorMcpFailure({
                code: "model_unavailable",
                message: hiddenReason,
              });
          }
          const provider = providers.find((candidate) => candidate.instanceId === instanceId);
          if (provider !== undefined)
            yield* OrchestrationMcp.requireAdvertisedModel(provider, model);
        }
        const projectSettings =
          replaying || project === undefined
            ? undefined
            : yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.map(
                  (settings) => resolveProjectSettings(settings, projectId, project).settings,
                ),
              );
        // An outside caller that names no workspace follows the new-threads-in-a-worktree
        // default, as the composer does.
        const requestedStrategy =
          input.workspaceStrategy === undefined &&
          caller === undefined &&
          project !== undefined &&
          projectSettings !== undefined &&
          (projectSettings.defaultThreadEnvMode ??
            (yield* projectFileThreadEnvMode(project.workspaceRoot))) === "worktree"
            ? yield* defaultWorktreeStrategy(project.workspaceRoot)
            : input.workspaceStrategy;
        // An omitted startFromOrigin follows the new-worktree setting, as the composer and
        // t3_worktree_handoff do. Otherwise a stale local branch silently becomes the base.
        const strategy =
          projectSettings !== undefined &&
          requestedStrategy?.type === "worktree" &&
          requestedStrategy.startFromOrigin === undefined
            ? {
                ...requestedStrategy,
                startFromOrigin: projectSettings.newWorktreesStartFromOrigin,
              }
            : requestedStrategy;
        // Reject unresolved base refs and blocked branch names before accepting a launch; worktree provisioning happens later.
        if (!replaying && strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${error.message} No thread was created. ${worktreeCheckHint(error, strategy)}`,
                }),
            ),
          );
        // A caller outside a thread has nothing to inherit, so it starts with the
        // project's effective defaults, as the composer does. Its mode stays
        // within the ceiling it was approved with.
        const projectDefaults = caller === undefined ? projectSettings : undefined;
        const modelSelection =
          input.modelSelection ??
          launchedModel ??
          caller?.modelSelection ??
          (projectDefaults
            ? resolveUsageFallbackModelSelection({
                defaultSelection: projectDefaults.defaultModelSelection,
                fallbackSelection: projectDefaults.fallbackModelSelection,
                providers: yield* ProviderRegistry.ProviderRegistry.pipe(
                  Effect.flatMap((registry) => registry.getProviders),
                ),
                settings: projectDefaults,
                projectId,
                now: DateTime.toEpochMillis(yield* DateTime.now),
              }).selection
            : null) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        let startedRuntimeMode =
          projectDefaults !== undefined && input.runtimeMode === undefined
            ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                Effect.orElseSucceed(() => runtimeMode),
              )
            : runtimeMode;
        if (!replaying) {
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          startedRuntimeMode = yield* resolveRuntimeMode(startedRuntimeMode, input.runtimeMode, {
            modelSelection,
            supportedRuntimeModes: providers.find(
              (provider) => provider.instanceId === modelSelection.instanceId,
            )?.supportedRuntimeModes,
          });
        }
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: startedRuntimeMode,
          interactionMode,
          workspaceStrategy: strategy ?? { type: "root" },
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
          ...(linkOrigin === undefined ? {} : { linkOrigin }),
          // Kept only alongside linkOrigin: thread.create drops it otherwise.
          ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
        }).pipe(
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            // The administrator's ceiling refuses the mode; say so rather than "unavailable".
            if (error._tag === "ThreadLaunchError" && isAboveCeilingError(error.cause)) {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.cause.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          link: McpInvocationContext.threadLinkFor(scope, thread.id, thread.title),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
    // The launched thread carries the caller's link, if it has one.
    "stamped",
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      // Identities are resolved: linked environments find this side's project by repository.
      return yield* projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_project_read: McpToolAccess.reads((input) =>
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
  ),
  t3_project_settings_read: McpToolAccess.reads(({ projectId }) =>
    Effect.gen(function* () {
      yield* access;
      return yield* projectSettingsView(projectId, (settings) => settings.getSettings);
    }),
  ),
  t3_project_settings_update: McpToolAccess.writesEnvironment(
    ({ projectId, set = {}, clear = [] }, check) =>
      Effect.gen(function* () {
        if (clear.some((key) => Object.hasOwn(set, key)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A setting cannot be in both set and clear.",
          });
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const update = Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          return yield* projectSettingsView(projectId, (settings) =>
            // Patch entries replace a project's whole override set, so the merge
            // must read the stored entry under the settings write lock.
            settings.modifySettings((current) => ({
              projectSettingsOverrides: {
                [projectId]: clearProjectSettingsOverrides(
                  {
                    projectSettingsOverrides: {
                      [projectId]: { ...current.projectSettingsOverrides[projectId], ...set },
                    },
                  },
                  projectId,
                  clear,
                ),
              },
            })),
          );
        });
        return yield* scope.thread === undefined
          ? update
          : executor.withLock(scope.thread.threadId, update);
      }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(
    ({ workspaceRoot, ...input }) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        if (workspaceRoot === undefined) {
          // Only updates record model defaults; reject defaults that creation would silently drop.
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
          const created = yield* folders.createNamedProject({ name: input.title }).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
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
    // Linked work may bring the repository it works in; an existing
    // registered workspace is still refused.
    { linkedCallers: "allowed" },
  ),
  t3_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      if (yield* folders.isScratchProject(input.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            '"No project" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.',
        });
      const projects = yield* Project.ProjectService;
      const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
      return yield* mutateProjectWithClone(projects, clones, {
        ...input,
        type: "project.delete",
        commandId: yield* newCommandId(),
      }).pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories.SourceControlRepositoryService;
        // Agents' MCP calls have their own long budget, and an aborted call interrupts git.
        return yield* repositories.cloneRepository(input, { timeoutMs: null }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.detail,
              }),
          ),
        );
      }),
    // An existing destination is never adopted.
    { linkedCallers: "allowed" },
  ),
});
