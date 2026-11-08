import * as ServerConfig from "../config.ts";
import {
  BoatSandboxSize,
  EnvironmentId,
  ManagedCloudSandboxResourceId,
  MANAGED_CLOUD_SOURCE_PORT,
  SandboxWorktreeHandoffResult,
  ThreadId,
  ProjectId,
  WorktreeMcpFailure,
  WorktreeMcpHandoffInput,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  managedCloudSandboxProxyPath,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as GitDriver from "../vcs/GitVcsDriver.ts";
import { PrepareSandboxBranchTool } from "./CloudSandboxWorkspaceTools.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Controller from "./CloudSandboxController.ts";
import * as Manager from "../cloudSandbox/CloudSandboxManager.ts";
import type { ManagedCloudSandboxConnection, SandboxProfileId } from "@t3tools/contracts";
import * as Profiles from "../cloudSandbox/CloudSandboxProfiles.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as ProjectTransfer from "./CloudSandboxProjectTransfer.ts";

const Record = Schema.Struct({
  workspaceId: ManagedCloudSandboxResourceId,
  sourceThreadId: ThreadId,
  requestJson: Schema.String,
  phase: Schema.Literals(["creating", "running", "deleting", "resource-deleted", "deleted"]),
  childEnvironmentId: Schema.optionalKey(EnvironmentId),
  result: Schema.NullOr(SandboxWorktreeHandoffResult),
});
const SetupStatus = Schema.Literals(["started", "completed"]);
const decodeSetupStatus = Schema.decodeUnknownEffect(SetupStatus);
const decodeResourceId = Schema.decodeEffect(ManagedCloudSandboxResourceId);
const decodeSize = Schema.decodeUnknownEffect(BoatSandboxSize);
const isWorktreeFailure = Schema.is(WorktreeMcpFailure);
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Record));
const encode = Schema.encodeEffect(Schema.fromJsonString(Record));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(WorktreeMcpHandoffInput));
const failure = (message: string) => new WorktreeMcpFailure({ code: "operation_failed", message });
const invalid = (message: string) => new WorktreeMcpFailure({ code: "invalid_request", message });
const encodeTaskRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const workspaceScope = (scope: McpThreadInvocationScope, workspaceId: string) =>
  ({
    ...scope,
    requestNamespace: `cloud-workspace:${workspaceId}`,
  }) satisfies McpThreadInvocationScope;

interface AcquiredWorkspace {
  readonly connection: ManagedCloudSandboxConnection;
  readonly pairingToken: string;
  readonly linkUrl: string;
  /** Copies the source checkout in; resolves to the checkout path inside the sandbox. */
  readonly prepareCheckout?: Effect.Effect<string, WorktreeMcpFailure>;
}

export class CloudSandboxWorkspaces extends Context.Service<
  CloudSandboxWorkspaces,
  {
    readonly setupThread: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly completed: true }, WorktreeMcpFailure>;
    readonly prepareBranch: (
      projectId: ProjectId,
      branch: string,
    ) => Effect.Effect<{ readonly branch: string }, WorktreeMcpFailure>;
    readonly handoff: (
      scope: McpThreadInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<SandboxWorktreeHandoffResult, WorktreeMcpFailure>;
    readonly remove: (
      scope: McpThreadInvocationScope,
      workspaceId: string,
    ) => Effect.Effect<
      { readonly workspaceId: string; readonly deleted: boolean },
      WorktreeMcpFailure
    >;
    readonly sharePreview: (
      port: number,
    ) => Effect.Effect<
      { readonly url: string; readonly port: number; readonly isPublic: boolean },
      WorktreeMcpFailure
    >;
    /**
     * Delegates one task into a fresh ephemeral sandbox workspace provisioned
     * from a configured profile. The fleet primitive: each call gets its own
     * disposable sandbox.
     */
    readonly delegateSandboxTask: (
      scope: McpThreadInvocationScope,
      input: {
        readonly task: string;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly title?: string | undefined;
        readonly branch: string;
        readonly workspaceId: string;
        readonly size?: string | undefined;
        readonly autoStopMinutes?: number | undefined;
        readonly profile?: SandboxProfileId | undefined;
        readonly runSetupScript: boolean;
      },
    ) => Effect.Effect<SandboxWorktreeHandoffResult, WorktreeMcpFailure>;
    /**
     * Reclaims sandbox workspaces whose source thread is gone and whose VM has
     * already stopped, deleting their disk and peer link. A workspace still
     * being created is also reclaimed once its VM has stopped, even while its
     * source thread lives.
     */
    readonly sweep: Effect.Effect<number, WorktreeMcpFailure>;
    /**
     * Points each managed child's peer link at this server's current port.
     * Does nothing where the controller reaches children directly.
     */
    readonly repointLinks: Effect.Effect<number, WorktreeMcpFailure>;
    /** Forks the periodic sweep and link repointing; call once per server start. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/workspace/CloudSandboxWorkspaces") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* Git.GitWorkflowService;
  const driver = yield* GitDriver.GitVcsDriver;
  const controller = yield* Controller.CloudSandboxController;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const delegation = yield* RemoteDelegation.RemoteDelegation;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const setup = yield* Setup.ProjectSetupScriptRunner;
  const manager = yield* Manager.CloudSandboxManager;
  const profiles = yield* Profiles.CloudSandboxProfiles;
  const transfer = yield* ProjectTransfer.CloudSandboxProjectTransfer;
  const lock = yield* KeyedLock.make<string>();
  const localServerPort = readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.orElseSucceed(() => Option.none()),
    Effect.map((state) => (Option.isSome(state) ? state.value.port : config.port)),
  );
  const load = Effect.fn("CloudSandboxWorkspaces.load")(
    function* (workspaceId: ManagedCloudSandboxResourceId) {
      const rows = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM cloud_sandbox_workspaces WHERE workspace_id = ${workspaceId}`;
      return rows[0] ? yield* decode(rows[0].payload_json).pipe(Effect.asSome) : Option.none();
    },
    Effect.mapError(() => failure("Unable to read the cloud workspace journal.")),
  );
  const save = Effect.fn("CloudSandboxWorkspaces.save")(
    function* (record: typeof Record.Type) {
      const json = yield* encode(record);
      yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id, source_thread_id, payload_json)
      VALUES (${record.workspaceId}, ${record.sourceThreadId}, ${json})
      ON CONFLICT(workspace_id) DO UPDATE SET payload_json = excluded.payload_json`;
    },
    Effect.mapError(() => failure("Unable to persist the cloud workspace journal.")),
  );
  const loadSetupStatus = Effect.fn("CloudSandboxWorkspaces.loadSetupStatus")(
    function* (threadId: ThreadId) {
      const rows = yield* sql<{
        readonly status: string;
      }>`SELECT status FROM cloud_sandbox_thread_setups WHERE thread_id = ${threadId}`;
      return rows[0] ? yield* decodeSetupStatus(rows[0].status).pipe(Effect.asSome) : Option.none();
    },
    Effect.mapError(() => failure("Unable to read the child setup journal.")),
  );
  const saveSetupStatus = Effect.fn("CloudSandboxWorkspaces.saveSetupStatus")(
    function* (threadId: ThreadId, status: typeof SetupStatus.Type) {
      yield* sql`INSERT INTO cloud_sandbox_thread_setups (thread_id, status)
      VALUES (${threadId}, ${status})
      ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status`;
    },
    Effect.mapError(() => failure("Unable to persist the child setup journal.")),
  );
  /**
   * Pairs a fresh sandbox connection into this environment, mirrors the source
   * project there, and prepares the workspace branch. Shared by the in-sandbox
   * handoff and the root-side ephemeral fleet.
   */
  const attachProject = Effect.fn("CloudSandboxWorkspaces.attachProject")(function* (
    scope: McpThreadInvocationScope,
    input: {
      readonly connection: ManagedCloudSandboxConnection;
      readonly pairingToken: string;
      readonly linkUrl: string;
      readonly sourceProjectId: ProjectId;
      readonly branch: string;
      readonly workspacePath?: string;
    },
  ) {
    const parent = yield* threads
      .getThreadRecords(scope.thread.threadId, [])
      .pipe(Effect.mapError(() => failure("Unable to read the source thread.")));
    const project = yield* projects
      .getById(input.sourceProjectId)
      .pipe(Effect.mapError(() => failure("Unable to read the source project.")));
    if (Option.isNone(project)) return yield* invalid("The source project no longer exists.");
    const linked = yield* links
      .get(input.connection.environmentId)
      .pipe(Effect.mapError(() => failure("Unable to inspect the child peer link.")));
    if (Option.isNone(linked)) {
      yield* links
        .link({
          url: input.linkUrl,
          pairingCode: input.pairingToken,
          access: parent.thread.runtimeMode,
          expectedEnvironmentId: input.connection.environmentId,
          expectedLabel: input.connection.label,
        })
        .pipe(
          Effect.mapError(() =>
            failure("Unable to pair the sandbox. Enable Linked environments on both environments."),
          ),
        );
    }
    const workspacePath =
      input.workspacePath ?? parent.thread.worktreePath ?? project.value.workspaceRoot;
    let childProjectId: ProjectId | undefined;
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: import("effect/ai/Tool").Success<typeof ProjectToolkit.tools.t3_project_list> =
        yield* forwarding
          .call(scope, ProjectToolkit.tools.t3_project_list, input.connection.environmentId, {
            cursor,
            limit: 100,
          })
          .pipe(Effect.mapError(() => failure("Unable to inspect projects in the sandbox.")));
      childProjectId =
        listed.projects.find((candidate) => candidate.workspaceRoot === workspacePath)?.id ??
        childProjectId;
      cursor = listed.nextCursor;
    }
    if (!childProjectId) {
      const created = yield* forwarding
        .call(scope, ProjectToolkit.tools.t3_project_create, input.connection.environmentId, {
          title: project.value.title,
          scripts: project.value.scripts,
          workspaceRoot: workspacePath,
        })
        .pipe(Effect.mapError(() => failure("Unable to register the project in the sandbox.")));
      childProjectId = created.id;
    }
    yield* forwarding
      .call(scope, PrepareSandboxBranchTool, input.connection.environmentId, {
        projectId: childProjectId,
        branch: input.branch,
      })
      .pipe(Effect.mapError(() => failure("Unable to prepare the branch in the sandbox.")));
    return { childProjectId, workspacePath };
  });
  /** The in-sandbox handoff and the root fleet share one resource resolution. */
  const provisionWorkspace = Effect.fn("CloudSandboxWorkspaces.provisionWorkspace")(
    function* (
      workspaceId: string,
      input: {
        readonly name: string;
        readonly size?: string | undefined;
        readonly autoStopMinutes?: number | undefined;
        readonly profile?: SandboxProfileId | undefined;
      },
    ) {
      const decoded = yield* decodeResourceId(workspaceId).pipe(
        Effect.mapError(() => invalid("Invalid workspace id.")),
      );
      const listed = yield* profiles.list.pipe(
        Effect.mapError((cause) => invalid(`Unable to read sandbox profiles: ${cause.message}`)),
      );
      const profile = Option.fromNullishOr(
        input.profile !== undefined
          ? listed.find(({ profile }) => profile.profileId === input.profile)?.profile
          : listed[0]?.profile,
      );
      if (Option.isNone(profile))
        return yield* invalid(
          input.profile === undefined
            ? "No sandbox profile is configured. Add one in Settings → Environments → Add environment."
            : "The requested sandbox profile does not exist.",
        );
      const size = yield* decodeSize(input.size ?? profile.value.defaultSize ?? "default").pipe(
        Effect.mapError(() => invalid("Unsupported sandbox size.")),
      );
      const route = yield* manager.provision({
        operationId: decoded,
        profile: profile.value.profileId,
        sandbox: {
          requestId: workspaceId,
          ...(profile.value.template === null ? {} : { template: profile.value.template }),
          name: input.name,
          size,
          autoStopMinutes: input.autoStopMinutes ?? profile.value.autoStopMinutes,
        },
        enableLinkedEnvironments: true,
      });
      const controllerPort = yield* localServerPort;
      if (controllerPort <= 0) return yield* failure("Unable to determine the local server port.");
      return { route, base: `http://127.0.0.1:${controllerPort}` };
    },
    Effect.mapError(
      (
        cause:
          | WorktreeMcpFailure
          | import("../cloudSandbox/CloudSandboxStore.ts").CloudSandboxManagerError,
      ) =>
        isWorktreeFailure(cause) ? cause : invalid(`Sandbox allocation failed: ${cause.message}`),
    ),
  );
  /** A disk fork of the sandbox this controller runs in; the fork is the child's own sandbox. */
  const forkFromController = Effect.fn("CloudSandboxWorkspaces.forkFromController")(function* (
    workspaceId: ManagedCloudSandboxResourceId,
    branch: string,
    size: string | undefined,
    autoStopMinutes: number | undefined,
  ) {
    const fork = yield* controller.request({
      _tag: "fork",
      enableLinkedEnvironments: true,
      operationId: workspaceId,
      name: branch,
      ...(size === undefined ? {} : { size }),
      ...(autoStopMinutes === undefined ? {} : { autoStopMinutes }),
    });
    if (fork._tag !== "connection")
      return yield* failure("The controller did not return the forked environment.");
    return {
      connection: fork.connection,
      pairingToken: fork.pairingToken,
      linkUrl: fork.connection.routePrefix,
    } satisfies AcquiredWorkspace;
  });
  const releaseResource = Effect.fn("CloudSandboxWorkspaces.releaseResource")(function* (
    resourceId: ManagedCloudSandboxResourceId,
  ) {
    if (yield* controller.available) yield* controller.request({ _tag: "delete", resourceId });
    else
      yield* manager
        .release(resourceId)
        .pipe(Effect.mapError(() => failure("Unable to delete the sandbox workspace.")));
  });
  const inspectResource = Effect.fn("CloudSandboxWorkspaces.inspectResource")(function* (
    resourceId: ManagedCloudSandboxResourceId,
  ) {
    if (!(yield* controller.available)) return yield* manager.get(resourceId);
    const result = yield* controller.request({ _tag: "get", resourceId });
    if (result._tag !== "resource")
      return yield* failure("Unable to inspect the sandbox resource.");
    return result.resource;
  });
  const inspectPowerState = Effect.fn("CloudSandboxWorkspaces.inspectPowerState")(function* (
    resourceId: ManagedCloudSandboxResourceId,
  ) {
    if (!(yield* controller.available)) return yield* manager.execute(resourceId, { _tag: "get" });
    const result = yield* controller.request({ _tag: "status", resourceId });
    if (result._tag !== "result")
      return yield* failure("Unable to inspect the sandbox power state.");
    return result.result;
  });
  /**
   * Deletes sandbox workspaces whose VM has already stopped and that are
   * orphaned: their source thread is gone, or they never finished creating.
   * Active children and live VMs are never touched.
   */
  const sweepOnce = Effect.fn("CloudSandboxWorkspaces.sweep")(function* () {
    const rows = yield* sql<{
      readonly workspace_id: string;
      readonly payload_json: string;
    }>`SELECT workspace_id, payload_json FROM cloud_sandbox_workspaces`.pipe(
      Effect.mapError(() => failure("Unable to read the cloud workspace journal.")),
    );
    let reclaimed = 0;
    for (const row of rows) {
      const didReclaim = yield* Effect.gen(function* () {
        const record = yield* decode(row.payload_json).pipe(Effect.option);
        if (Option.isNone(record) || record.value.phase === "deleted") return false;
        const shell = yield* threads
          .getThreadShell(record.value.sourceThreadId)
          .pipe(Effect.mapError(() => failure("Unable to inspect the source thread.")));
        const orphaned = shell === null || shell.deletedAt !== null;
        const childEnvironmentId =
          record.value.childEnvironmentId ?? record.value.result?.environmentId ?? null;
        const resourceId = record.value.workspaceId;
        const resource = yield* inspectResource(resourceId).pipe(Effect.option);
        if (Option.isNone(resource)) return false;
        if (resource.value.phase !== "deleted") {
          if (!orphaned && record.value.phase !== "creating") return false;
          const status = yield* inspectPowerState(resourceId).pipe(Effect.option);
          if (
            Option.isNone(status) ||
            status.value._tag !== "status" ||
            status.value.sandbox.state !== "stopped"
          ) {
            return false;
          }
          const deleted = yield* releaseResource(resourceId).pipe(Effect.result);
          if (deleted._tag === "Failure") return false;
        }
        if (childEnvironmentId !== null) {
          yield* links
            .unlink(childEnvironmentId)
            .pipe(Effect.mapError(() => failure("Unable to unlink the deleted workspace.")));
        }
        yield* save({ ...record.value, phase: "deleted" });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to reclaim cloud workspace; continuing sweep.", {
            workspaceId: row.workspace_id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (didReclaim) reclaimed++;
    }
    return reclaimed;
  });
  /**
   * A managed child reaches this server through the port its runtime state
   * file last recorded, which changes across restarts.
   */
  const repointLinks = Effect.fn("CloudSandboxWorkspaces.repointLinks")(function* () {
    if (yield* controller.available) return 0;
    const port = yield* localServerPort;
    if (port <= 0) return 0;
    const rows = yield* sql<{
      readonly workspace_id: string;
      readonly payload_json: string;
    }>`SELECT workspace_id, payload_json FROM cloud_sandbox_workspaces`.pipe(
      Effect.mapError(() => failure("Unable to read the cloud workspace journal.")),
    );
    let repointed = 0;
    for (const row of rows) {
      const didRepoint = yield* Effect.gen(function* () {
        const record = yield* decode(row.payload_json);
        if (
          record.phase === "deleted" ||
          record.phase === "resource-deleted" ||
          record.childEnvironmentId === undefined
        )
          return false;
        yield* links.repoint(
          record.childEnvironmentId,
          `http://127.0.0.1:${port}${managedCloudSandboxProxyPath(record.workspaceId)}`,
        );
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to repoint cloud workspace link; continuing.", {
            workspaceId: row.workspace_id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (didRepoint) repointed++;
    }
    return repointed;
  });
  /**
   * The journal is the source of truth for one workspace id: a retry with the
   * same request returns the stored result, and any other request is refused.
   */
  const createWorkspace = Effect.fn("CloudSandboxWorkspaces.createWorkspace")(function* (
    scope: McpThreadInvocationScope,
    input: {
      readonly workspaceId: ManagedCloudSandboxResourceId;
      readonly requestJson: string;
      readonly branch: string;
      readonly note: string;
      readonly acquire: Effect.Effect<AcquiredWorkspace, WorktreeMcpFailure>;
      readonly delegate: (acquired: {
        readonly connection: ManagedCloudSandboxConnection;
        readonly childProjectId: ProjectId;
      }) => Effect.Effect<
        Pick<SandboxWorktreeHandoffResult, "taskId" | "threadId" | "projectId">,
        WorktreeMcpFailure
      >;
    },
  ) {
    const { workspaceId, requestJson } = input;
    const requestScope = workspaceScope(scope, workspaceId);
    return yield* lock.withLock(
      workspaceId,
      Effect.gen(function* () {
        if (!(yield* links.enabled))
          return yield* invalid(
            "Enable Linked environments in Settings → Labs before sandbox isolation.",
          );
        const previous = yield* load(workspaceId);
        if (Option.isSome(previous)) {
          if (
            previous.value.sourceThreadId !== scope.thread.threadId ||
            previous.value.requestJson !== requestJson
          )
            return yield* invalid("This workspace id already belongs to another request.");
          if (
            previous.value.phase === "deleted" ||
            previous.value.phase === "deleting" ||
            previous.value.phase === "resource-deleted"
          )
            return yield* invalid("This cloud workspace is being deleted or has been deleted.");
          if (previous.value.result) return previous.value.result;
        }
        let record: typeof Record.Type = {
          ...(Option.isSome(previous) ? previous.value : {}),
          workspaceId,
          sourceThreadId: scope.thread.threadId,
          requestJson,
          phase: "creating",
          result: null,
        };
        yield* save(record);
        const acquired = yield* input.acquire;
        record = { ...record, childEnvironmentId: acquired.connection.environmentId };
        yield* save(record);
        let workspacePath: string | undefined;
        if (acquired.prepareCheckout) workspacePath = yield* acquired.prepareCheckout;
        const parent = yield* threads
          .getThreadRecords(scope.thread.threadId, [])
          .pipe(Effect.mapError(() => failure("Unable to read the source thread.")));
        const attached = yield* attachProject(requestScope, {
          connection: acquired.connection,
          pairingToken: acquired.pairingToken,
          linkUrl: acquired.linkUrl,
          sourceProjectId: parent.thread.projectId,
          branch: input.branch,
          ...(workspacePath === undefined ? {} : { workspacePath }),
        });
        const delegated = yield* input.delegate({
          connection: acquired.connection,
          childProjectId: attached.childProjectId,
        });
        const result: SandboxWorktreeHandoffResult = {
          kind: "sandbox",
          workspaceId,
          resourceId: acquired.connection.resourceId,
          environmentId: acquired.connection.environmentId,
          projectId: delegated.projectId,
          threadId: delegated.threadId,
          taskId: delegated.taskId,
          workspacePath: attached.workspacePath,
          branch: input.branch,
          note: input.note,
        };
        yield* save({ ...record, phase: "running", result });
        return result;
      }),
    );
  });
  const every = <A, E>(interval: Duration.Input, tick: Effect.Effect<A, E>, stopped: string) =>
    tick.pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep(interval)),
      Effect.forever,
      Effect.catchCause((cause) => Effect.logWarning(stopped, cause)),
      Effect.forkScoped,
      Effect.asVoid,
    );
  return CloudSandboxWorkspaces.of({
    setupThread: Effect.fn("CloudSandboxWorkspaces.setupThread")(function* (projectId, threadId) {
      if (!(yield* controller.available))
        return yield* invalid("Setup requires a managed sandbox.");
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure("Unable to read child project.")));
      const child = yield* threads
        .getThreadRecords(threadId, [])
        .pipe(Effect.mapError(() => failure("Unable to read child thread.")));
      if (Option.isNone(project) || child.thread.projectId !== projectId)
        return yield* invalid("The child thread must belong to this project.");
      return yield* lock.withLock(
        `setup:${threadId}`,
        Effect.gen(function* () {
          const previous = yield* loadSetupStatus(threadId);
          if (Option.isSome(previous)) {
            if (previous.value === "completed") return { completed: true as const };
            return yield* failure(
              "Child setup failed or was interrupted. Inspect its setup terminal before continuing; setup will not run twice.",
            );
          }
          yield* saveSetupStatus(threadId, "started");
          const started = yield* setup
            .runForThread({
              threadId,
              projectId,
              worktreePath: project.value.workspaceRoot,
              observeCompletion: {},
            })
            .pipe(
              Effect.mapError(() =>
                failure("Child setup could not start. Inspect the child thread."),
              ),
            );
          if (started.status === "skipped-for-link")
            return yield* failure("The child link does not permit project setup scripts.");
          if (started.status === "started") {
            if (!started.completion)
              return yield* failure("Child setup completion could not be observed.");
            const completion = yield* started.completion;
            if (completion.exitCode !== 0)
              return yield* failure(
                "Child setup failed. Inspect its setup terminal; continuation was not started.",
              );
          }
          yield* saveSetupStatus(threadId, "completed");
          return { completed: true as const };
        }),
      );
    }),
    prepareBranch: Effect.fn("CloudSandboxWorkspaces.prepareBranch")(function* (projectId, branch) {
      if (!(yield* controller.available))
        return yield* invalid("Branch preparation requires a managed sandbox.");
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure("Unable to inspect the sandbox project.")));
      if (Option.isNone(project))
        return yield* invalid("The project does not exist in this sandbox.");
      const cwd = project.value.workspaceRoot;
      return yield* lock.withLock(
        cwd,
        Effect.gen(function* () {
          const current = yield* git
            .currentBranch(cwd)
            .pipe(Effect.mapError(() => failure("Unable to inspect the sandbox checkout.")));
          if (current === branch) return { branch };
          const exists = yield* git
            .hasRefNamed({ cwd, refName: branch })
            .pipe(Effect.mapError(() => failure("Unable to inspect sandbox branches.")));
          if (exists) return yield* invalid("The requested sandbox branch already exists.");
          yield* driver
            .execute({
              operation: "CloudSandboxWorkspaces.prepareBranch",
              cwd,
              args: ["switch", "-c", branch, "--"],
            })
            .pipe(Effect.mapError(() => failure("Unable to create the sandbox branch.")));
          yield* git.invalidateLocalStatus(cwd);
          return { branch };
        }),
      );
    }),
    handoff: Effect.fn("CloudSandboxWorkspaces.handoff")(function* (scope, input) {
      if (input.isolation?.kind !== "sandbox")
        return yield* invalid("Sandbox isolation must be requested explicitly.");
      const isolation = input.isolation;
      const workspaceId = isolation.operationId;
      if (!(yield* controller.available))
        return yield* invalid("Sandbox isolation requires a managed cloud environment.");
      if (input.baseRef !== undefined || input.startFromOrigin === true)
        return yield* invalid(
          "A disk fork preserves the current checkout, including uncommitted files. Use filesystem isolation to start from another ref.",
        );
      const requestJson = yield* encodeRequest(input).pipe(
        Effect.mapError(() => invalid("The workspace request is invalid.")),
      );
      return yield* createWorkspace(scope, {
        workspaceId,
        requestJson,
        branch: input.branch,
        note: "The continuation runs in a separate disk-forked environment. The source thread history stays here. Deleting this owned workspace deletes its sandbox; archiving the thread does not.",
        acquire: forkFromController(
          workspaceId,
          input.branch,
          isolation.size,
          isolation.autoStopMinutes,
        ),
        delegate: ({ connection, childProjectId }) =>
          delegation
            .delegateWorkspace(
              workspaceScope(scope, workspaceId),
              {
                task:
                  input.continuationPrompt ??
                  "Continue work in this isolated sandbox workspace. Inspect the copied checkout before making changes.",
                target: {
                  environmentId: connection.environmentId,
                  projectId: childProjectId,
                },
                clientRequestId: `cloud-workspace:${workspaceId}`,
                role: "implementation",
              },
              { type: "root", branch: input.branch },
              input.runSetupScript !== false,
            )
            .pipe(
              Effect.mapError((cause) =>
                failure(
                  `Unable to start the continuation in the fork: ${cause.message} Retry the same operation ID.`,
                ),
              ),
            ),
      });
    }),
    remove: Effect.fn("CloudSandboxWorkspaces.remove")(function* (scope, workspaceId) {
      const resourceId = yield* decodeResourceId(workspaceId).pipe(
        Effect.mapError(() => invalid("Invalid owned sandbox resource ID.")),
      );
      return yield* lock.withLock(
        resourceId,
        Effect.gen(function* () {
          const saved = yield* load(resourceId);
          if (Option.isNone(saved) || saved.value.sourceThreadId !== scope.thread.threadId)
            return yield* invalid("The calling thread does not own this cloud workspace.");
          const record = saved.value;
          if (record.phase === "deleted") return { workspaceId, deleted: true };
          if (record.phase !== "resource-deleted") {
            yield* save({ ...record, phase: "deleting" });
            if (record.result) {
              // Deleting the VM stops the child's work anyway, so an unreachable proxy must not block cleanup.
              yield* forwarding
                .interruptThread(scope, record.result.environmentId, {
                  threadId: record.result.threadId,
                })
                .pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catch((cause) =>
                    Effect.logWarning("Unable to stop active work in the child workspace.", {
                      workspaceId,
                      cause,
                    }),
                  ),
                );
            }
            yield* releaseResource(record.workspaceId);
            yield* save({ ...record, phase: "resource-deleted" });
          }
          const childEnvironmentId = record.childEnvironmentId ?? record.result?.environmentId;
          if (childEnvironmentId)
            yield* links
              .unlink(childEnvironmentId)
              .pipe(
                Effect.mapError(() =>
                  failure(
                    "The sandbox was deleted, but its peer link could not be removed. Retry cleanup.",
                  ),
                ),
              );
          yield* save({ ...record, phase: "deleted" });
          return { workspaceId, deleted: true };
        }),
      );
    }),
    sharePreview: Effect.fn("CloudSandboxWorkspaces.sharePreview")(function* (port) {
      if (!(yield* controller.available))
        return yield* invalid("Preview sharing requires a managed cloud environment.");
      const controllerPort = yield* localServerPort;
      if (port === controllerPort || port === config.port || port === MANAGED_CLOUD_SOURCE_PORT)
        return yield* invalid("The environment control server cannot be shared as a preview.");
      const hosted = yield* controller.request({ _tag: "host", port });
      if (hosted._tag !== "result" || hosted.result._tag !== "host")
        return yield* failure("The controller did not return a hosted preview URL.");
      return hosted.result.port;
    }),
    delegateSandboxTask: Effect.fn("CloudSandboxWorkspaces.delegateSandboxTask")(
      function* (scope, input) {
        const workspaceId = yield* decodeResourceId(input.workspaceId).pipe(
          Effect.mapError(() => invalid("Invalid owned sandbox resource ID.")),
        );
        // Inside a managed sandbox, fork its own controller; on the root server,
        // provision from the profile the way a worktree is created.
        const inSandbox = yield* controller.available;
        const acquire = inSandbox
          ? forkFromController(workspaceId, input.branch, input.size, input.autoStopMinutes)
          : Effect.gen(function* () {
              const parent = yield* threads
                .getThreadRecords(scope.thread.threadId, [])
                .pipe(Effect.mapError(() => failure("Unable to read the source thread.")));
              const sourceProject = yield* projects
                .getById(parent.thread.projectId)
                .pipe(Effect.mapError(() => failure("Unable to inspect the source project.")));
              if (Option.isNone(sourceProject))
                return yield* invalid("The source project no longer exists.");
              const allocated = yield* provisionWorkspace(workspaceId, {
                name: input.branch,
                ...(input.size === undefined ? {} : { size: input.size }),
                ...(input.autoStopMinutes === undefined
                  ? {}
                  : { autoStopMinutes: input.autoStopMinutes }),
                ...(input.profile === undefined ? {} : { profile: input.profile }),
              });
              const connection = allocated.route.connection;
              return {
                connection,
                pairingToken: allocated.route.pairingToken,
                linkUrl: `${allocated.base}${connection.routePrefix}`,
                prepareCheckout: transfer.transfer({
                  resourceId: connection.resourceId,
                  cwd: parent.thread.worktreePath ?? sourceProject.value.workspaceRoot,
                }),
              } satisfies AcquiredWorkspace;
            });
        const requestJson = yield* encodeTaskRequest({
          task: input.task,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          title: input.title,
          branch: input.branch,
          size: input.size,
          autoStopMinutes: input.autoStopMinutes,
          profile: input.profile,
        }).pipe(Effect.mapError(() => invalid("The workspace request is invalid.")));
        return yield* createWorkspace(scope, {
          workspaceId,
          requestJson,
          branch: input.branch,
          note: "The task runs in a disposable sandbox workspace. It is reclaimed automatically once its source thread is deleted and the sandbox has stopped; deleting it earlier removes the sandbox.",
          acquire,
          delegate: ({ connection, childProjectId }) =>
            delegation
              .delegateWorkspace(
                workspaceScope(scope, input.workspaceId),
                {
                  task: input.task,
                  target: {
                    environmentId: connection.environmentId,
                    projectId: childProjectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    model: input.modelSelection.model,
                    ...(input.modelSelection.options === undefined
                      ? {}
                      : { options: input.modelSelection.options }),
                  },
                  runtimeMode: input.runtimeMode,
                  interactionMode: input.interactionMode,
                  ...(input.title === undefined ? {} : { title: input.title }),
                  clientRequestId: `cloud-workspace:${input.workspaceId}`,
                  role: "implementation",
                },
                { type: "root", branch: input.branch },
                input.runSetupScript,
              )
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    `Unable to start the task in the sandbox: ${cause.message} Retry the same workspace id.`,
                  ),
                ),
              ),
        });
      },
    ),
    sweep: sweepOnce(),
    repointLinks: repointLinks(),
    /**
     * Reclaim-safe on failure: a sweep that cannot read the journal tries
     * again at the next tick. Link repointing retries each minute because the
     * runtime state file may still hold the previous port when start() runs.
     */
    start: Effect.fn("CloudSandboxWorkspaces.start")(() =>
      Effect.all(
        [
          every("30 minutes", sweepOnce(), "Cloud workspace sweep stopped."),
          every("1 minute", repointLinks(), "Cloud workspace link repointing stopped."),
        ],
        { discard: true },
      ),
    ),
  });
});
export const layer = Layer.effect(CloudSandboxWorkspaces, make).pipe(
  Layer.provide(ProjectTransfer.layer),
);
