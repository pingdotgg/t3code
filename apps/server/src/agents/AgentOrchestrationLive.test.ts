import {
  AgentProfileDocument,
  AgentRunId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";

import * as ProcessRunner from "../processRunner.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  agentWorktreeBranchName,
  applyIsolatedWorktreePatch,
  cleanupCreatedAgentWorktree,
  dispatchAgentChildLifecycle,
  liveAgentProfileLocator,
  minimumBudgets,
  requireAgentResultThread,
  requestAgentFollowUp,
  resolvePinnedAgentRuntimeSettings,
  runtimeSettingsForAgentProfile,
} from "./AgentOrchestrationLive.ts";

const decodeAgentProfile = Schema.decodeUnknownSync(AgentProfileDocument);
const restrictiveProfile = decodeAgentProfile({
  id: "reviewer",
  scope: "environment",
  revision: "a".repeat(64),
  name: "Reviewer",
  defaultModelSelection: null,
  chatSelectable: true,
  sourcePath: null,
  requirements: { toolRequirement: "none", t3McpCapabilities: [] },
  archivedAt: null,
  updatedAt: "2026-08-07T12:00:00.000Z",
  instructions: "Review carefully.",
  instructionPriority: "prompt",
  runtime: { mode: "full-access", interactionMode: "plan" },
  workspace: { mode: "shared", access: "read-only" },
  tools: { policy: "inherit", allowed: [] },
  delegation: { policy: "disabled", profiles: [] },
  budgets: { maxRuns: 1, maxConcurrency: 1, maxDepth: 0, maxWallTimeMinutes: 1 },
  hooks: [],
  rules: [],
  createdAt: "2026-08-07T12:00:00.000Z",
});

it.effect("loads the pinned profile before deriving follow-up turn policy", () =>
  Effect.gen(function* () {
    let loadedRevision: string | undefined;
    const settings = yield* resolvePinnedAgentRuntimeSettings({
      repository: {
        getProfileSnapshot: (revision) =>
          Effect.sync(() => {
            loadedRevision = revision;
            return Option.some(restrictiveProfile);
          }),
      },
      run: {
        id: AgentRunId.make("follow-up-run"),
        profile: {
          id: restrictiveProfile.id,
          scope: restrictiveProfile.scope,
          revision: restrictiveProfile.revision,
        },
      },
    });

    NodeAssert.equal(loadedRevision, restrictiveProfile.revision);
    NodeAssert.deepEqual(settings, {
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
  }),
);

it.effect("does not queue a follow-up when a turn id cannot be allocated", () =>
  Effect.gen(function* () {
    const dispatched: Array<string> = [];
    const result = yield* Effect.result(
      requestAgentFollowUp({
        crypto: {
          randomUUIDv4: Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "test",
              method: "randomUUIDv4",
            }),
          ),
        },
        repository: {
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return [];
            }),
        },
        runId: AgentRunId.make("follow-up-run"),
        message: "Address the review.",
        occurredAt: "2026-08-07T12:00:00.000Z",
      }),
    );
    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.deepEqual(dispatched, []);
  }),
);

it.effect("returns the durable follow-up revision before the provider turn starts", () =>
  Effect.gen(function* () {
    const result = yield* requestAgentFollowUp({
      crypto: { randomUUIDv4: Effect.succeed("follow-up-uuid") },
      repository: {
        dispatch: () =>
          Effect.succeed([
            {
              type: "agent-run.follow-up-revised" as const,
              runId: AgentRunId.make("follow-up-run"),
              revision: 3,
              occurredAt: "2026-08-07T12:00:00.000Z",
              message: "Address the review.",
            },
          ]),
      },
      runId: AgentRunId.make("follow-up-run"),
      message: "Address the review.",
      occurredAt: "2026-08-07T12:00:00.000Z",
    });

    NodeAssert.equal(result.revision, 3);
  }),
);

it("derives restrictive runtime policy from a pinned profile", () => {
  NodeAssert.deepEqual(runtimeSettingsForAgentProfile(restrictiveProfile), {
    runtimeMode: "approval-required",
    interactionMode: "plan",
  });
});

it("uses an unpinned locator for live delegation configuration", () => {
  NodeAssert.deepEqual(liveAgentProfileLocator(restrictiveProfile), {
    id: restrictiveProfile.id,
    scope: restrictiveProfile.scope,
  });
});

it.effect("fails closed when a run's child thread projection is missing", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      requireAgentResultThread(Option.none(), AgentRunId.make("missing-child-thread-run")),
    );
    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.match(
      result._tag === "Failure" ? result.failure.detail : "",
      /child Agent thread is unavailable/i,
    );
  }),
);

it("allocates a dedicated branch for each isolated Agent run", () => {
  NodeAssert.equal(
    agentWorktreeBranchName(AgentRunId.make("f4f7030b-4c6f-46dd-8872-3446d653746a")),
    "t3code/agent-f4f7030b-4c6f-46dd-8872-3446d653746a",
  );
});

it("inherits a nested run's effective budget instead of expanding to profile defaults", () => {
  const childProfileBudget = {
    maxRuns: 8,
    maxConcurrency: 4,
    maxDepth: 4,
    maxWallTimeMinutes: 30,
    maxTotalTokens: 100_000,
    maxEstimatedCostUsd: 10,
  };
  const effectiveParentBudget = {
    maxRuns: 2,
    maxConcurrency: 1,
    maxDepth: 1,
    maxWallTimeMinutes: 5,
    maxTotalTokens: 5_000,
    maxEstimatedCostUsd: 1,
  };

  NodeAssert.deepEqual(minimumBudgets(childProfileBudget, effectiveParentBudget), {
    ...effectiveParentBudget,
  });
});

const IntegrationTestLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const childThreadId = ThreadId.make("child-thread");
const modelSelection = {
  instanceId: ProviderInstanceId.make("grok"),
  model: "gpt-5.6-terra",
};
const createThread = {
  type: "thread.create",
  commandId: CommandId.make("create-child-thread"),
  threadId: childThreadId,
  projectId: ProjectId.make("fixture-project"),
  title: "Terra Reviewer: inspect README",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: "main",
  worktreePath: "/fixture",
  createdAt: "2026-08-07T12:00:00.000Z",
} as const;
const startTurn = {
  type: "thread.turn.start",
  commandId: CommandId.make("start-child-turn"),
  threadId: childThreadId,
  message: {
    messageId: MessageId.make("child-message"),
    role: "user",
    text: "Inspect README.md",
    attachments: [],
  },
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: "2026-08-07T12:00:00.000Z",
} as const;

it.effect("creates and prepares a child thread before starting its first turn", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          order.push(command.type);
          return { sequence: order.length };
        }),
    };

    const result = yield* dispatchAgentChildLifecycle({
      engine,
      createThread,
      prepareThread: Effect.sync(() => order.push("prepare")),
      markRunStarted: Effect.sync(() => order.push("run.start")),
      startTurn,
    });

    NodeAssert.deepEqual(order, ["thread.create", "prepare", "run.start", "thread.turn.start"]);
    NodeAssert.equal(result.sequence, 4);
  }),
);

it.effect("preserves the orchestration invariant when the child turn cannot start", () =>
  Effect.gen(function* () {
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        command.type === "thread.turn.start"
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `Thread '${command.threadId}' does not exist.`,
              }),
            )
          : Effect.succeed({ sequence: 1 }),
    };

    const result = yield* Effect.result(
      dispatchAgentChildLifecycle({
        engine,
        createThread,
        prepareThread: Effect.void,
        markRunStarted: Effect.void,
        startTurn,
      }),
    );

    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.match(
      result._tag === "Failure" ? result.failure.detail : "",
      /could not start.*Thread 'child-thread' does not exist/i,
    );
  }),
);

it.effect("cleans only the isolated worktree and branch that a failed spawn created", () =>
  Effect.gen(function* () {
    const removed: Array<{
      readonly cwd: string;
      readonly path: string;
      readonly force?: boolean | undefined;
    }> = [];
    const commands: Array<ProcessRunner.ProcessRunInput> = [];
    yield* cleanupCreatedAgentWorktree({
      gitWorkflow: {
        removeWorktree: (input) =>
          Effect.sync(() => {
            removed.push(input);
          }),
      },
      processRunner: {
        run: (input) =>
          Effect.sync(() => {
            commands.push(input);
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      },
      workspaceRoot: "/repository",
      worktreePath: "/repository/.t3/worktrees/agent-run",
      branch: "t3code/agent-run",
    });

    NodeAssert.deepEqual(removed, [
      { cwd: "/repository", path: "/repository/.t3/worktrees/agent-run", force: true },
    ]);
    NodeAssert.deepEqual(
      commands.map((command) => command.args),
      [["branch", "--delete", "--force", "t3code/agent-run"]],
    );
  }),
);

const makeWorktrees = Effect.fn("AgentOrchestrationLive.test.makeWorktrees")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const tempRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-integration-" });
  const root = path.join(tempRoot, "repository");
  const child = path.join(tempRoot, "child");
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    processRunner
      .run({ command: "git", args, cwd, timeout: "30 seconds" })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.die(new Error(result.stderr || `git ${args.join(" ")} failed`)),
        ),
      );

  yield* git(tempRoot, ["init", root]);
  yield* git(root, ["config", "user.email", "agent-test@t3.local"]);
  yield* git(root, ["config", "user.name", "T3 Agent Test"]);
  yield* fileSystem.writeFileString(path.join(root, "tracked.txt"), "base\n");
  yield* git(root, ["add", "tracked.txt"]);
  yield* git(root, ["commit", "-m", "base"]);
  yield* git(root, ["worktree", "add", "-b", "agent-result", child, "HEAD"]);
  return { root, child };
});

it.effect("integrates a tracked isolated-worktree patch into a clean target", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { root, child } = yield* makeWorktrees();
    yield* fileSystem.writeFileString(path.join(child, "tracked.txt"), "child result\n");
    yield* applyIsolatedWorktreePatch({
      sourceWorktreePath: child,
      targetWorktreePath: root,
    });
    NodeAssert.equal(
      (yield* fileSystem.readFileString(path.join(root, "tracked.txt"))).trim(),
      "child result",
    );
  }).pipe(Effect.provide(IntegrationTestLayer)),
);

it.effect("integrates committed child changes from the original branch point", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const { root, child } = yield* makeWorktrees();
    yield* fileSystem.writeFileString(path.join(child, "tracked.txt"), "committed child\n");
    const commit = yield* processRunner.run({
      command: "git",
      args: ["commit", "-am", "child result"],
      cwd: child,
      timeout: "30 seconds",
    });
    NodeAssert.equal(commit.code, 0);

    yield* applyIsolatedWorktreePatch({
      sourceWorktreePath: child,
      targetWorktreePath: root,
    });

    NodeAssert.equal(
      (yield* fileSystem.readFileString(path.join(root, "tracked.txt"))).trim(),
      "committed child",
    );
  }).pipe(Effect.provide(IntegrationTestLayer)),
);

it.effect("treats an already-applied isolated-worktree patch as a successful retry", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { root, child } = yield* makeWorktrees();
    yield* fileSystem.writeFileString(path.join(child, "tracked.txt"), "retry-safe child result\n");

    yield* applyIsolatedWorktreePatch({
      sourceWorktreePath: child,
      targetWorktreePath: root,
    });
    const ordinaryAttempt = yield* Effect.result(
      applyIsolatedWorktreePatch({
        sourceWorktreePath: child,
        targetWorktreePath: root,
      }),
    );
    NodeAssert.equal(ordinaryAttempt._tag, "Failure");
    NodeAssert.match(
      ordinaryAttempt._tag === "Failure" ? ordinaryAttempt.failure.detail : "",
      /target has uncommitted changes/i,
    );
    yield* applyIsolatedWorktreePatch({
      sourceWorktreePath: child,
      targetWorktreePath: root,
      allowAlreadyApplied: true,
    });

    NodeAssert.equal(
      (yield* fileSystem.readFileString(path.join(root, "tracked.txt"))).trim(),
      "retry-safe child result",
    );
  }).pipe(Effect.provide(IntegrationTestLayer)),
);

it.effect("refuses untracked isolated-worktree files without touching the target", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { root, child } = yield* makeWorktrees();
    yield* fileSystem.writeFileString(path.join(child, "untracked.txt"), "must not transfer\n");
    const result = yield* Effect.result(
      applyIsolatedWorktreePatch({
        sourceWorktreePath: child,
        targetWorktreePath: root,
      }),
    );
    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.match(result._tag === "Failure" ? result.failure.detail : "", /untracked files/i);
    NodeAssert.equal(yield* fileSystem.readFileString(path.join(root, "tracked.txt")), "base\n");
  }).pipe(Effect.provide(IntegrationTestLayer)),
);

const GitFailureLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout: "sensitive stdout from the repository",
          stderr: "sensitive stderr from the repository",
          code: ChildProcessSpawner.ExitCode(1),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    }),
  ),
);

it.effect("does not expose Git command output in isolated-worktree failure details", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const result = yield* Effect.result(
      applyIsolatedWorktreePatch({
        sourceWorktreePath: path.join(process.cwd(), "apps"),
        targetWorktreePath: process.cwd(),
      }),
    );
    NodeAssert.equal(result._tag, "Failure");
    const detail = result._tag === "Failure" ? result.failure.detail : "";
    NodeAssert.match(detail, /Git worktree validation failed \(exit code 1\)/);
    NodeAssert.doesNotMatch(detail, /sensitive (stdout|stderr)/i);
  }).pipe(Effect.provide(GitFailureLayer)),
);
