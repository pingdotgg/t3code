import { McpAttachmentInput } from "../attachment/input.ts";
import {
  clampedPositiveInt,
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  ProjectSettingsOverrides,
  ServerSettings as ServerSettingsSchema,
  ThreadEnvMode,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ServerSettings.ServerSettingsService,
    SecureRandom.SecureRandom,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description: "List projects. Pages can shift.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(clampedPositiveInt(100)),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description: "Read one project: workspace and saved scripts.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project folder. `createWorkspaceRootIfMissing` creates it; a registered folder is rejected. No `workspaceRoot`: makes a git repo from `title` with README, icon, first commit (`commitError` on failure; project still exists). Clone first with `t3_project_clone` if needed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description: "Update one project's settings. Omitted fields are unchanged.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description: "Delete one project. Nonempty needs `force: true`. Folder on disk stays.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  dependencies: [
    ...shared.dependencies,
    ProjectCloneTracker.ProjectCloneTracker,
    ManagedProjectFolders.ManagedProjectFolders,
  ],
}).annotate(Tool.Destructive, true);
const setting = <S extends Schema.Top>(value: S) =>
  Schema.Struct({ value, source: Schema.Literals(["project", "environment", "t3.json"]) });
const fields = ServerSettingsSchema.fields;
// Runtime and permission modes, scripts, agent browser/device access, provider
// enablement, submodules, auto-resume and free-text agent instructions are left out:
// each widens what agents may run or what reaches their prompts.
const settingsDependencies = [
  ...shared.dependencies,
  ServerSettings.ServerSettingsService,
  FileSystem.FileSystem,
  Path.Path,
];
const overrides = ProjectSettingsOverrides.fields;
const WRITABLE_PROJECT_SETTINGS = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "defaultAutoPull",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "pullRequestMergeMethod",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
] as const;
const ProjectSettingsView = Schema.Struct({
  projectId: ProjectId,
  settings: Schema.Struct({
    worktreeCleanup: setting(fields.worktreeCleanup),
    defaultModelSelection: setting(fields.defaultModelSelection),
    defaultThreadEnvMode: setting(ThreadEnvMode),
    newWorktreesStartFromOrigin: setting(fields.newWorktreesStartFromOrigin),
    defaultAutoPull: setting(fields.defaultAutoPull),
    textGenerationModelSelection: setting(fields.textGenerationModelSelection),
    sourceControlWriterModelSelection: setting(fields.sourceControlWriterModelSelection),
    reviewGuideModelSelection: setting(fields.reviewGuideModelSelection),
    removeAgentCreditsOnMerge: setting(fields.removeAgentCreditsOnMerge),
    branchNamingMode: setting(fields.branchNamingMode),
    branchNamePrefix: setting(fields.branchNamePrefix),
    pullRequestMergeMethod: setting(fields.pullRequestMergeMethod),
    sidebarAutoSettleOnMerge: setting(fields.sidebarAutoSettleOnMerge),
    sidebarAutoSettleAfterDays: setting(fields.sidebarAutoSettleAfterDays),
    sidebarAutoSettleKeepPullRequests: setting(fields.sidebarAutoSettleKeepPullRequests),
    responseStreamingMode: setting(fields.responseStreamingMode),
  }),
});
const ProjectSettingsReadTool = Tool.make("t3_project_settings_read", {
  ...shared,
  description:
    "Read one project's effective settings and each value's source: `project`, `environment`, or `t3.json`. Scripts are on `t3_project_read`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
  success: ProjectSettingsView,
  dependencies: settingsDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectSettingsUpdateTool = Tool.make("t3_project_settings_update", {
  ...shared,
  description:
    "Set or clear one project's overrides for fields from `t3_project_settings_read` (`responseStreamingMode` is read-only). `clear` restores the environment default. Returns the new settings.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    set: Schema.optionalKey(
      Schema.Struct({
        worktreeCleanup: overrides.worktreeCleanup,
        defaultModelSelection: overrides.defaultModelSelection,
        defaultThreadEnvMode: overrides.defaultThreadEnvMode,
        newWorktreesStartFromOrigin: overrides.newWorktreesStartFromOrigin,
        defaultAutoPull: overrides.defaultAutoPull,
        textGenerationModelSelection: overrides.textGenerationModelSelection,
        sourceControlWriterModelSelection: overrides.sourceControlWriterModelSelection,
        reviewGuideModelSelection: overrides.reviewGuideModelSelection,
        removeAgentCreditsOnMerge: overrides.removeAgentCreditsOnMerge,
        branchNamingMode: overrides.branchNamingMode,
        branchNamePrefix: overrides.branchNamePrefix,
        pullRequestMergeMethod: overrides.pullRequestMergeMethod,
        sidebarAutoSettleOnMerge: overrides.sidebarAutoSettleOnMerge,
        sidebarAutoSettleAfterDays: overrides.sidebarAutoSettleAfterDays,
        sidebarAutoSettleKeepPullRequests: overrides.sidebarAutoSettleKeepPullRequests,
      }),
    ),
    clear: Schema.optionalKey(Schema.Array(Schema.Literals(WRITABLE_PROJECT_SETTINGS))),
  }),
  success: ProjectSettingsView,
  dependencies: [...settingsDependencies, ThreadCommandExecutor.ThreadCommandExecutor],
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository (`destinationPath` new or empty). Register after with `t3_project_create`, with the same `environmentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...SourceControlCloneRepositoryInput.fields,
  }),
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create one new top-level thread, bound to its workspace before the agent starts. Task in `message`. Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours. After an error or lost reply, retry with the same `clientRequestId`. Follow it with `t3_thread_read` or `t3_thread_wait`. Mention it with its `link`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "'worktree': new checkout from `baseRef`. Honor a requested base. Otherwise, independent work uses the default branch as `remote/branch` (e.g. `origin/main`) with `startFromOrigin: true`; with no remote, use the local default branch. Required unpublished commits and dependent or stacked work use their local base with `startFromOrigin: false`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the default, not your worktree. Uncommitted edits are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description: "First prompt. Omit it and `attachments` for idle.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
    /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ProviderRegistry.ProviderRegistry,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    DocumentText.DocumentText,
    Digest.Digest,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectSettingsReadTool,
  ProjectSettingsUpdateTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
