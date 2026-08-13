import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makeAetherEventMapper, parseAetherQuestions } from "./eventMapper.ts";
import type { AetherTask } from "./restSchemas.ts";
import {
  FIXTURE_TASK_ID,
  deltaRows,
  makeDelta,
  taskAwaitingMessage,
  taskAwaitingPlan,
  taskAwaitingQuestions,
  taskErrored,
  taskProcessing,
  wsAssistantDelta,
  wsAwaitingInputPlan,
  wsAwaitingInputQuestions,
  wsAwaitingInputStopTask,
  wsClaudeEdit,
  wsCodexFileChange,
  wsCommandFailed,
  wsCommandStarted,
  wsConversationTruncated,
  wsGoldenTurn,
  wsMcpToolCall,
  wsSlashCommandsUpdated,
  wsThinkingDelta,
  wsTodoTool,
  wsToolDenied,
  wsTurnCompleted,
  wsTurnFailed,
} from "./eventMapper.fixtures.ts";
import { parseAetherAgentFrame, type AetherAgentEvent } from "./wireEvents.ts";

const NOW = "2026-08-08T12:00:00.000Z";

const makeMapper = (initialSequence = 0) =>
  makeAetherEventMapper({
    provider: ProviderDriverKind.make("aether"),
    instanceId: ProviderInstanceId.make("aether"),
    threadId: ThreadId.make("thread-1"),
    taskId: FIXTURE_TASK_ID,
    initialSequence,
  });

/** Fixtures are RAW wire frames; route them through the real frame parser so
 * the fixtures also pin the wireEvents schemas to the golden shapes. */
function parseFrame(frame: unknown): AetherAgentEvent {
  const result = parseAetherAgentFrame(JSON.stringify(frame));
  if (result._tag !== "event") {
    throw new Error(`fixture did not parse as an event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

function eventIds(events: ReadonlyArray<ProviderRuntimeEvent>): ReadonlyArray<string> {
  return events.map((event) => event.eventId);
}

describe("AetherEventMapper — live WS events", () => {
  it("snapshots the full golden turn (13-kind coverage)", () => {
    const mapper = makeMapper();
    const events = wsGoldenTurn.flatMap((frame) => [...mapper.mapWsEvent(parseFrame(frame), NOW)]);
    expect(events).toMatchSnapshot();
  });

  it("maps assistant deltas to assistant_text with deterministic ids", () => {
    const mapper = makeMapper();
    const [event] = mapper.mapWsEvent(parseFrame(wsAssistantDelta), NOW);
    expect(event).toMatchObject({
      type: "content.delta",
      eventId: "aether:task-1:stream:m1:1",
      itemId: "m1",
      turnId: "aether-turn-u1",
      payload: { streamKind: "assistant_text", delta: "Looking at the" },
    });
  });

  it("maps thinking deltas to reasoning_text, never assistant_text", () => {
    const mapper = makeMapper();
    const [event] = mapper.mapWsEvent(parseFrame(wsThinkingDelta), NOW);
    expect(event).toMatchObject({
      type: "content.delta",
      itemId: "thinking:m2",
      payload: { streamKind: "reasoning_text" },
    });
  });

  it("parses codex file_change input into data.files path chips", () => {
    const mapper = makeMapper();
    const [event] = mapper.mapWsEvent(parseFrame(wsCodexFileChange), NOW);
    expect(event).toMatchObject({
      type: "item.completed",
      eventId: "aether:task-1:tool:call-fc-codex:output-available",
      itemId: "call-fc-codex",
      payload: {
        itemType: "file_change",
        status: "completed",
        data: {
          toolCallId: "call-fc-codex",
          files: [{ path: "src/app.ts" }, { path: "src/new.ts" }],
        },
      },
    });
  });

  it("parses a claude Edit into a single data.files entry", () => {
    const mapper = makeMapper();
    const [event] = mapper.mapWsEvent(parseFrame(wsClaudeEdit), NOW);
    expect(event).toMatchObject({
      payload: {
        itemType: "file_change",
        data: { files: [{ path: "src/util.ts" }] },
      },
    });
  });

  it("tracks command lifecycle and appends the nonzero exit-code marker", () => {
    const mapper = makeMapper();
    const [started] = mapper.mapWsEvent(parseFrame(wsCommandStarted), NOW);
    expect(started).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        data: { item: { command: "pnpm test", cwd: "/home/coder/project" } },
      },
    });
    const [failed] = mapper.mapWsEvent(parseFrame(wsCommandFailed), NOW);
    expect(failed).toMatchObject({
      type: "item.completed",
      eventId: "aether:task-1:tool:call-bash:output-error",
      payload: { itemType: "command_execution", status: "failed" },
    });
    expect(failed?.type === "item.completed" && failed.payload.detail).toBe(
      "pnpm test\n1 test failed\n<exited with exit code 1>",
    );
  });

  it("maps output-denied to declined plus a tool.denied event", () => {
    const mapper = makeMapper();
    const events = mapper.mapWsEvent(parseFrame(wsToolDenied), NOW);
    expect(events.map((event) => event.type)).toEqual(["item.completed", "tool.denied"]);
    expect(events[0]).toMatchObject({ payload: { status: "declined" } });
    expect(events[1]).toMatchObject({
      payload: { toolName: "Bash", toolUseId: "call-denied", reason: "denied by policy" },
    });
  });

  it("shapes mcp tool cards as data.item {server, tool, args, result}", () => {
    const mapper = makeMapper();
    const [event] = mapper.mapWsEvent(parseFrame(wsMcpToolCall), NOW);
    expect(event).toMatchObject({
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            server: "linear",
            tool: "create_issue",
            args: { title: "Fix flake" },
            result: '{"id":"LIN-1"}',
          },
        },
      },
    });
  });

  it("projects todo_list display blocks into turn.plan.updated", () => {
    const mapper = makeMapper();
    const events = mapper.mapWsEvent(parseFrame(wsTodoTool), NOW);
    const plan = events.find((event) => event.type === "turn.plan.updated");
    expect(plan).toMatchObject({
      payload: {
        plan: [
          { step: "Reproduce the failure", status: "completed" },
          { step: "Fix the reducer", status: "inProgress" },
          { step: "Add a regression test", status: "pending" },
        ],
      },
    });
  });

  it("settles turn.completed exactly once per wire turn", () => {
    const mapper = makeMapper();
    const first = mapper.mapWsEvent(parseFrame(wsTurnCompleted), NOW);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "turn.completed",
      eventId: "aether:task-1:turn:u1:settled",
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
    expect(mapper.mapWsEvent(parseFrame(wsTurnCompleted), NOW)).toHaveLength(0);
  });

  it("maps turn.failed to a failed settle plus runtime.error", () => {
    const mapper = makeMapper();
    const events = mapper.mapWsEvent(parseFrame(wsTurnFailed), NOW);
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "runtime.error"]);
    expect(events[0]).toMatchObject({
      payload: { state: "failed", errorMessage: "agent crashed" },
    });
    // NO turnId on the error card: ingestion's runtime.error branch would
    // reinstate activeTurnId to it AFTER the settle just cleared it, wedging
    // the session on a settled turn.
    expect(events[1]!.turnId).toBeUndefined();
  });

  it("drops live deltas whose item.completed twin already landed (reconnect overlap window)", () => {
    const mapper = makeMapper();
    // Frames queue from the moment the socket opens but drain only after the
    // reconcile — a message that completed inside that window arrives twice:
    // durable row first, stale live deltas second.
    mapper.reconcileDelta(makeDelta(), NOW);
    expect(mapper.mapWsEvent(parseFrame(wsAssistantDelta), NOW)).toHaveLength(0);
    expect(mapper.mapWsEvent(parseFrame(wsThinkingDelta), NOW)).toHaveLength(0);
    // A message the reconcile has NOT completed still streams normally.
    const fresh = mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, messageId: "m9" }), NOW);
    expect(fresh.map((event) => event.type)).toContain("content.delta");
  });

  it("settles the displaced predecessor before the first event of a DIFFERENT live turn", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAssistantDelta), NOW); // tracks u1
    // u1's live-only settle was missed; u2 starting proves u1 ended.
    const events = mapper.mapWsEvent(
      parseFrame({ ...wsAssistantDelta, turnId: "u2", messageId: "m9" }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "content.delta"]);
    expect(events[0]).toMatchObject({
      eventId: "aether:task-1:turn:u1:settled",
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
  });

  it("maps live ask_user to settle + user-input.requested + waiting", () => {
    const mapper = makeMapper();
    const events = mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    expect(events.map((event) => event.type)).toEqual([
      "turn.completed",
      "user-input.requested",
      "session.state.changed",
    ]);
    const requested = events[1]!;
    expect(requested).toMatchObject({
      eventId: "aether:task-1:input:pi-1",
      requestId: "pi-1",
      turnId: "aether-turn-u1",
    });
    if (requested.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    // The wire option without a description gets one synthesized (= label).
    expect(requested.payload.questions).toEqual([
      {
        id: "q1",
        header: "Approach",
        question: "Which approach should I take?",
        options: [
          { label: "Patch the reducer", description: "Smallest change" },
          { label: "Rewrite the module", description: "Rewrite the module" },
        ],
        multiSelect: false,
      },
    ]);
    expect(events[2]).toMatchObject({ payload: { state: "waiting" } });
  });

  it("maps live propose_plan to settle + turn.proposed.completed + waiting", () => {
    const mapper = makeMapper();
    const events = mapper.mapWsEvent(parseFrame(wsAwaitingInputPlan), NOW);
    expect(events.map((event) => event.type)).toEqual([
      "turn.completed",
      "turn.proposed.completed",
      "session.state.changed",
    ]);
    expect(events[1]).toMatchObject({
      requestId: "pi-2",
      payload: { planMarkdown: "1. Reproduce\n2. Fix\n3. Test" },
    });
  });

  it("maps stop_task to settle only — no prompt, no waiting", () => {
    const mapper = makeMapper();
    const events = mapper.mapWsEvent(parseFrame(wsAwaitingInputStopTask), NOW);
    expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
  });

  it("surfaces conversation.truncated as a runtime.warning", () => {
    const mapper = makeMapper();
    const [event] = mapper.mapWsEvent(parseFrame(wsConversationTruncated), NOW);
    expect(event).toMatchObject({
      type: "runtime.warning",
      eventId: "aether:task-1:truncated:m1",
      payload: { detail: { anchorMessageId: "m1" } },
    });
  });

  it("maps slash_commands.updated to nothing", () => {
    const mapper = makeMapper();
    expect(mapper.mapWsEvent(parseFrame(wsSlashCommandsUpdated), NOW)).toHaveLength(0);
  });
});

describe("AetherEventMapper — durable reconciliation", () => {
  it("snapshots a full delta replay from a cold cursor", () => {
    const mapper = makeMapper();
    expect(mapper.reconcileDelta(makeDelta(), NOW)).toMatchSnapshot();
    expect(mapper.latestSequence()).toBe(5);
  });

  it("dedupes REST twins of live completions, including prefixed id forms", () => {
    const mapper = makeMapper();
    // Live path first: bare assistant id, thinking-prefixed thinking id.
    const live = wsGoldenTurn.flatMap((frame) => [...mapper.mapWsEvent(parseFrame(frame), NOW)]);
    expect(eventIds(live)).toContain("aether:task-1:item:m1");
    expect(eventIds(live)).toContain("aether:task-1:item:thinking:m2");
    // Durable twins: `assistant:m1` / `thinking:m2` rows plus the same tool
    // re-emitted; the only NEW row is the compaction seam.
    const replay = mapper.reconcileDelta(makeDelta(), NOW);
    const types = replay.map((event) => event.type);
    expect(types).not.toContain("user-input.requested");
    expect(eventIds(replay)).not.toContain("aether:task-1:item:m1");
    expect(eventIds(replay)).not.toContain("aether:task-1:item:thinking:m2");
    expect(types).toContain("thread.state.changed");
  });

  it("replays a crash idempotently: identical deterministic eventIds", () => {
    // Two fresh mappers on the same stale cursor (a restart) must emit the
    // SAME ids so t3's eventId-keyed persistence collides instead of duping.
    const first = makeMapper(0).reconcileDelta(makeDelta(), NOW);
    const second = makeMapper(0).reconcileDelta(makeDelta(), NOW);
    expect(eventIds(second)).toEqual(eventIds(first));
    expect(eventIds(first).length).toBeGreaterThan(0);
  });

  it("feeding the same delta twice through one mapper emits nothing new", () => {
    const mapper = makeMapper();
    const first = mapper.reconcileDelta(makeDelta(), NOW);
    expect(first.length).toBeGreaterThan(0);
    expect(mapper.reconcileDelta(makeDelta(), NOW)).toHaveLength(0);
  });

  it("maps the compaction seam row to thread.state.changed compacted", () => {
    const mapper = makeMapper();
    const events = mapper.reconcileDelta(makeDelta(), NOW);
    const seam = events.find((event) => event.type === "thread.state.changed");
    expect(seam).toMatchObject({
      eventId: "aether:task-1:seq:5",
      payload: { state: "compacted" },
    });
  });

  it("completed→message settles the tracked turn with NO state emission", () => {
    const mapper = makeMapper();
    // A processing delta tracks the in-flight turn via activeProcessingTurn.
    mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00Z" },
      }),
      NOW,
    );
    // The settle arrives ONLY via the REST status flip (turn.* is live-only).
    const events = mapper.reconcileDelta(
      makeDelta({ task: taskAwaitingMessage, messages: [] }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(events[0]).toMatchObject({
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
    // READY is the absence of a state emission — never `waiting` here.
    expect(events.some((event) => event.type === "session.state.changed")).toBe(false);
  });

  it("completed→questions settles AND emits the pending input + waiting", () => {
    const mapper = makeMapper();
    mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00Z" },
      }),
      NOW,
    );
    const events = mapper.reconcileDelta(
      makeDelta({ task: taskAwaitingQuestions, messages: [] }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual([
      "turn.completed",
      "user-input.requested",
      "session.state.changed",
    ]);
    // requestId is the REST tool_id — the same value as the WS pendingInputId.
    expect(events[1]).toMatchObject({ requestId: "pi-1" });
    expect(events[2]).toMatchObject({ payload: { state: "waiting" } });
  });

  it("correlates the WS pendingInputId with the REST tool_id as ONE input", () => {
    const mapper = makeMapper();
    const live = mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    expect(live.some((event) => event.type === "user-input.requested")).toBe(true);
    // The durable projection of the SAME pending input must not double it.
    const replay = mapper.reconcileDelta(
      makeDelta({ task: taskAwaitingQuestions, messages: [] }),
      NOW,
    );
    expect(replay.some((event) => event.type === "user-input.requested")).toBe(false);
    expect(replay.some((event) => event.type === "session.state.changed")).toBe(false);
  });

  it("projects the REST plan twin when the live event was missed", () => {
    const mapper = makeMapper();
    const events = mapper.reconcileDelta(makeDelta({ task: taskAwaitingPlan, messages: [] }), NOW);
    expect(events.map((event) => event.type)).toEqual([
      "turn.proposed.completed",
      "session.state.changed",
    ]);
  });

  it("projects an errored task once: failed settle + runtime.error", () => {
    const mapper = makeMapper();
    mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00Z" },
      }),
      NOW,
    );
    const events = mapper.reconcileDelta(makeDelta({ task: taskErrored, messages: [] }), NOW);
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "runtime.error"]);
    expect(events[0]).toMatchObject({
      payload: { state: "failed", errorMessage: "VM provisioning failed" },
    });
    expect(events[1]).toMatchObject({ eventId: "aether:task-1:errored" });
    // Re-observing the errored task must not duplicate the surface.
    expect(mapper.reconcileDelta(makeDelta({ task: taskErrored, messages: [] }), NOW)).toHaveLength(
      0,
    );
  });

  it("suppresses durable tool-row replays of (toolCallId, status) pairs already emitted", () => {
    const mapper = makeMapper();
    // Live first: the rich projection (turnId + display blocks).
    const live = mapper.mapWsEvent(parseFrame(wsCodexFileChange), NOW);
    expect(eventIds(live)).toContain("aether:task-1:tool:call-fc-codex:output-available");
    // The durable twin re-fetched on reconnect shares the deterministic
    // eventId but is a strict data downgrade (no turnId, no blocks) —
    // re-emitting it would overwrite the richer live activity wholesale.
    const replay = mapper.reconcileDelta(makeDelta(), NOW);
    expect(eventIds(replay)).not.toContain("aether:task-1:tool:call-fc-codex:output-available");
  });

  it("attributes REST-only rows to the in-flight turn so its settle owns them", () => {
    const mapper = makeMapper();
    // WS-down degradation: the active turn's rows reach t3 ONLY as durable
    // rows, which carry no turn field of their own.
    const streamed = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00.000Z" },
      }),
      NOW,
    );
    expect(streamed.find((event) => event.eventId === "aether:task-1:item:m1")).toMatchObject({
      type: "item.completed",
      turnId: "aether-turn-u1",
    });
    expect(
      streamed.find(
        (event) => event.eventId === "aether:task-1:tool:call-fc-codex:output-available",
      ),
    ).toMatchObject({ type: "item.completed", turnId: "aether-turn-u1" });
    // The settle arrives only from the REST status flip — it must name the
    // same turn the rows above were attributed to.
    const settle = mapper.reconcileDelta(
      makeDelta({ task: taskAwaitingMessage, messages: [] }),
      NOW,
    );
    expect(settle.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(settle[0]).toMatchObject({ turnId: "aether-turn-u1", payload: { state: "completed" } });
  });

  it("stops attributing at the active turn's opening row: earlier rows stay unowned", () => {
    const mapper = makeMapper();
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u2", startedAt: "2026-08-08T10:10:00.000Z" },
        messages: [
          {
            id: "tail-of-u1",
            role: "assistant",
            variant: "text",
            content: "Done with the first turn.",
            timestamp: "2026-08-08T10:09:00.000Z",
            sequence: 1,
          },
          {
            id: "u2",
            role: "user",
            content: "now fix the lint error",
            deliveryStatus: "delivered",
            timestamp: "2026-08-08T10:10:00.000Z",
            sequence: 2,
          },
          {
            id: "assistant:m9",
            role: "assistant",
            variant: "text",
            content: "Looking at the lint error.",
            timestamp: "2026-08-08T10:10:01.000Z",
            sequence: 3,
          },
        ],
      }),
      NOW,
    );
    expect(events.find((event) => event.eventId === "aether:task-1:item:tail-of-u1")?.turnId).toBe(
      undefined,
    );
    expect(events.find((event) => event.eventId === "aether:task-1:item:m9")).toMatchObject({
      turnId: "aether-turn-u2",
    });
  });

  it("attributes the previous turn's late tail across a warm turn transition", () => {
    const mapper = makeMapper();
    // Warm the mapper: u1 is the tracked in-flight turn.
    mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00.000Z" },
        messages: [
          {
            id: "u1",
            role: "user",
            content: "fix the bug",
            deliveryStatus: "delivered",
            timestamp: "2026-08-08T10:00:00.000Z",
            sequence: 1,
          },
        ],
      }),
      NOW,
    );
    // The transition delta carries u1's late tail, u2's opener, and u2's
    // first output — the reviewer's exact repro. The tail must stay owned by
    // u1 (the mapper is already tracking it), never finalize unowned.
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u2", startedAt: "2026-08-08T10:10:00.000Z" },
        messages: [
          {
            id: "tail-of-u1",
            role: "assistant",
            variant: "text",
            content: "Done with the first turn.",
            timestamp: "2026-08-08T10:09:00.000Z",
            sequence: 5,
          },
          {
            id: "u2",
            role: "user",
            content: "now fix the lint error",
            deliveryStatus: "delivered",
            timestamp: "2026-08-08T10:10:00.000Z",
            sequence: 6,
          },
          {
            id: "assistant:m2",
            role: "assistant",
            variant: "text",
            content: "Looking at the lint error.",
            timestamp: "2026-08-08T10:10:01.000Z",
            sequence: 7,
          },
        ],
      }),
      NOW,
    );
    expect(events.find((event) => event.eventId === "aether:task-1:item:tail-of-u1")).toMatchObject(
      { turnId: "aether-turn-u1" },
    );
    expect(events.find((event) => event.eventId === "aether:task-1:item:m2")).toMatchObject({
      turnId: "aether-turn-u2",
    });
    const settle = events.find(
      (event) => event.type === "turn.completed" && event.turnId === "aether-turn-u1",
    );
    expect(settle).toBeDefined();
    // Ordering: u1's tail is emitted before u1 settles, which happens before
    // u2's first output.
    const tailIndex = events.findIndex(
      (event) => event.eventId === "aether:task-1:item:tail-of-u1",
    );
    const settleIndex = events.findIndex(
      (event) => event.type === "turn.completed" && event.turnId === "aether-turn-u1",
    );
    const nextOutputIndex = events.findIndex((event) => event.eventId === "aether:task-1:item:m2");
    expect(tailIndex).toBeLessThan(settleIndex);
    expect(settleIndex).toBeLessThan(nextOutputIndex);
  });

  it("owns rows and the pending input on a cold resume to an awaiting task", () => {
    // activeProcessingTurn is null once a task parks at awaiting_input, but
    // the delta still carries the opening user row — the opener itself is
    // the turn boundary, so output AND the pending-input request must land
    // owned by aether-turn-u1, never unowned.
    const mapper = makeMapper();
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskAwaitingQuestions,
        activeProcessingTurn: null,
        messages: [
          {
            id: "u1",
            role: "user",
            content: "fix the bug",
            deliveryStatus: "delivered",
            timestamp: "2026-08-08T10:00:00.000Z",
            sequence: 1,
          },
          {
            id: "assistant:a1",
            role: "assistant",
            variant: "text",
            content: "I have a question first.",
            timestamp: "2026-08-08T10:00:05.000Z",
            sequence: 2,
          },
        ],
      }),
      NOW,
    );
    expect(events.find((event) => event.eventId === "aether:task-1:item:a1")).toMatchObject({
      turnId: "aether-turn-u1",
    });
    const request = events.find((event) => event.type === "user-input.requested");
    expect(request).toBeDefined();
    expect(request?.turnId).toBe("aether-turn-u1");
  });

  it("does not treat a queued user row as a turn opener", () => {
    // A steer parks in the timeline with deliveryStatus queued while the
    // current turn still streams — output after it belongs to the OLD turn.
    const mapper = makeMapper();
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00.000Z" },
        messages: [
          {
            id: "u1",
            role: "user",
            content: "fix the bug",
            deliveryStatus: "delivered",
            timestamp: "2026-08-08T10:00:00.000Z",
            sequence: 1,
          },
          {
            id: "u-steer",
            role: "user",
            content: "also update the docs",
            deliveryStatus: "queued",
            timestamp: "2026-08-08T10:00:03.000Z",
            sequence: 2,
          },
          {
            id: "assistant:a1",
            role: "assistant",
            variant: "text",
            content: "Still working on the bug.",
            timestamp: "2026-08-08T10:00:05.000Z",
            sequence: 3,
          },
        ],
      }),
      NOW,
    );
    expect(events.find((event) => event.eventId === "aether:task-1:item:a1")).toMatchObject({
      turnId: "aether-turn-u1",
    });
  });

  it("settles a turn displaced by a NEW active wire turn between observations", () => {
    const mapper = makeMapper();
    // awaiting_input→processing skipped between polls (fast remote respond):
    // the only evidence turn u1 ended is u2 being active now.
    mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        messages: [],
        activeProcessingTurn: { messageId: "u1", startedAt: "2026-08-08T10:00:00Z" },
      }),
      NOW,
    );
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        messages: [],
        activeProcessingTurn: { messageId: "u2", startedAt: "2026-08-08T10:10:00Z" },
      }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "session.state.changed"]);
    expect(events[0]).toMatchObject({
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
    // The settle flipped ingestion to ready; the new turn re-projects running.
    expect(events[1]).toMatchObject({ payload: { state: "running" } });
  });

  it("projects the working indicator: queued→starting, processing→running, once per transition", () => {
    const taskQueued: AetherTask = { ...taskProcessing, status: "queued", run_context: null };
    const mapper = makeMapper();
    const starting = mapper.reconcileTask(taskQueued, NOW);
    expect(starting).toHaveLength(1);
    expect(starting[0]).toMatchObject({
      type: "session.state.changed",
      payload: { state: "starting" },
    });
    // Re-observing the same status emits nothing new.
    expect(mapper.reconcileTask(taskQueued, NOW)).toHaveLength(0);
    const running = mapper.reconcileTask(taskProcessing, NOW);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ payload: { state: "running" } });
    expect(mapper.reconcileTask(taskProcessing, NOW)).toHaveLength(0);
  });

  it("projects the error state on a COLD errored observation (no turn in flight)", () => {
    const mapper = makeMapper();
    const events = mapper.reconcileTask(taskErrored, NOW);
    expect(events.map((event) => event.type)).toEqual(["runtime.error", "session.state.changed"]);
    expect(events[1]).toMatchObject({
      payload: { state: "error", reason: "VM provisioning failed" },
    });
    expect(mapper.reconcileTask(taskErrored, NOW)).toHaveLength(0);
  });

  it("never rewinds the cursor below the initial sequence", () => {
    const mapper = makeMapper(deltaRows.length);
    const events = mapper.reconcileDelta(makeDelta(), NOW);
    // Every row is at or below the cursor: nothing replays.
    expect(events).toHaveLength(0);
    expect(mapper.latestSequence()).toBe(deltaRows.length);
  });
});

describe("AetherEventMapper — live per-dispatch turn ids (turn fragmentation)", () => {
  // Aether stamps a FRESH random `turnId` on every live agent frame
  // (agent-handlers.ts mints `messageId: crypto.randomUUID()` per dispatch),
  // which is NEVER the durable user-row id the rest of the driver keys turns
  // by. A single user turn therefore arrives under two id namespaces; the
  // mapper must attribute every live frame to the ONE durable turn, or the one
  // turn settles multiple times (an empty pre-write checkpoint, then the
  // post-write one) — the demo-blocking turn-fragmentation bug.
  const M1 = "aaaaaaaa-1111-4aaa-8bbb-cccccccccccc";
  const M2 = "bbbbbbbb-2222-4aaa-8bbb-cccccccccccc";
  const M3 = "cccccccc-3333-4aaa-8bbb-cccccccccccc";

  it("attributes live frames under a random per-dispatch turnId to the durable turn", () => {
    const mapper = makeMapper();
    // The durable side grounds turn u1 (sendTurn's noteTurnStarted / adoption).
    mapper.noteTurnStarted("u1", NOW);
    const delta = mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, turnId: M1 }), NOW);
    // No premature settle of u1; the delta is owned by u1, not by M1.
    expect(delta.map((event) => event.type)).toEqual(["content.delta"]);
    expect(delta[0]).toMatchObject({ turnId: "aether-turn-u1" });
    expect(mapper.activeWireTurnId()).toBe("u1");

    // Durable-authoritative settlement: the live turn.completed for a grounded
    // turn does NOT settle — it only attributes ownership.
    const completed = mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M1 }), NOW);
    expect(completed).toHaveLength(0);

    // The single settle comes from the durable reconcile observing the flip.
    const settle = mapper.reconcileTask(taskAwaitingMessage, NOW);
    const settleCompleted = settle.filter((event) => event.type === "turn.completed");
    expect(settleCompleted).toHaveLength(1);
    expect(settleCompleted[0]).toMatchObject({
      type: "turn.completed",
      eventId: "aether:task-1:turn:u1:settled",
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
    // No phantom aether-turn-<random> turn was ever created.
    expect([...delta, ...completed, ...settle].map((event) => event.turnId)).not.toContain(
      `aether-turn-${M1}`,
    );
  });

  it("coalesces multiple distinct live ids within one durable turn to a single settle", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    // A message frame under M1 and a tool frame under a DIFFERENT per-tool id
    // M2 (handler.ts stamps tool events with `event.turnId ?? turnId`).
    mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, turnId: M1 }), NOW);
    const tool = mapper.mapWsEvent(parseFrame({ ...wsCodexFileChange, turnId: M2 }), NOW);
    // The second distinct live id does NOT settle u1 as a "displaced" turn.
    expect(tool.every((event) => event.type !== "turn.completed")).toBe(true);
    expect(tool.find((event) => event.type === "item.completed")).toMatchObject({
      turnId: "aether-turn-u1",
    });
    // No live id settles the grounded turn (durable-authoritative) …
    expect(mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M2 }), NOW)).toHaveLength(0);
    // … the single settle is on u1, from the durable reconcile.
    const completed = mapper
      .reconcileTask(taskAwaitingMessage, NOW)
      .filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
  });

  it("settles a grounded turn from the REST backstop, never the live frame", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    // Live streaming binds the random id to u1, then the live terminal frame
    // lands — but for a grounded turn it emits NO settle.
    mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, turnId: M1 }), NOW);
    const live = mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M1 }), NOW);
    expect(live.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    // The REST backstop observing the turn parked at message-idle emits the
    // single settle — exactly one turn.completed across both transports.
    const rest = mapper.reconcileDelta(makeDelta({ task: taskAwaitingMessage, messages: [] }), NOW);
    expect(rest.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("dedupes a late live settle arriving after the REST backstop settled the same turn", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    // The live frames stream first (binding the random id → u1) …
    mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, turnId: M1 }), NOW);
    // … the REST backstop settles u1 first (awaiting_input flip on a poll) …
    const rest = mapper.reconcileDelta(makeDelta({ task: taskAwaitingMessage, messages: [] }), NOW);
    expect(rest.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    // … then the buffered live turn.completed flushes under its random id: it
    // resolves through the alias to the already-settled u1 and dedupes.
    expect(mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M1 }), NOW)).toHaveLength(0);
  });

  it("dedupes a late live settle whose random id NOTHING bound before the REST settle", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    // The settle-before-bind race: the REST backstop settles u1 while the
    // live stream for this dispatch is still buffered, so NO frame ever bound
    // the random id — and settleTurn cleared activeWireTurnId, so the
    // bind-to-the-turn-in-flight rule no longer applies either.
    const rest = mapper.reconcileDelta(makeDelta({ task: taskAwaitingMessage, messages: [] }), NOW);
    expect(rest.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(mapper.activeWireTurnId()).toBeUndefined();
    // The buffered settle then flushes under an id the mapper has NEVER seen.
    // It must land on the last durable turn — already settled, so the
    // exactly-one-settle-per-wire-turn guard drops it — instead of opening
    // aether-turn-<random> and settling the ONE user turn a second time.
    expect(mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M3 }), NOW)).toHaveLength(0);
    // A late tail frame under the same unseen id is owned by u1 too.
    const tail = mapper.mapWsEvent(
      parseFrame({ ...wsAssistantDelta, turnId: M3, messageId: "m-late" }),
      NOW,
    );
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ type: "content.delta", turnId: "aether-turn-u1" });
  });

  it("drops a late live turn.failed for a settled grounded turn (no phantom, no error card)", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    mapper.reconcileDelta(makeDelta({ task: taskAwaitingMessage, messages: [] }), NOW);
    // Durable-authoritative: a live turn.failed for a grounded turn neither
    // settles a second time NOR fabricates a runtime.error — the durable
    // reconcile owns both. A phantom `aether:task-1:turn:<random>:*` would
    // replay as a distinct activity on every reconnect.
    const late = mapper.mapWsEvent(parseFrame({ ...wsTurnFailed, turnId: M3 }), NOW);
    expect(late).toHaveLength(0);
  });

  it("a stale live settle for turn A cannot settle the newly started turn B (round-2 race)", () => {
    // The bug the durable-authoritative redesign closes: a buffered live
    // turn.completed from a settled turn A, arriving AFTER the user starts
    // turn B, must not bind to and settle B (or open a phantom).
    const mapper = makeMapper();
    // Turn A grounded, streaming under a bound live id, then REST-settled.
    mapper.noteTurnStarted("uA", NOW);
    mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, turnId: M1, messageId: "mA" }), NOW);
    const settleA = mapper
      .reconcileDelta(makeDelta({ task: taskAwaitingMessage, messages: [] }), NOW)
      .filter((event) => event.type === "turn.completed");
    expect(settleA).toHaveLength(1);
    expect(settleA[0]).toMatchObject({ turnId: "aether-turn-uA" });

    // The user starts turn B; that must not re-settle the already-settled A.
    const startB = mapper.noteTurnStarted("uB", NOW);
    expect(startB.some((event) => event.type === "turn.completed")).toBe(false);
    expect(mapper.activeWireTurnId()).toBe("uB");

    // A's stale/buffered live settle now flushes — both the id A's stream bound
    // (M1) and an id nothing ever bound (M2). Neither settles B, neither opens
    // a phantom aether-turn-<random>.
    expect(mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M1 }), NOW)).toHaveLength(0);
    expect(mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M2 }), NOW)).toHaveLength(0);
    expect(mapper.activeWireTurnId()).toBe("uB");

    // B settles exactly once, from its own durable observation.
    const settleB = mapper
      .reconcileTask(taskAwaitingMessage, NOW)
      .filter((event) => event.type === "turn.completed");
    expect(settleB).toHaveLength(1);
    expect(settleB[0]).toMatchObject({
      turnId: "aether-turn-uB",
      payload: { state: "completed" },
    });
  });

  it("keeps a raw live id as its own turn when NOTHING durable was ever grounded", () => {
    const mapper = makeMapper();
    // The cold mapper-only path (unit tests / a degenerate resume): with no
    // durable turn to attribute to, the live id is the only turn identity
    // there is — the settle must still land under it.
    const settled = mapper.mapWsEvent(parseFrame({ ...wsTurnCompleted, turnId: M3 }), NOW);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      type: "turn.completed",
      turnId: `aether-turn-${M3}`,
    });
  });

  it("classifies a live id as own only while a durable turn grounds it, binding nothing", () => {
    // The adapter asks this BEFORE mapping a frame, to tell its own output
    // from a turn injected from the Aether app (build item 13) — the raw live
    // id can never be compared against durable ids directly.
    const mapper = makeMapper();
    // Cold: no durable turn, so a live id is evidence of nothing.
    expect(mapper.isOwnLiveTurnId(M1)).toBe(false);
    mapper.noteTurnStarted("u1", NOW);
    // A durable turn in flight owns EVERY live id arriving while it runs.
    expect(mapper.isOwnLiveTurnId(M1)).toBe(true);
    expect(mapper.isOwnLiveTurnId(M2)).toBe(true);
    // Only M1 actually carries a frame; M2 stays a bare query.
    mapper.mapWsEvent(parseFrame({ ...wsAssistantDelta, turnId: M1, messageId: "m5" }), NOW);
    mapper.reconcileDelta(makeDelta({ task: taskAwaitingMessage, messages: [] }), NOW);
    expect(mapper.activeWireTurnId()).toBeUndefined();
    // The id the live stream bound stays own …
    expect(mapper.isOwnLiveTurnId(M1)).toBe(true);
    // … the merely-queried one does not: the query memoized nothing, so a
    // first live frame between turns stays free to be read as a remote
    // injection and reconciled BEFORE it is mapped.
    expect(mapper.isOwnLiveTurnId(M2)).toBe(false);
  });
});

describe("parseAetherQuestions", () => {
  it("reports malformed questions as issues instead of dropping silently", () => {
    const { questions, issues } = parseAetherQuestions({
      questions: [
        { question: "Valid?", options: [{ label: "Yes" }] },
        { options: [{ label: "orphan option" }] },
        "not-an-object",
      ],
    });
    expect(questions).toHaveLength(1);
    expect(issues).toHaveLength(2);
  });

  it("fails loudly (empty + issue) when there is no questions array", () => {
    const { questions, issues } = parseAetherQuestions({ foo: 1 });
    expect(questions).toHaveLength(0);
    expect(issues).toEqual(["ask_user input carries no questions array"]);
  });
});

describe("AetherEventMapper — interrupted turns (T6)", () => {
  it("settles an interrupt-flagged turn as interrupted through the durable path", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    expect(mapper.activeWireTurnId()).toBe("u1");
    mapper.markInterrupted("u1");
    // Durable-authoritative: the live turn.completed for the grounded turn does
    // not settle …
    expect(mapper.mapWsEvent(parseFrame(wsTurnCompleted), NOW)).toHaveLength(0);
    // … the durable reconcile emits the single settle, and the interrupt flag
    // makes it read `interrupted` whichever transport observes the flip.
    const events = mapper.reconcileTask(taskAwaitingMessage, NOW);
    const completed = events.filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "turn.completed",
      turnId: "aether-turn-u1",
      payload: { state: "interrupted" },
    });
    expect(mapper.activeWireTurnId()).toBeUndefined();
  });

  it("suppresses the error card when a live turn.failed lands after a user stop", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    mapper.markInterrupted("u1");
    // A stop often surfaces remotely as a failed turn. For a grounded turn the
    // live frame neither settles nor fabricates a runtime.error.
    expect(mapper.mapWsEvent(parseFrame(wsTurnFailed), NOW)).toHaveLength(0);
    // The durable reconcile emits the single interrupted settle, no error card.
    const events = mapper.reconcileTask(taskAwaitingMessage, NOW);
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    const completed = events.filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ payload: { state: "interrupted" } });
  });

  it("noteTurnStarted settles a displaced predecessor exactly like an observed transition", () => {
    const mapper = makeMapper();
    mapper.noteTurnStarted("u1", NOW);
    const events = mapper.noteTurnStarted("u2", NOW);
    expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(events[0]).toMatchObject({
      turnId: "aether-turn-u1",
      payload: { state: "completed" },
    });
    expect(mapper.activeWireTurnId()).toBe("u2");
  });
});

describe("AetherEventMapper — open pending input (T7/T8)", () => {
  it("exposes the open ask_user input with raw answer indices", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    expect(mapper.openUserInput()).toEqual({
      pendingId: "pi-1",
      toolName: "ask_user",
      wireTurnId: "u1",
      questions: [
        {
          id: "q1",
          rawIndex: 0,
          multiSelect: false,
          options: [
            { label: "Patch the reducer", rawIndex: 0 },
            { label: "Rewrite the module", rawIndex: 1 },
          ],
        },
      ],
    });
  });

  it("preserves RAW wire indices when malformed questions/options are skipped", () => {
    // Question 0 and option 0 are malformed and skipped from the rendered
    // questions — the answer keys must still address the wire positions.
    const parsed = parseAetherQuestions({
      questions: [
        "not-an-object",
        {
          question: "Which db?",
          options: [{ description: "no label" }, { label: "sqlite" }],
        },
      ],
    });
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.answerable).toEqual([
      {
        id: "Which db?",
        rawIndex: 1,
        multiSelect: false,
        options: [{ label: "sqlite", rawIndex: 1 }],
      },
    ]);
  });

  it("dedupes synthesized question ids so answers stay addressable", () => {
    const parsed = parseAetherQuestions({
      questions: [{ question: "Proceed?" }, { question: "Proceed?" }],
    });
    expect(parsed.questions.map((question) => question.id)).toEqual(["Proceed?", "Proceed?#2"]);
    expect(parsed.answerable.map((question) => question.rawIndex)).toEqual([0, 1]);
  });

  it("noteInputResolved emits user-input.resolved once and closes the slot", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    const answers = { q1: ["Rewrite the module"] };
    const events = mapper.noteInputResolved("pi-1", answers, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "user-input.resolved",
      eventId: "aether:task-1:input:pi-1:resolved",
      requestId: "pi-1",
      turnId: "aether-turn-u1",
      payload: { answers },
    });
    expect(mapper.openUserInput()).toBeUndefined();
    // Already resolved: nothing more, whatever id arrives.
    expect(mapper.noteInputResolved("pi-1", answers, NOW)).toEqual([]);
  });

  it("resolves an open question out of band when a different turn starts (live)", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    // The answer was submitted from the Aether app: the resumed turn's first
    // live event proves it — the panel must clear before the new output.
    const events = mapper.mapWsEvent(
      parseFrame({ ...wsAssistantDelta, turnId: "u2", messageId: "m9" }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual(["user-input.resolved", "content.delta"]);
    expect(events[0]).toMatchObject({ requestId: "pi-1", payload: { answers: {} } });
    expect(mapper.openUserInput()).toBeUndefined();
  });

  it("does NOT resolve an open question on a bare processing beat (awaiting_input commit race)", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    // The workspace emits the live question BEFORE the API commits the task
    // row to awaiting_input, so a reconcile in that window reads a stale
    // `processing` with NO new rows and no activeProcessingTurn flip.
    // Resolving on that would permanently suppress the question
    // (requestedInputs never re-surfaces the same tool_id) and wedge the
    // thread — the bare status is not evidence of an out-of-band answer.
    const events = mapper.reconcileDelta(makeDelta({ task: taskProcessing, messages: [] }), NOW);
    expect(events).toEqual([]);
    expect(mapper.openUserInput()).toMatchObject({ pendingId: "pi-1" });
    // Same for a stale `queued` beat.
    const queued = mapper.reconcileTask(
      { ...taskProcessing, status: "queued", run_context: null },
      NOW,
    );
    expect(queued).toEqual([]);
    expect(mapper.openUserInput()).toMatchObject({ pendingId: "pi-1" });
  });

  it("resolves an open question when the delta names a DIFFERENT processing turn", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    // Genuine out-of-band answer: the resumed turn IS the evidence — the
    // delta's activeProcessingTurn names a wire turn other than the asker.
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        messages: [],
        activeProcessingTurn: { messageId: "m9", startedAt: NOW },
      }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual([
      "user-input.resolved",
      "session.state.changed",
    ]);
    expect(events[0]).toMatchObject({ requestId: "pi-1", payload: { answers: {} } });
    expect(events[1]).toMatchObject({ payload: { state: "running" } });
    expect(mapper.openUserInput()).toBeUndefined();
  });

  it("resolves an open question when the delta carries the answering user row", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    // The remotely submitted answer arrives as a delivered user row — a turn
    // opener for a different wire turn, which resolves the parked input.
    const events = mapper.reconcileDelta(
      makeDelta({
        task: taskProcessing,
        messages: [
          {
            id: "m9",
            role: "user",
            content: '{"answers":{"0":[0]}}',
            deliveryStatus: "processing",
            timestamp: NOW,
            sequence: 10,
          },
        ],
      }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual([
      "user-input.resolved",
      "session.state.changed",
    ]);
    expect(events[0]).toMatchObject({ requestId: "pi-1" });
    expect(mapper.openUserInput()).toBeUndefined();
  });

  it("out-of-band resolution into message-idle emits the corrective READY", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    // The whole answer turn happened while detached: the next observation is
    // already the idle state, so nothing else corrects the projected
    // `waiting` — the explicit ready emission must.
    const events = mapper.reconcileDelta(
      makeDelta({ task: taskAwaitingMessage, messages: [] }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual([
      "user-input.resolved",
      "session.state.changed",
    ]);
    expect(events[1]).toMatchObject({ payload: { state: "ready" } });
  });

  it("a NEW pending input supersedes and resolves the previous one", () => {
    const mapper = makeMapper();
    mapper.mapWsEvent(parseFrame(wsAwaitingInputQuestions), NOW);
    // Aether holds one pending slot per task: a second callback overwrites
    // it wholesale, so the first input resolves before the new card.
    const events = mapper.mapWsEvent(
      parseFrame({
        ...wsAwaitingInputPlan,
        turnId: "u2",
        pendingInputId: "pi-9",
      }),
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual([
      "user-input.resolved",
      // The new asking turn's own settle (awaiting_input IS a settle).
      "turn.completed",
      "turn.proposed.completed",
      "session.state.changed",
    ]);
    expect(events[0]).toMatchObject({ requestId: "pi-1" });
    expect(mapper.openUserInput()).toMatchObject({ pendingId: "pi-9", toolName: "propose_plan" });
  });
});
