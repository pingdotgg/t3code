// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import { TestClock } from "effect/testing";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  OPENCODE_2_STILL_STOPPING,
  OPENCODE_PROVIDER,
  t3McpServerName,
} from "@t3tools/provider-opencode/testing";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";

import {
  SESSION,
  WORK,
  instanceId,
  threadId,
  out,
  reply,
  replyData,
  event,
  durable,
  sessionInfo,
  PROMPT_ID,
  promptAccepted,
  noOpenRequests,
  openCode2ReplayRuntimeWithInstructions,
  opening,
  directoryModels,
  bigPickle,
  policy,
  providerThread,
  turnInput,
  shellAsk,
  shellAskEvent,
  resumed,
  requestOf,
  terminalOf,
  history,
  reconnected,
  openRequests,
  turnItems,
  providerTurnId,
} from "./OpenCode2AdapterV2-fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("does not end a turn from an earlier turn's history when its prompt is not there", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        { type: "runtime_exit", status: "success" } as const,
        out("event.subscribe"),
        out("session.active"),
        replyData("session.active", {}),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
        reply("message.list", {
          data: [
            { id: "msg_idle_earlier", time: { created: 3 }, type: "idle", outcome: "succeeded" },
            {
              id: "msg_assistant_earlier",
              time: { created: 2 },
              type: "assistant",
              agent: "build",
              model: { id: "big-pickle", providerID: "opencode", variant: "default" },
              content: [{ type: "text", text: "An earlier turn's answer." }],
              finish: "stop",
            },
            { id: "msg_user_earlier", time: { created: 1 }, text: "earlier", type: "user" },
          ],
          cursor: {},
        }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      assert.notInclude(
        collected.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        ),
        "An earlier turn's answer.",
      );
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "interrupted" });
    }).pipe(Effect.scoped),
  );
  it.effect("ends a turn that finished while the stream was down with the server's outcome", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        event("session.step.started", {
          sessionID: SESSION,
          assistantMessageID: "msg_before_gap",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          started: 1,
        }),
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_before_gap",
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        ...reconnected({}, "succeeded"),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      assert.includeMembers(turnItems(collected), [
        "assistant_message:completed",
        "command_execution:completed",
      ]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      // Steps that ended during the gap sent no tokens or models, so both stay incomplete.
      const settled = collected.findLast(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
      );
      const usage =
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined;
      assert.deepInclude(usage, { usageStatus: "partial", inputTokens: 100, outputTokens: 10 });
      assert.notProperty(usage, "models");
    }).pipe(Effect.scoped),
  );
  it.effect("finishes a workspace command whose stream dropped before its inbox event", () =>
    Effect.gen(function* () {
      // session.command returns 204 without an inbox id; the stream drops before session.inbox.enqueued provides it.
      const { runtime, thread } = yield* resumed([
        out("command.list", "<any>"),
        reply("command.list", { location: { directory: WORK }, data: [{ name: "git/hello" }] }),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
        reply("message.list", {
          data: [
            { id: "msg_idle_before", time: { created: 1 }, type: "idle", outcome: "succeeded" },
          ],
          cursor: {},
        }),
        out("session.command", { sessionID: SESSION, name: "git/hello", text: "WORLD" }),
        reply("session.command", null),
        { type: "runtime_exit", status: "success" } as const,
        out("event.subscribe"),
        out("session.active"),
        replyData("session.active", {}),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
        reply("message.list", {
          data: [
            { id: "msg_idle_cmd", time: { created: 4 }, type: "idle", outcome: "succeeded" },
            {
              id: "msg_assistant_cmd",
              time: { created: 3 },
              type: "assistant",
              agent: "build",
              model: { id: "big-pickle", providerID: "opencode", variant: "default" },
              content: [{ type: "text", text: "HELLO WORLD" }],
              finish: "stop",
            },
            {
              id: "msg_user_cmd",
              time: { created: 2 },
              text: "Reply with exactly: HELLO WORLD",
              type: "user",
            },
            { id: "msg_idle_before", time: { created: 1 }, type: "idle", outcome: "succeeded" },
          ],
          cursor: {},
        }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn({
        ...turnInput(thread),
        message: { ...turnInput(thread).message, text: "/git/hello WORLD" },
      });
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.include(texts, "HELLO WORLD");
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }).pipe(Effect.scoped),
  );
  it.effect("sends a $skill that appears once OpenCode finishes scanning the directory", () =>
    Effect.gen(function* () {
      const prompts: Array<unknown> = [];
      const greet = {
        id: "greet",
        name: "greet",
        path: `${WORK}/.opencode/skills/greet/SKILL.md`,
        content: "Say hello.",
      };
      const { runtime, thread } = yield* resumed(
        [
          out("skill.list", { "location[directory]": WORK }),
          reply("skill.list", { location: { directory: WORK }, data: [] }),
          // OpenCode answers the model list only once the directory scan has ended.
          ...directoryModels(WORK),
          out("skill.list", { "location[directory]": WORK }),
          reply("skill.list", { location: { directory: WORK }, data: [greet] }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { onPrompt: (input) => prompts.push(input) },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const started = yield* runtime
        .startTurn({
          ...turnInput(thread),
          message: { ...turnInput(thread).message, text: "$greet again please" },
        })
        .pipe(Effect.exit);
      assert.deepInclude(prompts[0], { skills: [{ id: "greet" }] });
      assert.isTrue(Exit.isSuccess(started));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps a $skill found on the first read when the reread after the scan comes back empty",
    () =>
      Effect.gen(function* () {
        const prompts: Array<unknown> = [];
        const greet = {
          id: "greet",
          name: "greet",
          path: `${WORK}/.opencode/skills/greet/SKILL.md`,
          content: "Say hello.",
        };
        const { runtime, thread } = yield* resumed(
          [
            out("skill.list", { "location[directory]": WORK }),
            reply("skill.list", { location: { directory: WORK }, data: [greet] }),
            ...directoryModels(WORK),
            out("skill.list", { "location[directory]": WORK }),
            reply("skill.list", { location: { directory: WORK }, data: [] }),
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { onPrompt: (input) => prompts.push(input) },
        );
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn({
          ...turnInput(thread),
          message: { ...turnInput(thread).message, text: "$greet then echo $HOME" },
        });
        assert.equal((yield* Fiber.join(terminal))?.status, "completed");
        assert.deepInclude(prompts[0], { skills: [{ id: "greet" }] });
      }).pipe(Effect.scoped),
  );
  it.effect("keeps a turn still running after a reconnect open for its next events", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        ...reconnected({ [SESSION]: { type: "running" } }),
        ...openRequests([]),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant_after",
          ordinal: 0,
          text: "Arrived on the new stream.",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.includeMembers(texts, [
        "Sent while the stream was down.",
        "Arrived on the new stream.",
      ]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }).pipe(Effect.scoped),
  );
  it.effect("continues a reply still streaming at reconnect from the text already shown", () =>
    Effect.gen(function* () {
      const delta = (text: string) =>
        event("session.text.delta", {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant_gap",
          ordinal: 0,
          delta: text,
        });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        delta("Sent before the stream dropped"),
        // OpenCode saves a block's text only when the block ends.
        ...reconnected({ [SESSION]: { type: "running" } }, undefined, {
          content: [{ type: "text", text: "" }],
          finish: undefined,
        }),
        ...openRequests([]),
        delta(" and after it came back."),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.deepEqual(texts, [
        "Sent before the stream dropped",
        "Sent before the stream dropped",
        "Sent before the stream dropped and after it came back.",
        "Sent before the stream dropped and after it came back.",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("shows a permission asked while the stream was down, and answers it", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          ...reconnected({ [SESSION]: { type: "running" } }),
          ...openRequests([shellAsk.data]),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      assert.equal(request?.nativeRequestRef?.nativeId, shellAsk.data.id);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("settles a request OpenCode no longer lists after the stream came back", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          ...reconnected({ [SESSION]: { type: "running" } }),
          ...openRequests([]),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const collected = yield* Fiber.join(events);
      const statuses = collected.flatMap((event) =>
        event.type === "runtime_request.updated" ? [event.runtimeRequest.status] : [],
      );
      assert.deepEqual(statuses, ["pending", "cancelled"]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }).pipe(Effect.scoped),
  );
  it.effect("keeps thread-scoped T3 waits as dynamic tools through their lifecycle", () =>
    Effect.gen(function* () {
      const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-wait" };
      const name = "t3-code-web_delegate_task";
      const input = { task: "Review", mode: "wait" };
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.tool.input.started", { ...tool, name }),
        event("session.tool.called", { ...tool, name, input, executed: true }),
        event("session.tool.success", {
          ...tool,
          content: [{ type: "text", text: "Reviewed" }],
          metadata: {},
          executed: true,
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const items = (yield* Fiber.join(events)).flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId?.endsWith(tool.id)
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        items.map((item) => item.type),
        ["dynamic_tool", "dynamic_tool", "dynamic_tool"],
      );
      assert.deepEqual(
        items.map((item) => item.status),
        ["running", "running", "completed"],
      );
      const last = items.at(-1);
      assert.equal(last?.type === "dynamic_tool" ? last.toolName : null, name);
      assert.deepEqual(last?.type === "dynamic_tool" ? last.input : null, input);
    }).pipe(Effect.scoped),
  );
  it.effect("stores a shell command that exits non-zero as failed", () =>
    Effect.gen(function* () {
      const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-exit" };
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.tool.input.started", { ...tool, name: "shell" }),
        event("session.tool.called", { ...tool, input: { command: "vp test" }, executed: false }),
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_toolsuccess_call-exit",
              created: 1,
              type: "session.tool.success",
              data: {
                ...tool,
                content: [{ type: "text", text: "1 failed\n" }],
                metadata: { status: "completed", truncated: false, exit: 1 },
                executed: false,
              },
              durable: { aggregateID: SESSION, seq: 1, version: 2 },
            },
          },
        },
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const item = collected
        .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []))
        .findLast((item) => item.nativeItemRef?.nativeId?.endsWith(tool.id));
      assert.equal(item?.type, "command_execution");
      assert.equal(item?.status, "failed");
      assert.equal(item?.type === "command_execution" ? item.exitCode : null, 1);
      assert.equal(
        collected
          .flatMap((event) => (event.type === "node.updated" ? [event.node] : []))
          .findLast((node) => node.id === item?.nodeId)?.status,
        "failed",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("re-registers T3 MCP each turn and drops its instructions when adding fails", () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment:opencode2-adapter"),
        threadId,
        providerSessionId: "mcp:opencode2-adapter",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));
      const server = "t3-code-thread_opencode2-adapter";
      const add = out("mcp.add", {
        server,
        "location[directory]": WORK,
        config: {
          type: "remote",
          url: "http://127.0.0.1:3773/mcp",
          headers: { Authorization: "Bearer thread-credential" },
          oauth: false,
        },
      });
      const turn = [
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ];
      // Idle Location eviction drops OpenCode's runtime MCP servers without a reconnect.
      const { runtime, thread } = yield* resumed([
        add,
        reply("mcp.add", null),
        ...turn,
        add,
        reply("mcp.add", { status: 500, body: { message: "MCP unavailable" } }),
        out("session.instructions.entry.put", {
          sessionID: SESSION,
          key: "t3-code",
          value: buildRuntimeInstructions({ harness: "OpenCode", model: bigPickle.model }),
        }),
        reply("session.instructions.entry.put", null),
        ...turn,
        out("mcp.remove", { server, "location[directory]": WORK }),
        reply("mcp.remove", null),
      ]);
      for (let index = 0; index < 2; index++) {
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread));
        assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      }
    }).pipe(Effect.scoped),
  );
  it.effect("registers a long thread id's MCP server under a name OpenCode accepts", () =>
    Effect.gen(function* () {
      const child = ThreadId.make(
        "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Asubproject-b-round1",
      );
      const server = "t3-code-aa73fa1e03099934";
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment:opencode2-adapter"),
        threadId: child,
        providerSessionId: "mcp:opencode2-adapter",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(child));
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData(
          "session.get",
          sessionInfo({
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "t3-code-*", resource: "*", effect: "deny" },
              { action: `${server}_*`, resource: "*", effect: "allow" },
            ],
          }),
        ),
        ...noOpenRequests,
        out("mcp.add", {
          server,
          "location[directory]": WORK,
          config: {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp",
            headers: { Authorization: "Bearer thread-credential" },
            oauth: false,
          },
        }),
        reply("mcp.add", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("mcp.remove", { server, "location[directory]": WORK }),
        reply("mcp.remove", null),
      ]);
      const thread = yield* runtime.resumeThread({
        providerThread: { ...providerThread(yield* DateTime.now), appThreadId: child },
        threadId: child,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn({ ...turnInput(thread), threadId: child });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      yield* runtime.unloadThread!({ providerThread: thread });
    }).pipe(Effect.scoped),
  );

  // regression: #16142 OpenCode 2 threads were missing T3 Code's MCP tools
  it.effect("names each thread's MCP server within OpenCode's limits, one name per thread", () =>
    Effect.gen(function* () {
      const project = "thread:project:ce04e4e2-6c29-4ff0-a1d7-b089dd63e258";
      const ids = [
        `${project}:d3b2d715-c4a1-4b63-bb65-1634c3a3a8c4`,
        `${project}:d3b2d715-c4a1-4b63-bb65-1634c3a3a8c5`,
        "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Around1",
        "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Around2",
      ];
      const names = yield* Effect.forEach(ids, t3McpServerName);
      for (const name of names) assert.match(name, /^t3-code-[A-Za-z0-9_-]{1,56}$/);
      assert.equal(new Set(names).size, ids.length);
      assert.deepEqual(yield* Effect.forEach(ids, t3McpServerName), names);
      assert.equal(names[0], "t3-code-63abb5df2b188bdd");
      assert.equal(yield* t3McpServerName(threadId), "t3-code-thread_opencode2-adapter");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect.each([
    {
      external: false,
      name: "sends only existing supported images as turn and steer prompt files with path text",
    },
    {
      external: true,
      name: "keeps turn and steer attachment paths without local files for external servers",
    },
  ])("$name", ({ external }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3 oc2 #images-",
      });
      const image = (id: string, name: string, mimeType = "image/png") =>
        ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(`thread-opencode2-adapter-${id}-1234-1234-1234-123456789abc`),
          name,
          mimeType,
          sizeBytes: 4,
        });
      const screenshot = image("12345678", "screen shot.png");
      const chart = image("abcdefab", "chart.webp", "image/webp");
      const missing = image("23456789", "missing.png");
      const unsupported = image("34567890", "diagram.svg", "image/svg+xml");
      const document = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("thread-opencode2-adapter-45678901-1234-1234-1234-123456789abc"),
        name: "requirements.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      });
      for (const attachment of [screenshot, chart, unsupported, document]) {
        yield* fileSystem.writeFileString(
          resolveAttachmentPath({ attachmentsDir, attachment })!,
          "data",
        );
      }
      const prompts: Array<unknown> = [];
      const steerId = "msg_recorded_steer_image";
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          out("session.prompt", { sessionID: SESSION, id: steerId, delivery: "steer" }),
          replyData("session.prompt", {
            id: steerId,
            sessionID: SESSION,
            time: { created: 1790656601500 },
            type: "user",
            payload: { text: "And this one?" },
            delivery: "steer",
          }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { attachmentsDir, external, onPrompt: (input) => prompts.push(input) },
      );
      const ids = yield* IdAllocator.IdAllocatorV2;
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const input = turnInput(thread);
      yield* runtime.startTurn({
        ...input,
        message: {
          ...input.message,
          text: "What is in this image?",
          attachments: [screenshot, missing, unsupported, document],
        },
      });
      yield* runtime.steerTurn({
        threadId,
        runId: input.runId,
        providerThread: thread,
        providerTurnId: ids.derive.providerTurn({
          driver: OPENCODE_PROVIDER,
          nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter`,
        }),
        message: {
          ...input.message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "And this one?",
          attachments: [chart, missing, unsupported, document],
        },
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      assert.equal(prompts.length, 2);
      for (const [index, attachment] of [screenshot, chart].entries()) {
        const path = resolveAttachmentPath({ attachmentsDir, attachment })!;
        assert.deepInclude(prompts[index], {
          text: [
            index === 0 ? "What is in this image?" : "And this one?",
            `[Attached image "${attachment.name}" is saved at: ${path}]`,
            `[Attached image "missing.png" is saved at: ${attachmentsDir}/${missing.id}.png]`,
            `[Attached image "diagram.svg" is saved at: ${attachmentsDir}/${unsupported.id}.svg]`,
            `[Attached file "requirements.pdf" is saved at: ${attachmentsDir}/${document.id}.pdf]`,
          ].join("\n\n"),
        });
        if (external) {
          assert.notProperty(prompts[index], "files");
        } else {
          assert.deepInclude(prompts[index], {
            files: [
              {
                uri: NodeURL.pathToFileURL(path).href,
                name: attachment.name,
              },
            ],
          });
        }
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer))),
  );
});
