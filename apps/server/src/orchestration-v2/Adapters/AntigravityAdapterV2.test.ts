import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ServerConfig } from "../../config.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  crypto: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  idAllocator: undefined as never,
  serverConfig: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.succeed(undefined),
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);
  });

  it("maps runtime modes to the agent's native permission modes", () => {
    const mode = (runtimeMode: "approval-required" | "auto-accept-edits" | "full-access") =>
      flavor.sessionModeForPolicy?.(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode: "default",
          cwd: "/workspace",
        }),
      );
    assert.equal(mode("approval-required"), "default");
    assert.equal(mode("auto-accept-edits"), "auto_edit");
    assert.equal(mode("full-access"), "yolo");
  });

  it("exposes Antigravity's /compact command through the v2 compaction path", () => {
    assert.isTrue(flavor.supportsCompaction);
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("advertises only the approval decisions the request can honor", () => {
    const options = flavor.approvalOptions?.(
      permissionRequest("tool_1", [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ]),
    );
    assert.deepEqual(
      options?.map((option) => option.decision),
      ["accept", "decline", "cancel"],
    );
  });
});

const sessionLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-antigravity-v2-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("confines agent file requests to the workspace under full access", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const crypto = yield* Crypto.Crypto;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = makeAntigravityAdapterV2({
        instanceId,
        crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        fileSystem,
        path,
        idAllocator: yield* IdAllocatorV2,
        serverConfig,
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(serverConfig.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      if (readTextFile === undefined || writeTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* writeTextFile(
        { sessionId: "mock-session-1", path: insidePath, content: "inside" },
        context("fs/write_text_file"),
      );
      assert.equal(yield* fileSystem.readFileString(insidePath), "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const outsideWrite = yield* writeTextFile(
        { sessionId: "mock-session-1", path: path.join(outside, "planted.txt"), content: "x" },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideWrite));
      assert.isFalse(yield* fileSystem.exists(path.join(outside, "planted.txt")));

      // An in-workspace symlink to an outside file must not carry a read or
      // write out of the workspace.
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const linkedWrite = yield* writeTextFile(
        { sessionId: "mock-session-1", path: linkPath, content: "overwritten" },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedWrite), "a write through an escaping symlink is denied");
      assert.equal(yield* fileSystem.readFileString(outsideFile), "secret");
      // A dangling in-workspace symlink to an outside path must not create it.
      const plantedTarget = path.join(outside, "created-through-link.txt");
      const danglingLink = path.join(workspace, "dangling.txt");
      yield* fileSystem.symlink(plantedTarget, danglingLink);
      const danglingWrite = yield* writeTextFile(
        { sessionId: "mock-session-1", path: danglingLink, content: "planted" },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(danglingWrite), "a write through a dangling symlink is denied");
      assert.isFalse(yield* fileSystem.exists(plantedTarget));
      // A new file under an in-workspace directory link to outside is denied.
      yield* fileSystem.symlink(outside, path.join(workspace, "linked-dir"));
      const linkedDirWrite = yield* writeTextFile(
        {
          sessionId: "mock-session-1",
          path: path.join(workspace, "linked-dir", "new.txt"),
          content: "planted",
        },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedDirWrite), "a write under an escaping directory link");
      assert.isFalse(yield* fileSystem.exists(path.join(outside, "new.txt")));
      // A symlink that stays inside the workspace keeps working.
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = makeAntigravityAdapterV2({
        instanceId,
        crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        fileSystem,
        path,
        idAllocator: yield* IdAllocatorV2,
        serverConfig,
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      // The session opened for A now runs a turn for B.
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 client file system under restrictive policies", () => {
  // Antigravity asks before each of its own edits, so T3 serves an opted-in
  // write whatever the thread's policy says, confined to the workspace.
  it.effect("serves in-workspace reads and writes and still refuses outside paths", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const policies = [
        {
          name: "read-only sandbox",
          policy: {
            runtimeMode: "full-access",
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
        },
        { name: "approval-required", policy: { runtimeMode: "approval-required" } },
      ] as const;
      for (const { name, policy } of policies) {
        let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
        let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
        const instanceId = ProviderInstanceId.make(`antigravity-restrictive-${policy.runtimeMode}`);
        const adapter = makeAntigravityAdapterV2({
          instanceId,
          crypto,
          selfInvocation: yield* resolveSelfInvocation(),
          fileSystem,
          path,
          idAllocator: yield* IdAllocatorV2,
          serverConfig,
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleReadTextFile: (handler) =>
                  Effect.sync(() => {
                    readTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
                handleWriteTextFile: (handler) =>
                  Effect.sync(() => {
                    writeTextFile = handler;
                  }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.succeed(undefined),
        });
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-restrictive-",
        });
        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-restrictive-outside-",
        });
        yield* fileSystem.writeFileString(path.join(workspace, "existing.ts"), "existing");
        const threadId = ThreadId.make(`thread-antigravity-restrictive-${policy.runtimeMode}`);
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            `provider-session-antigravity-restrictive-${policy.runtimeMode}`,
          ),
          modelSelection,
          runtimePolicy,
        });
        yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
        if (readTextFile === undefined || writeTextFile === undefined) {
          return yield* Effect.die("Antigravity sessions must serve client file requests");
        }
        const context = (method: string) => ({ requestId: `test-${method}`, method });
        const read = yield* readTextFile(
          { sessionId: "mock-session-1", path: path.join(workspace, "existing.ts") },
          context("fs/read_text_file"),
        );
        assert.equal(read.content, "existing", name);
        const written = path.join(workspace, "src", "edited.ts");
        yield* writeTextFile(
          { sessionId: "mock-session-1", path: written, content: "edited" },
          context("fs/write_text_file"),
        );
        assert.equal(yield* fileSystem.readFileString(written), "edited", name);
        const outsideWrite = yield* writeTextFile(
          { sessionId: "mock-session-1", path: path.join(outside, "x.ts"), content: "x" },
          context("fs/write_text_file"),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(outsideWrite), name);
        assert.isFalse(yield* fileSystem.exists(path.join(outside, "x.ts")), name);
      }
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );
});
