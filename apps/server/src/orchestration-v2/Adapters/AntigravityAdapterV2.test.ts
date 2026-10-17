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
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  crypto: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
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
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("confines agent file requests to the workspace under full access", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const crypto = yield* Crypto.Crypto;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
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
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
      const plantedTarget = path.join(outside, "created-through-link.txt");
      const danglingLink = path.join(workspace, "dangling.txt");
      yield* fileSystem.symlink(plantedTarget, danglingLink);
      const danglingWrite = yield* writeTextFile(
        { sessionId: "mock-session-1", path: danglingLink, content: "planted" },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(danglingWrite), "a write through a dangling symlink is denied");
      assert.isFalse(yield* fileSystem.exists(plantedTarget));
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
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
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
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 client file system under restrictive policies", () => {
  it.effect("serves in-workspace reads and writes and still refuses outside paths", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
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
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
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
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      const page = (name: string, title = "Revenue") => ({
        attachmentId: `${threadId}-${name}-html`,
        title,
        height: 240,
      });
      const revenue = { html: "<p>Revenue</p>", title: "Revenue", height: 240 };
      const restated = { ...revenue, html: "<p>Revenue, restated</p>" };
      const margin = { ...revenue, html: "<p>Margin</p>", title: "Margin" };
      const byRegion = { ...revenue, html: "<p>Revenue by region</p>" };
      const byMonth = { ...revenue, html: "<p>Revenue by month</p>" };
      // About the size of the page in the session that showed the bug.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { ...revenue, html: `<table>${rows.join("")}</table>` };
      const renderError = {
        content: [{ type: "text", text: "html_render failed" }],
        isError: true,
      };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
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
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: () =>
                Effect.gen(function* () {
                  // Antigravity's runtime bounds each update before the
                  // adapter sees it, html_render's html included.
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  // agy_acp_server 1.3.0 and 1.4.0 without a permission prompt:
                  // the title is "Running <tool>", rawInput holds only the
                  // tool's arguments, and the completion reports the step's
                  // own summary as rawOutput instead of the MCP result.
                  const start = (
                    toolCallId: string,
                    rawInput: {
                      readonly html?: string;
                      readonly title: string;
                      readonly height: number;
                    },
                  ) =>
                    send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  yield* start("trajectory:1", revenue);
                  yield* start("trajectory:2", { ...revenue, title: "Costs" });
                  yield* start("trajectory:3", restated);
                  yield* start("trajectory:4", revenue);
                  yield* start("trajectory:5", revenue);
                  yield* start("trajectory:6", margin);
                  yield* start("trajectory:7", margin);
                  yield* start("trajectory:8", byRegion);
                  yield* start("trajectory:9", byMonth);
                  yield* start("trajectory:10", report);
                  yield* start("trajectory:11", { title: "Revenue", height: 240 });
                  // T3's MCP server publishes while each call runs.
                  yield* mcpSessions.recordHtmlRender(threadId, revenue, page("first"));
                  yield* mcpSessions.recordHtmlRender(threadId, restated, page("second"));
                  yield* mcpSessions.recordHtmlRender(threadId, margin, page("seventh", "Margin"));
                  yield* mcpSessions.recordHtmlRender(threadId, margin, page("sixth", "Margin"));
                  yield* mcpSessions.recordHtmlRender(threadId, byRegion, page("eighth"));
                  yield* mcpSessions.recordHtmlRender(threadId, byMonth, page("ninth"));
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("tenth"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:1",
                    status: "completed",
                    rawOutput: "Render revenue chart",
                  });
                  // A repeated completion keeps the call's page and takes no other.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:1",
                    status: "completed",
                    rawOutput: "Render revenue chart",
                  });
                  // A call with no page published for its arguments stays as reported.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:2",
                    status: "completed",
                    rawOutput: "Render costs chart",
                  });
                  // A failed call does not claim a page.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:3",
                    status: "failed",
                    rawOutput: "MCP call timed out",
                  });
                  // Nor does a completed call whose MCP result is an error,
                  // whether the agent reports the result bare or wrapped.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:4",
                    status: "completed",
                    rawOutput: renderError,
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:5",
                    status: "completed",
                    rawOutput: { result: renderError },
                  });
                  // A call that reports its page takes that page, not the
                  // older one another call published with the same arguments,
                  // and a repeated completion takes nothing more.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:6",
                    status: "completed",
                    rawOutput: {
                      result: {
                        content: [{ type: "text", text: "Shown to the reader." }],
                        structuredContent: { htmlRender: page("sixth", "Margin") },
                      },
                    },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:6",
                    status: "completed",
                    rawOutput: "Render margin chart",
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:7",
                    status: "completed",
                    rawOutput: "Render margin chart",
                  });
                  // Calls with the same title and height that complete out of
                  // order each take the page published with their html.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:9",
                    status: "completed",
                    rawOutput: "Render revenue by month",
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:8",
                    status: "completed",
                    rawOutput: "Render revenue by region",
                  });
                  // The adapter sees only the end of a long page.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:10",
                    status: "completed",
                    rawOutput: "Render revenue report",
                  });
                  // A call without its html cannot tell which page is its own.
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "trajectory:11",
                    status: "completed",
                    rawOutput: "Render revenue chart",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
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
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = yield* session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const finalItem = (nativeId: string) =>
        Array.from(events).findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
      const toolItem = (nativeId: string) => {
        const event = finalItem(nativeId);
        return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? event.turnItem
          : undefined;
      };
      const tool = (nativeId: string) => {
        const item = toolItem(nativeId);
        return item !== undefined
          ? {
              status: item.status,
              toolName: item.toolName,
              page: htmlRenderFromToolItem(item),
              output: item.output,
            }
          : undefined;
      };

      assert.deepEqual(tool("trajectory:1"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("first"),
        output: { htmlRender: page("first") },
      });
      assert.deepEqual(tool("trajectory:2"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Render costs chart",
      });
      assert.deepEqual(tool("trajectory:3"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "MCP call timed out",
      });
      assert.deepEqual(tool("trajectory:4"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: renderError,
      });
      assert.deepEqual(tool("trajectory:5"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: renderError.content,
      });
      assert.deepEqual(tool("trajectory:6"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("sixth", "Margin"),
        output: { htmlRender: page("sixth", "Margin") },
      });
      assert.deepEqual(tool("trajectory:7"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("seventh", "Margin"),
        output: { htmlRender: page("seventh", "Margin") },
      });
      assert.deepEqual(tool("trajectory:8"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("eighth"),
        output: { htmlRender: page("eighth") },
      });
      assert.deepEqual(tool("trajectory:9"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("ninth"),
        output: { htmlRender: page("ninth") },
      });
      // The adapter saw only the end of the long page.
      assert.isAbove(report.html.length, 8_000);
      assert.propertyVal(
        toolItem("trajectory:10")?.input,
        "html",
        `[Earlier output truncated]\n\n${report.html.slice(-8_000)}`,
      );
      assert.deepEqual(tool("trajectory:10"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("tenth"),
        output: { htmlRender: page("tenth") },
      });
      assert.deepEqual(tool("trajectory:11"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Render revenue chart",
      });
      // Each page goes to one call; the unclaimed one stays for a later call.
      assert.deepEqual(yield* mcpSessions.takeHtmlRender(threadId, restated), page("second"));
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, margin), undefined);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
