import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProjectedTurnItem,
  type ThreadMoveGit,
  type ThreadMoveMessage,
  type ThreadMoveSnapshot,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const { fallbackMoveModel, historyFromTurnItems, planMoveWorkspace, selectMoveHistory } =
  ThreadMoveService;

const message = (role: "user" | "assistant", text: string): ThreadMoveMessage => ({
  role,
  text,
  createdAt: "2026-11-23T00:00:00.000Z",
});

describe("historyFromTurnItems", () => {
  const userMessage = (
    id: string,
    createdBy: OrchestrationV2Actor,
    creationSource: OrchestrationV2CreationSource,
  ) => {
    const threadId = ThreadId.make("thread:move");
    const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 23));
    return {
      position: 0,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: TurnItemId.make(id),
      item: {
        id: TurnItemId.make(id),
        threadId,
        runId: RunId.make("run:move"),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "user_message",
        messageId: MessageId.make(id),
        text: id,
        inputIntent: "turn_start",
        attachments: [],
        createdBy,
        creationSource,
      },
    } satisfies OrchestrationV2ProjectedTurnItem;
  };

  it("keeps who sent a user message that the user did not, and how", () => {
    expect(
      historyFromTurnItems([
        userMessage("mine", "user", "web"),
        userMessage("delegated", "agent", "mcp"),
      ]).map(({ text, createdBy, creationSource }) => ({ text, createdBy, creationSource })),
    ).toEqual([
      { text: "mine", createdBy: undefined, creationSource: undefined },
      { text: "delegated", createdBy: "agent", creationSource: "mcp" },
    ]);
  });
});

describe("selectMoveHistory", () => {
  it("keeps everything that fits", () => {
    const messages = [message("user", "a"), message("assistant", "b")];
    expect(selectMoveHistory(messages, 10)).toEqual({ messages, omittedMessageCount: 0 });
  });

  it("keeps the first request and the newest history, in order", () => {
    const messages = [
      message("assistant", "intro"),
      message("user", "first"),
      message("assistant", "old answer"),
      message("user", "middle"),
      message("assistant", "new"),
    ];
    // "first" (5) + "new" (3) + "middle" (6) = 14; "old answer" no longer fits.
    expect(selectMoveHistory(messages, 14)).toEqual({
      messages: [message("user", "first"), message("user", "middle"), message("assistant", "new")],
      omittedMessageCount: 2,
    });
  });

  it("stops at the first newer message that does not fit, leaving no gaps", () => {
    const messages = [
      message("user", "q"),
      message("assistant", "short"),
      message("assistant", "this one is far too long"),
      message("user", "end"),
    ];
    expect(selectMoveHistory(messages, 4).messages).toEqual([
      message("user", "q"),
      message("user", "end"),
    ]);
  });

  it("counts bytes, not characters", () => {
    const messages = [message("user", "é".repeat(3))];
    expect(selectMoveHistory(messages, 5).omittedMessageCount).toBe(1);
  });
});

describe("planMoveWorkspace", () => {
  const pushed: ThreadMoveGit = {
    branch: "feature/move",
    remoteBranch: "feature/move",
    headCommit: "abc",
    unpushedCommitCount: 0,
    uncommittedFileCount: 0,
  };
  const workspaceRoot = "/home/user/app";

  it("uses the target's default workspace without a pushed branch", () => {
    expect(
      planMoveWorkspace({ git: null, workspaceRoot, targetBranch: { type: "absent" } }),
    ).toEqual({
      type: "default",
      reason: "no-git",
    });
    expect(
      planMoveWorkspace({
        git: { ...pushed, remoteBranch: null },
        workspaceRoot,
        targetBranch: { type: "absent" },
      }),
    ).toEqual({ type: "default", reason: "not-pushed" });
  });

  it("starts a new worktree from the remote branch the source tracks", () => {
    expect(
      planMoveWorkspace({
        git: { ...pushed, remoteBranch: "main" },
        workspaceRoot,
        targetBranch: { type: "absent" },
      }),
    ).toMatchObject({
      type: "carry",
      strategy: {
        type: "worktree",
        baseRef: "main",
        branch: "feature/move",
        startFromOrigin: true,
      },
      reusedCheckout: false,
    });
  });

  it("reuses a checkout the target already has of the branch", () => {
    expect(
      planMoveWorkspace({
        git: pushed,
        workspaceRoot,
        targetBranch: { type: "checked-out", worktreePath: "/home/user/worktrees/move" },
      }),
    ).toMatchObject({
      strategy: { type: "existing_worktree", worktreePath: "/home/user/worktrees/move" },
      reusedCheckout: true,
      addWorktree: false,
    });
    expect(
      planMoveWorkspace({
        git: pushed,
        workspaceRoot,
        targetBranch: { type: "checked-out", worktreePath: `${workspaceRoot}/` },
      }),
    ).toMatchObject({ strategy: { type: "root", branch: "feature/move" }, reusedCheckout: true });
  });

  it("adds a worktree for a local branch nothing has checked out", () => {
    expect(
      planMoveWorkspace({ git: pushed, workspaceRoot, targetBranch: { type: "unchecked" } }),
    ).toMatchObject({ type: "carry", addWorktree: true, reusedCheckout: true });
  });
});

describe("fallbackMoveModel", () => {
  const provider = (
    instanceId: string,
    models: ReadonlyArray<string>,
    state: { enabled?: boolean; status?: "ready" | "error" } = {},
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    enabled: state.enabled ?? true,
    installed: true,
    status: state.status ?? ("ready" as const),
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  });
  const wanted = { instanceId: ProviderInstanceId.make("claude-home"), model: "claude-opus-5-5" };

  it("keeps the model under another instance that offers it", () => {
    expect(
      fallbackMoveModel(wanted, [
        provider("codex", ["gpt-6.2-sol"]),
        provider("claude-work", ["claude-sonnet-5-5", "claude-opus-5-5"]),
      ]),
    ).toEqual({ instanceId: "claude-work", model: "claude-opus-5-5" });
  });

  it("falls back to the first usable provider, and to nothing without one", () => {
    expect(
      fallbackMoveModel(wanted, [
        provider("broken", ["claude-opus-5-5"], { status: "error" }),
        provider("off", ["claude-opus-5-5"], { enabled: false }),
        provider("codex", ["gpt-6.2-sol"]),
      ]),
    ).toEqual({ instanceId: "codex", model: "gpt-6.2-sol" });
    expect(fallbackMoveModel(wanted, [provider("off", ["x"], { enabled: false })])).toBeNull();
  });
});

describe("a move between environments", () => {
  const projectId = ProjectId.make("project:move");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.2-sol" };
  const project = {
    id: projectId,
    title: "Acme",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: modelSelection,
    defaultThreadEnvMode: null,
    scripts: [],
    trackedFolders: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-23T00:00:00.000Z",
    updatedAt: "2026-11-23T00:00:00.000Z",
    deletedAt: null,
  } as const;
  const adapter = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("a move starts no provider session"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];

  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-move" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerSettings = ServerSettings.layerTest();
  const layerThreads = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  // Launching is ThreadLaunchService's to test; here it only creates the thread.
  const layerLauncher = Layer.unwrap(
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(`thread:${input.commandId}`);
            yield* threads.dispatch({
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
            });
            const { projection } = yield* threads.getThreadSnapshot(threadId);
            return { threadId, projection, resumed: false };
          }).pipe(Effect.orDie),
      });
    }),
  ).pipe(Layer.provide(layerThreads));
  const layer = ThreadMoveService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerThreads,
        layerLauncher,
        layerOrchestrator,
        layerSettings,
        IdAllocator.layer,
        ProviderRegistryMock.layer(),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({ load: () => Effect.succeedNone }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("environment:vps"),
            label: "VPS",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetails: (cwd) =>
            Effect.fail(
              new GitCommandError({
                operation: "statusDetails",
                command: "git",
                cwd,
                detail: "not a git repository",
                exitCode: 128,
              }),
            ),
        }),
      ),
    ),
  );

  const snapshot: ThreadMoveSnapshot = {
    sourceThreadId: ThreadId.make("thread:on-laptop"),
    sourceEnvironmentLabel: "Laptop",
    title: "Fix the flaky test",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    messages: [
      { role: "user", text: "Fix the flaky test", createdAt: "2026-11-23T00:01:00.000Z" },
      { role: "assistant", text: "It races the clock.", createdAt: "2026-11-23T00:02:00.000Z" },
      {
        role: "user",
        text: "Background task finished.",
        createdAt: "2026-11-23T00:03:00.000Z",
        createdBy: "agent",
        creationSource: "mcp",
      },
    ],
    omittedMessageCount: 0,
    pullRequests: [],
    git: null,
  };

  it.effect(
    "lands the history as an imported conversation, exports it back, and archives on completion",
    () =>
      Effect.gen(function* () {
        const moves = yield* ThreadMoveService.ThreadMoveService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { threadId, carriedBranch } = yield* moves.importThread(
          { commandId: CommandId.make("move-in"), projectId, snapshot },
          { createdBy: "user", creationSource: "web" },
        );
        expect(carriedBranch).toBeNull();

        const { projection } = yield* threads.getThreadSnapshot(threadId);
        // Run-less imported history: the first turn hands it to the provider as a handoff.
        expect(projection.thread.historyOrigin).toBe("v1_import");
        expect(projection.runs).toEqual([]);
        expect(
          projection.visibleTurnItems.map(({ item }) =>
            item.type === "system_notice"
              ? { type: item.type, text: item.message.split(".")[0] }
              : item.type === "user_message"
                ? {
                    type: item.type,
                    text: item.text,
                    createdBy: item.createdBy,
                    creationSource: item.creationSource,
                  }
                : { type: item.type, text: item.type === "assistant_message" ? item.text : "" },
          ),
        ).toEqual([
          {
            type: "user_message",
            text: "Fix the flaky test",
            createdBy: "user",
            creationSource: "server",
          },
          { type: "assistant_message", text: "It races the clock." },
          {
            type: "user_message",
            text: "Background task finished.",
            createdBy: "agent",
            creationSource: "mcp",
          },
          { type: "system_notice", text: "Moved from Laptop" },
        ]);

        const exported = yield* moves.exportThread(threadId);
        expect(exported.sourceEnvironmentLabel).toBe("VPS");
        expect(exported.git).toBeNull();
        expect(exported.messages).toEqual(snapshot.messages);

        yield* moves.completeMove({ threadId, targetEnvironmentLabel: "Laptop" });
        yield* moves.completeMove({ threadId, targetEnvironmentLabel: "Laptop" });
        const shell = yield* threads.getThreadShell(threadId);
        expect(shell?.archivedAt).not.toBeNull();
        const notices = (yield* threads.getThreadSnapshot(threadId)).projection.visibleTurnItems
          .map(({ item }) => item)
          .filter((item) => item.type === "system_notice")
          .map((item) => item.message.split(".")[0]);
        expect(notices).toEqual(["Moved from Laptop", "Moved to Laptop"]);
      }).pipe(Effect.provide(layer)),
  );
});
