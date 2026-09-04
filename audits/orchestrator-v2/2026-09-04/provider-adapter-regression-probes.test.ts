import type { SDKMessage } from "../../../apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import * as NodeServices from "../../../apps/server/node_modules/@effect/platform-node/dist/NodeServices.js";
import { assert, it } from "../../../apps/server/node_modules/@effect/vitest/dist/index.js";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "../../../apps/server/node_modules/@t3tools/contracts/src/index.ts";
import * as DateTime from "../../../apps/server/node_modules/effect/dist/DateTime.js";
import * as Effect from "../../../apps/server/node_modules/effect/dist/Effect.js";
import * as Fiber from "../../../apps/server/node_modules/effect/dist/Fiber.js";
import * as FileSystem from "../../../apps/server/node_modules/effect/dist/FileSystem.js";
import * as Layer from "../../../apps/server/node_modules/effect/dist/Layer.js";
import * as Option from "../../../apps/server/node_modules/effect/dist/Option.js";
import * as Path from "../../../apps/server/node_modules/effect/dist/Path.js";
import * as Queue from "../../../apps/server/node_modules/effect/dist/Queue.js";
import * as Schema from "../../../apps/server/node_modules/effect/dist/Schema.js";
import * as Stream from "../../../apps/server/node_modules/effect/dist/Stream.js";

import {
  CLAUDE_DEFAULT_INSTANCE_ID,
  CLAUDE_PROVIDER,
  makeClaudeAdapterV2,
} from "../../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../../../apps/server/src/orchestration-v2/ProviderAdapter.ts";
import {
  layer as idAllocatorLayer,
  IdAllocatorV2,
} from "../../../apps/server/src/orchestration-v2/IdAllocator.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [],
} satisfies ModelSelection;
const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function appThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude terminal reason audit probe",
    providerInstanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function turnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): ProviderAdapterV2TurnInput {
  const attemptId = RunAttemptId.make("attempt-claude-terminal-reason-audit");
  return {
    appThread: appThread(input),
    threadId: input.threadId,
    runId: RunId.make("run-claude-terminal-reason-audit"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make("node-claude-terminal-reason-audit"),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message-claude-terminal-reason-audit"),
      text: "hello",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  };
}

const apiErrorResult = {
  type: "result",
  subtype: "success",
  duration_ms: 10,
  duration_api_ms: 10,
  is_error: false,
  num_turns: 0,
  result: "",
  errors: [],
  stop_reason: null,
  terminal_reason: "api_error",
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  uuid: "result-claude-terminal-reason-audit",
  session_id: "native-claude-terminal-reason-audit",
} as unknown as SDKMessage;

it.effect("reproduces V2 completing a Claude api_error terminal reason", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocatorV2;
    const messages = yield* Queue.unbounded<SDKMessage>();
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-terminal-reason-audit-",
    });
    const adapter = makeClaudeAdapterV2({
      instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
      settings,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      idAllocator,
      queryRunner: {
        allocateSessionId: Effect.succeed("native-claude-terminal-reason-audit"),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(messages),
            offer: () => Effect.void,
            setModel: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused forkSession"),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-terminal-reason-audit");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("session-claude-terminal-reason-audit"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy,
    });
    const terminalFiber = yield* runtime.events.pipe(
      Stream.filter(
        (event): event is Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      ),
      Stream.runHead,
      Effect.forkScoped,
    );

    yield* runtime.startTurn(
      turnInput({
        threadId,
        providerThread,
        now: yield* DateTime.now,
      }),
    );
    yield* Queue.offer(messages, apiErrorResult);

    const terminalOption = yield* Fiber.join(terminalFiber);
    assert.isTrue(Option.isSome(terminalOption));
    const terminal = Option.getOrThrow(terminalOption);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.failure, null);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
);
