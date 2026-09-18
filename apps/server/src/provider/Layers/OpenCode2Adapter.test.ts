import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { OpenCode2Settings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OpenCodeEvent } from "@opencode/client/effect";
import { ServerConfig } from "../../config.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import type { OpenCode2AdapterShape } from "../Services/OpenCode2Adapter.ts";
import { OpenCode2Runtime } from "../opencode2Runtime.ts";
import type { OpenCodeClient } from "../opencode2Runtime.ts";
import { makeOpenCode2Adapter } from "./OpenCode2Adapter.ts";

const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("opencode2-subagent-test");
const ROOT_SESSION_ID = "ses_root";
const CHILD_SESSION_ID = "ses_child";
const OPENCODE2_SETTINGS = Schema.decodeSync(OpenCode2Settings)({});

type ContentDeltaEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;
type RequestOpenedEvent = Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }>;
type TaskStartedEvent = Extract<ProviderRuntimeEvent, { readonly type: "task.started" }>;
type TaskProgressEvent = Extract<ProviderRuntimeEvent, { readonly type: "task.progress" }>;
type TaskCompletedEvent = Extract<ProviderRuntimeEvent, { readonly type: "task.completed" }>;

const isContentDeltaFor =
  (itemId: string) =>
  (event: ProviderRuntimeEvent): event is ContentDeltaEvent =>
    event.type === "content.delta" && event.itemId === itemId;

/**
 * The v2 event union is generated and enormous, so the fake events are built as
 * plain objects and cast at this single boundary — the same trade the v1 adapter
 * test makes for the generated client surface.
 */
const nativeEvent = (value: unknown): OpenCodeEvent => value as OpenCodeEvent;

/**
 * The fake event stream is a queue the test publishes into, opened by the one
 * `server.connected` that releases `startSession` and never closed — so the
 * pump settles into handling test events instead of its reconnect loop.
 */
const makeHarness = Effect.fn("makeOpenCode2AdapterHarness")(function* () {
  const inbound = yield* Queue.unbounded<OpenCodeEvent>();
  const canonicalEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const seen: ProviderRuntimeEvent[] = [];

  const client = {
    session: {
      create: () => Effect.succeed({ id: ROOT_SESSION_ID, location: { directory: process.cwd() } }),
      environment: () => Effect.void,
      switchAgent: () => Effect.void,
      switchModel: () => Effect.void,
      get: () => Effect.succeed({ id: ROOT_SESSION_ID, location: { directory: process.cwd() } }),
      form: { list: () => Effect.succeed([]) },
      prompt: () => Effect.void,
      active: () => Effect.succeed({}),
    },
    permission: { list: () => Effect.succeed([]) },
    event: {
      subscribe: () =>
        Stream.concat(
          Stream.make(nativeEvent({ type: "server.connected" })),
          Stream.fromQueue(inbound),
        ),
    },
  } as unknown as OpenCodeClient;

  const adapter: OpenCode2AdapterShape = yield* makeOpenCode2Adapter(OPENCODE2_SETTINGS, {
    instanceId: PROVIDER_INSTANCE_ID,
    environment: { SHARED_INSTANCE_VAR: "instance", T3CODE_THREAD_ID: "stale-thread" },
  }).pipe(
    Effect.provide(
      // NodeServices is outermost: ServerConfig resolves FileSystem and Path
      // through it, and `mergeAll` alone would run the layers in parallel.
      Layer.mergeAll(
        Layer.succeed(OpenCode2Runtime, {
          connect: () =>
            Effect.succeed({
              client,
              url: "http://127.0.0.1:4096",
              external: true,
              version: "2.0.5",
            }),
          loadInventory: () => Effect.succeed({ models: [], skills: [] }),
        }),
        ServerConfig.layerTest(process.cwd(), process.cwd()),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        seen.push(event);
      }).pipe(Effect.andThen(Queue.offer(canonicalEvents, event))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const publish = (event: OpenCodeEvent) => Queue.offer(inbound, event).pipe(Effect.asVoid);
  const waitForEvent = Effect.fn("OpenCode2AdapterTest.waitForEvent")(function* <
    T extends ProviderRuntimeEvent,
  >(predicate: (event: ProviderRuntimeEvent) => event is T) {
    while (true) {
      const event = yield* Queue.take(canonicalEvents);
      if (predicate(event)) return event;
    }
  });

  /**
   * Starts a session and turn, then publishes the `session.created` that binds
   * a subagent child and waits for its roster row. Every subagent test needs
   * exactly this, and the receipt matters: child events are judged against the
   * related-session set as the stream pulls, so the binding must land first.
   */
  const openSubagent = Effect.fn("OpenCode2AdapterTest.openSubagent")(function* (
    name: string,
    details?: { readonly description?: string; readonly agent?: string },
  ) {
    const threadId = ThreadId.make(name);
    yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
    const turn = yield* adapter.sendTurn({ threadId, input: "spawn a subagent" });
    const now = yield* Clock.currentTimeMillis;
    yield* publish(
      nativeEvent({
        type: "session.created",
        created: now,
        data: {
          sessionID: CHILD_SESSION_ID,
          parentID: ROOT_SESSION_ID,
          title: details?.description ?? "Review the parser",
          agent: details?.agent ?? "explore",
        },
      }),
    );
    yield* waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");
    return { threadId, turn, now };
  });

  /** Marks the first run open, which the child lifecycle normally does. */
  const startChildRun = (created: number) =>
    publish(
      nativeEvent({
        type: "session.execution.started",
        created,
        data: { sessionID: CHILD_SESSION_ID },
      }),
    );

  const childStep = (created: number, assistantMessageID: string, output: number) =>
    nativeEvent({
      type: "session.step.ended",
      created,
      data: {
        sessionID: CHILD_SESSION_ID,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 100, output, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });

  return {
    adapter,
    publish,
    seen,
    waitForEvent,
    openSubagent,
    startChildRun,
    childStep,
  };
});

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode2-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("OpenCode2Adapter", (it) => {
  it.effect("keeps a subagent child session's transcript out of the parent turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { turn, now } = yield* h.openSubagent("thread-subagent-content");

      // The child's own transcript. None of it belongs to the parent turn.
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.delta",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            ordinal: 0,
            delta: "child thinking",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.text.delta",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            ordinal: 1,
            delta: "child answer",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.ended",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            ordinal: 0,
            text: "child thinking",
          },
        }),
      );

      // Drain receipt: the last event published, so seeing it means every
      // child event above was already handled.
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.delta",
          created: now,
          data: {
            sessionID: ROOT_SESSION_ID,
            assistantMessageID: "msg_root",
            ordinal: 1,
            delta: "parent thinking",
          },
        }),
      );
      const parentDelta = yield* h.waitForEvent(isContentDeltaFor("msg_root:1"));
      NodeAssert.equal(parentDelta.turnId, turn.turnId);
      NodeAssert.equal(parentDelta.payload.streamKind, "reasoning_text");

      const childTranscript = h.seen.filter((event) => event.itemId?.startsWith("msg_child"));
      NodeAssert.deepEqual(childTranscript, []);
    }),
  );

  it.effect("still routes a subagent child session's approval request to the parent", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-approval");

      // A supervised mode keeps the ask in the parent UI instead of the
      // adapter auto-replying to it.
      yield* h.adapter.startSession({ threadId, runtimeMode: "approval-required" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: { sessionID: CHILD_SESSION_ID, parentID: ROOT_SESSION_ID },
        }),
      );
      yield* h.waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");

      yield* h.publish(
        nativeEvent({
          type: "permission.asked",
          created: now,
          data: {
            id: "per_child_approval",
            sessionID: CHILD_SESSION_ID,
            action: "bash",
            resources: ["rm -rf /tmp/probe"],
          },
        }),
      );

      const opened = yield* h.waitForEvent(
        (event): event is RequestOpenedEvent => event.type === "request.opened",
      );
      NodeAssert.equal(opened.requestId, "per_child_approval");
    }),
  );

  it.effect("surfaces a subagent on the Agents surface and settles it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-roster");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turn = yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );

      const started = yield* h.waitForEvent(
        (event): event is TaskStartedEvent => event.type === "task.started",
      );
      NodeAssert.equal(started.payload.taskId, CHILD_SESSION_ID);
      NodeAssert.equal(started.payload.title, "Review the parser");
      NodeAssert.equal(started.payload.role, "explore");
      NodeAssert.equal(started.payload.timelineBypass, true);
      NodeAssert.equal(started.turnId, turn.turnId);

      // The child's own execution lifecycle drives the roster row: busy opens
      // it as running, and its terminal frame settles it.
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.execution.succeeded",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      const completed = yield* h.waitForEvent(
        (event): event is TaskCompletedEvent => event.type === "task.completed",
      );
      NodeAssert.equal(completed.payload.taskId, CHILD_SESSION_ID);
      NodeAssert.equal(completed.payload.status, "completed");

      // The child's terminal frame must never complete the parent turn.
      const parentTurnEnded = h.seen.some((event) => event.type === "turn.completed");
      NodeAssert.equal(parentTurnEnded, false);
    }),
  );

  it.effect("counts a subagent's own step tokens without charging the parent turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-usage");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );
      yield* h.waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");

      // Two child steps: the accumulator must count each assistant message once.
      const childStep = {
        type: "session.step.ended",
        created: now,
        data: {
          sessionID: CHILD_SESSION_ID,
          assistantMessageID: "msg_child_step_1",
          finish: "stop",
          cost: 0,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
        },
      };
      yield* h.publish(nativeEvent(childStep));
      yield* h.publish(
        nativeEvent({
          ...childStep,
          data: { ...childStep.data, assistantMessageID: "msg_child_step_2" },
        }),
      );
      // A duplicate frame for an already-counted message must not double-count.
      yield* h.publish(nativeEvent(childStep));
      yield* h.publish(
        nativeEvent({
          type: "session.execution.succeeded",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      const completed = yield* h.waitForEvent(
        (event): event is TaskCompletedEvent => event.type === "task.completed",
      );
      // input 100 + cache 30 + write 10 = 140 per step; output 20 + reasoning 5.
      NodeAssert.deepEqual(completed.payload.typedUsage, {
        totalTokens: 2 * (140 + 25),
        inputTokens: 2 * 140,
        cachedInputTokens: 2 * 30,
        outputTokens: 2 * 25,
        reasoningOutputTokens: 2 * 5,
      });

      // The child's tokens belong to the child, not the parent turn accumulator.
      const parentTurnUsage = h.seen
        .filter((event) => event.type === "thread.token-usage.updated")
        .map((event) => event.payload.usage);
      NodeAssert.deepEqual(parentTurnUsage, []);
    }),
  );

  it.effect("counts a subagent's tokens up as it works, step by step", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-live-usage");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );
      yield* h.waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      // Two steps, so the count must be visible mid-run rather than only at
      // the terminal row.
      const step = (assistantMessageID: string, output: number) => ({
        type: "session.step.ended",
        created: now,
        data: {
          sessionID: CHILD_SESSION_ID,
          assistantMessageID,
          finish: "stop",
          cost: 0,
          tokens: { input: 100, output, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      yield* h.publish(nativeEvent(step("msg_step_1", 20)));
      yield* h.publish(nativeEvent(step("msg_step_2", 30)));

      const progress = yield* h.waitForEvent(
        (event): event is TaskProgressEvent =>
          event.type === "task.progress" && event.payload.typedUsage !== undefined,
      );
      NodeAssert.equal(progress.payload.taskId, CHILD_SESSION_ID);
      // The first tick lands after step one, before the run settles.
      NodeAssert.equal(progress.payload.typedUsage?.totalTokens, 120);

      const ticks = h.seen.filter(
        (event) => event.type === "task.progress" && event.payload.typedUsage !== undefined,
      );
      // input 100 per step, output 20 then 30: 120, then 250 cumulative.
      NodeAssert.deepEqual(
        ticks.map((event) =>
          event.type === "task.progress" ? event.payload.typedUsage?.totalTokens : undefined,
        ),
        [120, 250],
      );
    }),
  );

  it.effect("reopens a subagent when its session runs again", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-reactivation");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      // The spawn tool can reuse an existing child session for a later run, so
      // the same session id settles and then starts again.
      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );
      yield* h.waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.execution.succeeded",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.waitForEvent(
        (event): event is TaskCompletedEvent => event.type === "task.completed",
      );

      // Second run on the same child session.
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      const reopened = yield* h.waitForEvent(
        (event): event is TaskProgressEvent =>
          event.type === "task.progress" && event.payload.status === "running",
      );
      NodeAssert.equal(reopened.payload.taskId, CHILD_SESSION_ID);
    }),
  );

  it.effect("keeps a reused child session running after its previous run settled", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-sleep");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Reasoning task two",
            agent: "general",
          },
        }),
      );
      yield* h.waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");

      // Run 1 completes.
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.execution.succeeded",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.waitForEvent(
        (event): event is TaskCompletedEvent => event.type === "task.completed",
      );

      // Run 2 on the same session. Progress rows share one stable activity id,
      // so a status-less row cannot reopen a settled agent: the shell activity
      // must still mark it running.
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.tool.input.started",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            id: "child_shell",
            name: "shell",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.tool.called",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            id: "child_shell",
            input: { command: "sleep 15" },
            executed: true,
          },
        }),
      );

      const shellRow = yield* h.waitForEvent(
        (event): event is TaskProgressEvent =>
          event.type === "task.progress" && event.payload.lastToolName === "shell",
      );
      NodeAssert.equal(shellRow.payload.status, "running");

      // Everything after the run opener must be able to reopen the agent: every
      // activity row carries a running status.
      const afterReopen = h.seen.slice(
        h.seen.findIndex((event) => event.type === "task.completed") + 1,
      );
      const statuslessProgress = afterReopen.filter(
        (event) => event.type === "task.progress" && event.payload.status === undefined,
      );
      NodeAssert.deepEqual(statuslessProgress, []);
    }),
  );

  it.effect("shows a running subagent's current tool and counts its tool uses", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-activity");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );
      yield* h.waitForEvent((event): event is TaskStartedEvent => event.type === "task.started");
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      // The live line alternates: a reasoning block labels it "Thinking", then
      // the next tool replaces it. Both ride the progress summary the panel
      // prefers over the sticky last tool name.
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID, assistantMessageID: "msg_child", ordinal: 0 },
        }),
      );
      const thinking = yield* h.waitForEvent(
        (event): event is TaskProgressEvent =>
          event.type === "task.progress" && event.payload.summary === "Thinking",
      );
      NodeAssert.equal(thinking.payload.taskId, CHILD_SESSION_ID);

      yield* h.publish(
        nativeEvent({
          type: "session.tool.input.started",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            id: "child_call_1",
            name: "grep",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.tool.called",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            id: "child_call_1",
            input: {},
            executed: true,
          },
        }),
      );

      const toolLine = yield* h.waitForEvent(
        (event): event is TaskProgressEvent =>
          event.type === "task.progress" && event.payload.lastToolName === "grep",
      );
      NodeAssert.equal(toolLine.payload.summary, "▸ grep");
      // Without the running status this row could not reopen a settled agent
      // on a reused child session.
      NodeAssert.equal(toolLine.payload.status, "running");
      const thinkingRow = h.seen.find(
        (event): event is TaskProgressEvent =>
          event.type === "task.progress" && event.payload.summary === "Thinking",
      );
      NodeAssert.equal(thinkingRow?.payload.status, "running");

      // Two completed child tools, then settle: the count must reach the card.
      yield* h.publish(
        nativeEvent({
          type: "session.tool.success",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            id: "child_call_1",
            executed: true,
            content: [{ type: "text", text: "hit" }],
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.tool.success",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            id: "child_call_2",
            executed: true,
            content: [{ type: "text", text: "hit" }],
          },
        }),
      );

      // The child's last assistant message becomes the settled row's outcome,
      // so a completed agent reports what it produced instead of its last tool.
      yield* h.publish(
        nativeEvent({
          type: "session.text.ended",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            assistantMessageID: "msg_child",
            ordinal: 0,
            text: "The parser looks fine.",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.model.selected",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            model: { providerID: "anthropic", id: "claude-opus-5", variant: "high" },
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.execution.succeeded",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      const completed = yield* h.waitForEvent(
        (event): event is TaskCompletedEvent => event.type === "task.completed",
      );
      NodeAssert.equal(completed.payload.typedUsage?.toolUses, 2);
      NodeAssert.equal(completed.payload.summary, "The parser looks fine.");
      NodeAssert.equal(completed.payload.model, "claude-opus-5");
      NodeAssert.equal(completed.payload.effort, "high");
    }),
  );

  it.effect("gives a background subagent's roster row the spawn tool call it replaces", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-linkage");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.tool.input.started",
          created: now,
          data: {
            sessionID: ROOT_SESSION_ID,
            assistantMessageID: "msg_root",
            id: "call_1",
            name: "subagent",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );
      // Receipt: the stream filter judges child events against the related
      // set as it pulls, so the binding must be applied before anything below
      // is published. A root delta published after it proves that.
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.delta",
          created: now,
          data: {
            sessionID: ROOT_SESSION_ID,
            assistantMessageID: "msg_warmup",
            ordinal: 0,
            delta: "warmup",
          },
        }),
      );
      yield* h.waitForEvent(isContentDeltaFor("msg_warmup:0"));

      yield* h.publish(
        nativeEvent({
          type: "session.tool.success",
          created: now,
          data: {
            sessionID: ROOT_SESSION_ID,
            assistantMessageID: "msg_root",
            id: "call_1",
            executed: true,
            content: [
              {
                type: "text",
                text: "The subagent is working in the background (sessionID: ses_child). You will be notified automatically when it finishes.",
              },
            ],
          },
        }),
      );
      // The child's lifecycle lands after its spawn result, and its progress
      // row must carry the linked tool call so the chat fold can replace the
      // launch row instead of showing both.
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      const progress = yield* h.waitForEvent(
        (event): event is TaskProgressEvent => event.type === "task.progress",
      );
      NodeAssert.equal(progress.payload.taskId, CHILD_SESSION_ID);
      NodeAssert.equal(progress.payload.toolUseId, "call_1");
    }),
  );

  it.effect("produces a roster entry the Agents panel fold accepts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("thread-subagent-panel");

      yield* h.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "spawn a subagent" });
      const now = yield* Clock.currentTimeMillis;

      yield* h.publish(
        nativeEvent({
          type: "session.created",
          created: now,
          data: {
            sessionID: CHILD_SESSION_ID,
            parentID: ROOT_SESSION_ID,
            title: "Review the parser",
            agent: "explore",
          },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.delta",
          created: now,
          data: {
            sessionID: ROOT_SESSION_ID,
            assistantMessageID: "msg_warmup",
            ordinal: 0,
            delta: "warmup",
          },
        }),
      );
      yield* h.waitForEvent(isContentDeltaFor("msg_warmup:0"));
      yield* h.publish(
        nativeEvent({
          type: "session.execution.started",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );
      yield* h.publish(
        nativeEvent({
          type: "session.execution.succeeded",
          created: now,
          data: { sessionID: CHILD_SESSION_ID },
        }),
      );

      // Drain receipt: the last child event published, so every task row above
      // has already been emitted once it arrives.
      yield* h.publish(
        nativeEvent({
          type: "session.reasoning.delta",
          created: now,
          data: {
            sessionID: ROOT_SESSION_ID,
            assistantMessageID: "msg_drain",
            ordinal: 1,
            delta: "drain",
          },
        }),
      );
      yield* h.waitForEvent(isContentDeltaFor("msg_drain:1"));

      // The Agents panel is a fold over persisted activities. Asserting the
      // activities ingestion derives from the adapter's own events pins the
      // contract the fold reads: a real agent task, with an identity and a
      // terminal status, and no content leaking into the timeline.
      const activities = h.seen.flatMap((event) =>
        runtimeEventToActivities(event).map((activity) => ({
          ...activity,
          threadId,
          turnId: activity.turnId ?? null,
        })),
      );
      const taskRows = activities.filter((activity) => activity.kind.startsWith("task."));
      NodeAssert.deepEqual(
        taskRows.map((activity) => activity.kind),
        ["task.started", "task.progress", "task.completed"],
      );
      for (const row of taskRows) {
        const payload = row.payload as Record<string, unknown>;
        NodeAssert.equal(payload.taskId, CHILD_SESSION_ID);
        // The client fold only admits rows the server stamped as agents.
        NodeAssert.equal(payload.agentKind, "agent");
        NodeAssert.equal(payload.title, "Review the parser");
        NodeAssert.equal(payload.role, "explore");
        NodeAssert.equal(payload.timelineBypass, true);
      }
      const completed = taskRows.at(-1)?.payload as Record<string, unknown>;
      NodeAssert.equal(completed.status, "completed");
    }),
  );
});
