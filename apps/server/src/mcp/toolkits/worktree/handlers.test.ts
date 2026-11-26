// `t3_worktree_handoff` through its real access declaration, the real WorktreeMcpService and the
// real TaskFolders over real Git; only the orchestrator, the project record and the setup-script
// runner are stand-ins.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ManagedPolicySummary,
  type Project,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  type WorktreeMcpHandoffResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as TaskFolders from "../../../workspace/TaskFolders.ts";
import {
  approveLayoutCommands,
  layerTaskFoldersWithGit,
  taskFoldersTestProjectId as projectId,
  type TaskFoldersTestState,
} from "../../../workspace/TaskFolders.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:handoff");

interface Modes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const belowFullAccess: ReadonlyArray<Modes> = [
  { runtimeMode: "approval-required", interactionMode: "default" },
  { runtimeMode: "approval-required", interactionMode: "plan" },
  { runtimeMode: "auto-accept-edits", interactionMode: "default" },
  { runtimeMode: "auto", interactionMode: "default" },
  { runtimeMode: "full-access", interactionMode: "plan" },
];

type HandoffServices =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagementService.ThreadManagementService
  | WorktreeMcpService.WorktreeMcpService
  | TaskFolders.TaskFolders
  | Layer.Success<ReturnType<typeof layerTaskFoldersWithGit>>
  | FileSystem.FileSystem;

/**
 * A project folder that is one repository, and the handoff tool as a live thread in `modes`
 * calls it. `layout` writes a `worktreeLayout` whose create command leaves a marker file.
 */
const handoffFrom = <A, E>(
  modes: Modes,
  test: (context: {
    readonly handoff: Effect.Effect<
      WorktreeMcpHandoffResult & { readonly message?: string },
      never,
      HandoffServices
    >;
    readonly writeLayout: Effect.Effect<void>;
    readonly layoutRan: Effect.Effect<boolean>;
    readonly setupScriptRuns: ReadonlyArray<string>;
  }) => Effect.Effect<A, E, HandoffServices>,
  managedPolicy?: ManagedPolicySummary,
) => {
  const state: TaskFoldersTestState = { workspaceRoot: "/unset", trackedFolders: [], thread: null };
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:handoff"),
    requestNamespace: "provider-session:handoff",
    thread: {
      threadId,
      providerSessionId: "provider-session:handoff",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration", "worktree", "pull-requests", "issues"]),
    issuedAt: 0,
  };
  const shell = () => ({ ...McpToolAccessTestkit.liveThreadShell(threadId, modes), projectId });
  const setupScriptRuns: Array<string> = [];
  const git = GitVcsDriver.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const service = WorktreeMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell())),
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Project",
              workspaceRoot: state.workspaceRoot,
              scripts: [],
            } as unknown as Project),
        }),
        Layer.unwrap(
          Effect.gen(function* () {
            const driver = yield* GitVcsDriver.GitVcsDriver;
            return Layer.mock(GitWorkflowService.GitWorkflowService)({
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: false,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              listLocalBranchNames: driver.listLocalBranchNames,
              createWorktree: driver.createWorktree,
            });
          }),
        ),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.sync(() => {
              setupScriptRuns.push(input.worktreePath);
              return { status: "no-script" } as const;
            }),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus: () => Effect.die("unused"),
        }),
        ServerSettings.layerTest({}, managedPolicy),
      ),
    ),
    Layer.provideMerge(
      layerTaskFoldersWithGit(
        state,
        managedPolicy === undefined
          ? undefined
          : {
              schemaVersion: 1,
              organization: managedPolicy.organization,
              ...(managedPolicy.limits === undefined ? {} : { limits: managedPolicy.limits }),
            },
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    service,
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell()),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
  ).pipe(Layer.provideMerge(git));

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const tmp = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-handoff-" }),
    );
    const run = (cwd: string, ...args: ReadonlyArray<string>) =>
      driver.execute({ operation: "handoff-test", cwd, args });
    const project = path.join(tmp, "project");
    yield* fileSystem.makeDirectory(project, { recursive: true });
    yield* run(project, "init", "-b", "main");
    yield* run(project, "config", "user.email", "handoff@example.test");
    yield* run(project, "config", "user.name", "Handoff");
    yield* fileSystem.writeFileString(path.join(project, "README.md"), "project\n");
    yield* run(project, "add", ".");
    yield* run(project, "commit", "-m", "initial");
    state.workspaceRoot = project;
    const marker = path.join(tmp, "ran");

    const toolkit = yield* WorktreeToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer)),
    );
    return yield* test({
      handoff: toolkit
        .handle("t3_worktree_handoff", { branch: "handed-off", startFromOrigin: false })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map(
            (results) =>
              results.at(-1)?.result as WorktreeMcpHandoffResult & { readonly message?: string },
          ),
          Effect.orDie,
        ),
      writeLayout: fileSystem
        .writeFileString(
          path.join(project, "t3.json"),
          JSON.stringify({
            worktreeLayout: {
              create: `touch "${marker}" && git worktree add -q -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH"`,
            },
          }),
        )
        .pipe(Effect.orDie),
      layoutRan: fileSystem.exists(marker).pipe(Effect.orDie),
      setupScriptRuns,
    });
  }).pipe(Effect.provide(dependencies), Effect.scoped);
};

it.live.each(belowFullAccess)(
  "t3_worktree_handoff from a $runtimeMode/$interactionMode thread leaves an approved layout command unrun",
  (modes) =>
    handoffFrom(modes, ({ handoff, writeLayout, layoutRan, setupScriptRuns }) =>
      Effect.gen(function* () {
        yield* writeLayout;
        yield* approveLayoutCommands;

        const result = yield* handoff;

        assert.include(result.message, "only have run from a thread in Full access");
        assert.isUndefined(result.worktreePath);
        assert.isFalse(yield* layoutRan);
        assert.deepEqual(setupScriptRuns, []);
      }),
    ),
);

it.live.each(belowFullAccess)(
  "t3_worktree_handoff from a $runtimeMode/$interactionMode thread leaves the setup script unrun",
  (modes) =>
    handoffFrom(modes, ({ handoff, setupScriptRuns }) =>
      Effect.gen(function* () {
        const result = yield* handoff;

        assert.isString(result.worktreePath);
        assert.deepEqual(result.setupScript, { status: "skipped" });
        assert.include(result.note, "Project setup scripts do not run");
        assert.deepEqual(setupScriptRuns, []);
      }),
    ),
);

it.live("t3_worktree_handoff from a Full access thread runs an approved layout command", () =>
  handoffFrom(
    { runtimeMode: "full-access", interactionMode: "default" },
    ({ handoff, writeLayout, layoutRan, setupScriptRuns }) =>
      Effect.gen(function* () {
        yield* writeLayout;
        yield* approveLayoutCommands;

        const result = yield* handoff;

        assert.isTrue(yield* layoutRan, JSON.stringify(result));
        assert.deepEqual(setupScriptRuns, [result.worktreePath]);
      }),
  ),
);

const fullAccess: Modes = { runtimeMode: "full-access", interactionMode: "default" };
const limitedToAuto: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { maxRuntimeMode: "auto" },
};

it.live(
  "t3_worktree_handoff from a Full access thread above the administrator's limit leaves an approved layout command unrun",
  () =>
    handoffFrom(
      fullAccess,
      ({ handoff, writeLayout, layoutRan }) =>
        Effect.gen(function* () {
          yield* writeLayout;
          yield* approveLayoutCommands;

          const result = yield* handoff;

          assert.include(
            result.message,
            "only have run from a thread in Full access. Example Corp limits threads to Auto. Start the worktree thread yourself.",
          );
          assert.isFalse(yield* layoutRan);
        }),
      limitedToAuto,
    ),
);

it.live(
  "t3_worktree_handoff from a Full access thread above the administrator's limit leaves the setup script unrun",
  () =>
    handoffFrom(
      fullAccess,
      ({ handoff, setupScriptRuns }) =>
        Effect.gen(function* () {
          const result = yield* handoff;

          assert.isString(result.worktreePath);
          assert.deepEqual(result.setupScript, { status: "skipped" });
          assert.deepEqual(setupScriptRuns, []);
        }),
      limitedToAuto,
    ),
);

it.live("t3_worktree_handoff neither runs nor approves a layout command nobody approved", () =>
  handoffFrom(
    { runtimeMode: "full-access", interactionMode: "default" },
    ({ handoff, writeLayout, layoutRan }) =>
      Effect.gen(function* () {
        yield* writeLayout;

        const result = yield* handoff;

        assert.include(result.message, "nobody has approved as it is written now");
        assert.isFalse(yield* layoutRan);
        const { commands } = yield* (yield* TaskFolders.TaskFolders).layoutCommands(projectId);
        assert.deepEqual(
          commands.map((command) => command.approved),
          [false],
        );
        // Asking again changes nothing: the request itself is never what approves.
        assert.include((yield* handoff).message, "nobody has approved as it is written now");
        assert.isFalse(yield* layoutRan);
      }),
  ),
);
