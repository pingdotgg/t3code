import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makePiAdapterV2 } from "./adapter.ts";

const piRpc = `
const { createInterface } = require("node:readline");
const send = (record) => console.log(JSON.stringify(record));
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, type } = JSON.parse(line);
  const data = type === "get_state" ? {
    sessionId: "00000000-0000-4000-8000-000000000002",
    sessionFile: "/workspace/session.jsonl",
    isStreaming: false,
    isCompacting: false,
  } : undefined;
  send({ id, type: "response", command: type, success: true, data });
  if (type === "prompt") {
    send({ type: "agent_start" });
    send({
      type: "tool_execution_update",
      toolName: "read",
      toolCallId: "read-image",
      args: { path: "@/workspace/screens/shot.png" },
      partialResult: { content: [{ type: "text", text: "Read image file [image/png]" }] },
    });
  }
});
`;

it.live("previews an @-prefixed Pi image read while it is running", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("pi");
    const threadId = ThreadId.make("thread-pi-read-preview");
    const modelSelection = { instanceId, model: "default" };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: null,
    });
    const adapter = yield* makePiAdapterV2({
      instanceId,
      settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      environment: {},
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("pi-read-preview"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const appThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: "project:pi-read-preview" as OrchestrationV2AppThread["projectId"],
      title: "Preview a Pi image",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      lastVisitedAt: null,
      deletedAt: null,
    } satisfies OrchestrationV2AppThread;
    const preview = yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "turn_item.updated"),
      Stream.map((event) => event.turnItem),
      Stream.filter((item) => item.type === "dynamic_tool"),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* runtime.startTurn({
      appThread,
      threadId,
      runId: RunId.make("run:pi-read-preview"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt:pi-read-preview"),
      rootNodeId: NodeId.make("node:pi-read-preview"),
      providerThread,
      message: {
        messageId: "message:pi-read-preview" as never,
        text: "Read the screenshot",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection,
      runtimePolicy,
    });
    const item = Option.getOrThrow(yield* Fiber.join(preview));
    assert.equal(item.status, "running");
    assert.equal(item.viewedImagePath, "/workspace/screens/shot.png");
  }).pipe(
    Effect.provideService(AgentScope, {
      ...AgentScope.defaultValue(),
      wrap: () => Effect.succeed({ command: process.execPath, args: ["-e", piRpc] }),
    }),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
);
