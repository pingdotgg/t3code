import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AuthMcpClientAccess,
  CommandId,
  EnvironmentId,
  type OrchestrationV2ImportedHistory,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadReceiveInput,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as ThreadContinuation from "./ThreadContinuation.ts";

// The laptop sends a thread to the box. Each side runs the real orchestrator; the link, the
// peer's /mcp, Git and the project store are fakes at their boundaries.

const laptop = EnvironmentId.make("environment-laptop");
const box = EnvironmentId.make("environment-box");
const codex = ProviderInstanceId.make("codex");
const appProjectId = ProjectId.make("project-app");
const canonicalKey = "github.com/acme/app";
const remoteUrl = "https://github.com/acme/app.git";
const branch = "feat/login";

const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No run starts in these tests"),
};

const sourceHistory: OrchestrationV2ImportedHistory = {
  messages: [
    { role: "user", text: "Fix the login bug.", createdAt: "2026-11-27T09:00:00.000Z" },
    {
      role: "assistant",
      text: "The session cookie expires early.",
      createdAt: "2026-11-27T09:01:00.000Z",
    },
  ],
  omittedCount: 0,
  source: { environmentId: laptop, threadId: ThreadId.make("older-thread"), title: "Fix login" },
};

function projectWith(id: string, title: string, key: string | null): Project {
  return {
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity:
      key === null
        ? null
        : {
            canonicalKey: key,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl },
          },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function localStatus(hasWorkingTreeChanges: boolean): VcsStatusLocalResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: branch,
    hasWorkingTreeChanges,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };
}

function upstream(aheadCount: number) {
  return {
    refName: branch,
    aheadCount,
    behindCount: 0,
    details: {
      isRepo: true,
      hasPrimaryRemote: true,
      defaultBranch: "main",
      isDefaultBranch: false,
      branch,
      upstreamRef: `origin/${branch}`,
      hasUpstream: true,
      aheadCount,
      behindCount: 0,
      aheadOfDefaultCount: 1,
    },
  };
}

interface Scenario {
  readonly access: AuthMcpClientAccess;
  readonly hasWorkingTreeChanges: boolean;
  /** The projects here, as the project store lists them. */
  readonly projects: ReadonlyArray<Project>;
  /** What the peer's `t3_thread_receive` answers. */
  readonly peerReply: unknown;
  readonly peerCalls: Array<{ readonly tool: string; readonly arguments: unknown }>;
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly gitActions: Array<string>;
  readonly fetchedBases: Array<string>;
}

function scenario(
  overrides: Partial<Pick<Scenario, "access" | "hasWorkingTreeChanges" | "projects">> = {},
): Scenario {
  return {
    access: "full-access",
    hasWorkingTreeChanges: false,
    projects: [projectWith("project-app", "app", canonicalKey)],
    peerReply: { threadId: "box-thread", projectId: "box-project", title: "Fix login" },
    peerCalls: [],
    launches: [],
    gitActions: [],
    fetchedBases: [],
    ...overrides,
  };
}

const layerFakes = (world: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mergeAll(
        Layer.mock(PeerLinks.PeerLinks)({
          get: (environmentId) =>
            Effect.succeedSome({
              environmentId,
              label: "Box",
              urls: ["http://box.local"],
              access: world.access,
              linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
              expiresAt: DateTime.makeUnsafe("2027-11-01T00:00:00.000Z"),
              lastReachedAt: null,
              lastError: null,
            }),
        }),
        Layer.mock(PeerMcpClient.PeerMcpClient)({
          call: (input) => {
            world.peerCalls.push({ tool: input.tool, arguments: input.arguments });
            const success = input.success;
            return Schema.decodeUnknownEffect(success)(world.peerReply).pipe(Effect.orDie);
          },
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: orchestrator.dispatch,
          getThreadRecords: orchestrator.getThreadRecords,
          getThreadProjection: orchestrator.getThreadProjection,
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          checkWorktreeBase: () => Effect.void,
          launch: (input) =>
            Effect.gen(function* () {
              world.launches.push(input);
              const threadId = ThreadId.make("received-thread");
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: null,
                worktreePath: null,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
                ...(input.importedHistory === undefined
                  ? {}
                  : { importedHistory: input.importedHistory }),
              });
              const projection = yield* orchestrator.getThreadProjection(threadId);
              return { threadId, projection, resumed: false };
            }).pipe(Effect.orDie),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.fromNullishOr(world.projects.find((project) => project.id === id)),
            ),
          listPage: ({ cursor, limit }) =>
            Effect.succeed({
              projects: world.projects.slice(cursor, cursor + limit),
              nextCursor: cursor + limit < world.projects.length ? cursor + limit : null,
            }),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey,
              locator: { source: "git-remote", remoteName: "origin", remoteUrl },
            }),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          localStatus: () => Effect.succeed(localStatus(world.hasWorkingTreeChanges)),
          upstreamDivergence: () => Effect.succeed(upstream(0)),
          runStackedAction: (input) => {
            world.gitActions.push(input.action);
            return Effect.die("Pushing is not part of these tests");
          },
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          fetchWorktreeBaseCommit: (input) => {
            world.fetchedBases.push(input.refName);
            return Effect.succeed({ commitSha: "abc123", remoteRefName: input.refName });
          },
          readConfigValue: (_cwd, key) =>
            Effect.succeed(
              key === `branch.${branch}.remote`
                ? "origin"
                : key === "remote.origin.url"
                  ? remoteUrl
                  : null,
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ServerSettings.layerTest({
          defaultModelSelection: { instanceId: codex, model: "test-model" },
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(laptop),
        }),
      );
    }),
  );

const layerFor = (world: Scenario) =>
  ThreadContinuation.layer.pipe(
    Layer.provide(layerFakes(world)),
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-continuation" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** The thread on the laptop that is sent, with the transcript it already holds. */
const createSourceThread = Effect.fn("test.createSourceThread")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("laptop-thread");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("laptop-thread:create"),
    threadId,
    projectId: appProjectId,
    title: "Fix login",
    modelSelection: { instanceId: codex, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    importedHistory: sourceHistory,
  });
  return threadId;
});

const sendFrom = (threadId: ThreadId, commitAndPush = false) =>
  ThreadContinuation.ThreadContinuation.pipe(
    Effect.flatMap((continuation) =>
      continuation.send({ threadId, targetEnvironmentId: box, commitAndPush }),
    ),
  );

const isContinuationError = Schema.is(ThreadContinuation.ThreadContinuationError);

const failureReason = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isContinuationError(error) ? error.reason : error._tag)),
  );

const receiveInput: ThreadReceiveInput = {
  repository: { remoteUrl, canonicalKey },
  remoteName: "origin",
  branch,
  title: "Fix login",
  // An instance the box does not have, so the box's default model is used.
  modelSelection: { instanceId: ProviderInstanceId.make("claude-work"), model: "sonnet" },
  importedHistory: sourceHistory,
};

/** The part of the peer call this test reads back. */
const ThreadContinuationArguments = Schema.Struct({
  importedHistory: Schema.Struct({
    messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
    source: Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.String,
      title: Schema.String,
    }),
  }),
});
const decodeSentArguments = Schema.decodeUnknownEffect(ThreadContinuationArguments);

const receive = (input: ThreadReceiveInput) =>
  ThreadContinuation.ThreadContinuation.pipe(
    Effect.flatMap((continuation) => continuation.receive(input)),
  );

const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 0, 0, second));

it("keeps the first user message and the newest messages up to the message cap", () => {
  const messages = [
    { role: "user" as const, text: "first", createdAt: at(0) },
    { role: "system" as const, text: "not transferred", createdAt: at(0) },
    { role: "assistant" as const, text: "  ", createdAt: at(0) },
    ...Array.from({ length: 200 }, (_, index) => ({
      role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
      text: `m${index + 1}`,
      createdAt: at(index + 1),
    })),
  ];

  const selected = ThreadContinuation.selectTranscriptForTransfer(messages);

  assert.strictEqual(selected.omittedCount, 1);
  assert.strictEqual(selected.messages.length, 200);
  assert.deepEqual(selected.messages[0], {
    role: "user",
    text: "first",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  assert.deepEqual(
    selected.messages.slice(1, 3).map((message) => message.text),
    ["m2", "m3"],
  );
  assert.strictEqual(selected.messages.at(-1)?.text, "m200");
});

it("drops the oldest messages after the first user message until the text fits the byte cap", () => {
  const messages = [
    { role: "user" as const, text: "start", createdAt: at(0) },
    { role: "assistant" as const, text: "a".repeat(900_000), createdAt: at(1) },
    { role: "assistant" as const, text: "b".repeat(900_000), createdAt: at(2) },
    { role: "assistant" as const, text: "c".repeat(900_000), createdAt: at(3) },
  ];

  const selected = ThreadContinuation.selectTranscriptForTransfer(messages);

  assert.strictEqual(selected.omittedCount, 1);
  assert.deepEqual(
    selected.messages.map((message) => `${message.role}:${message.text[0]}:${message.text.length}`),
    ["user:s:5", "assistant:b:900000", "assistant:c:900000"],
  );
});

it.effect("send refuses unpushed work without the box ticked, before any call to the peer", () => {
  const world = scenario({ hasWorkingTreeChanges: true });
  return Effect.gen(function* () {
    const threadId = yield* createSourceThread();

    assert.strictEqual(yield* failureReason(sendFrom(threadId)), "unpushed_work");
    assert.deepEqual(world.peerCalls, []);
    assert.deepEqual(world.gitActions, []);
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("send refuses a link below Full access", () => {
  const world = scenario({ access: "auto" });
  return Effect.gen(function* () {
    const threadId = yield* createSourceThread();

    assert.strictEqual(yield* failureReason(sendFrom(threadId)), "link_not_full_access");
    assert.deepEqual(world.peerCalls, []);
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect(
  "send hands the branch and transcript to the box and marks the thread as moved there",
  () => {
    const world = scenario();
    return Effect.gen(function* () {
      const threadId = yield* createSourceThread();

      const result = yield* sendFrom(threadId);

      assert.deepEqual(result, {
        targetEnvironmentId: box,
        targetThreadId: ThreadId.make("box-thread"),
        title: "Fix login",
      });
      const [call] = world.peerCalls;
      assert.strictEqual(call?.tool, "t3_thread_receive");
      assert.deepInclude(call?.arguments, {
        repository: { remoteUrl, canonicalKey },
        remoteName: "origin",
        branch,
        title: "Fix login",
      });
      const sent = yield* decodeSentArguments(call?.arguments);
      assert.deepEqual(sent.importedHistory.source, {
        environmentId: laptop,
        threadId,
        title: "Fix login",
      });
      assert.deepEqual(
        sent.importedHistory.messages.map((message) => [message.role, message.text]),
        [
          ["user", "Fix the login bug."],
          ["assistant", "The session cookie expires early."],
        ],
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(projection.thread.movedTo, {
        environmentId: box,
        threadId: ThreadId.make("box-thread"),
        title: "Fix login",
        label: "Box",
        movedAt: DateTime.makeUnsafe(0),
      });
    }).pipe(Effect.provide(layerFor(world)));
  },
);

it.effect("receive refuses a repository two projects here share, and creates nothing", () => {
  const world = scenario({
    projects: [
      projectWith("project-app", "app", canonicalKey),
      projectWith("project-app-copy", "app copy", canonicalKey),
    ],
  });
  return Effect.gen(function* () {
    assert.strictEqual(yield* failureReason(receive(receiveInput)), "project_ambiguous");
    assert.deepEqual(world.launches, []);
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect(
  "receive starts the thread on the sender's branch in the one project with the repository",
  () => {
    const world = scenario({
      projects: [
        projectWith("project-other", "other", "github.com/acme/other"),
        projectWith("project-app", "app", canonicalKey),
      ],
    });
    return Effect.gen(function* () {
      const result = yield* receive(receiveInput);

      assert.deepEqual(result, {
        threadId: ThreadId.make("received-thread"),
        projectId: appProjectId,
        title: "Fix login",
      });
      const [launch] = world.launches;
      assert.strictEqual(launch?.projectId, appProjectId);
      assert.deepEqual(launch?.workspaceStrategy, {
        type: "worktree",
        baseRef: "origin/feat/login",
        branch,
        startFromOrigin: false,
      });
      assert.deepEqual(world.fetchedBases, ["origin/feat/login"]);
      assert.deepEqual(launch?.modelSelection, { instanceId: codex, model: "test-model" });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const received = yield* orchestrator.getThreadProjection(result.threadId);
      assert.deepEqual(
        received.messages.map((message) => [message.role, message.text]),
        [
          ["user", "Fix the login bug."],
          ["assistant", "The session cookie expires early."],
        ],
      );
    }).pipe(Effect.provide(layerFor(world)));
  },
);
