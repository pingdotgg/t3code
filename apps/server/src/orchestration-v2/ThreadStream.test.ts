import {
  EventId,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";

import {
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES,
  THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./ThreadStream.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

const NOW = DateTime.makeUnsafe("2026-09-08T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-stream-test");
const LARGE_PROJECTABLE_OUTPUT_BYTES = 10 * 1_048_576;
const LARGE_PROJECTABLE_RAW_PAYLOAD_BYTES = 10_486_214;
// The first projected replay measured 821 bytes; leave room for small envelope additions.
const MAX_PROJECTED_DYNAMIC_REPLAY_BYTES = 2_048;

function timelineProjection(itemCount: number): OrchestrationV2ThreadProjection {
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = Array.from(
    { length: itemCount },
    (_, index) => {
      const id = TurnItemId.make(`item-${index}`);
      const item = {
        id,
        type: "command_execution",
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed",
        title: `Command ${index}`,
        input: `command-${index}`,
        output: `output-${index}`,
        exitCode: 0,
        startedAt: NOW,
        completedAt: NOW,
        updatedAt: NOW,
      } satisfies OrchestrationV2TurnItem;
      return {
        position: index,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        sourceItemId: id,
        item,
      };
    },
  );
  return {
    thread: {
      id: THREAD_ID,
      projectId: "project-stream-test",
      title: "Thread stream test",
      providerInstanceId: "codex",
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD_ID,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("decideThreadResume", () => {
  it("replays when the gap is zero", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 10,
        replayEventCount: 0,
        replayEncodedBytes: 0,
      }),
    ).toEqual({ mode: "replay", afterSequence: 10, throughSequence: 10 });
  });

  it("replays when the event count is within the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 20_000,
        replayEventCount: THREAD_RESUME_MAX_REPLAY_EVENTS,
        replayEncodedBytes: THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
      }),
    ).toEqual({
      mode: "replay",
      afterSequence: 10,
      throughSequence: 20_000,
    });
  });

  it("falls back to a snapshot when the event count exceeds the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 20_000,
        replayEventCount: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
        replayEncodedBytes: 1,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("falls back to a snapshot when encoded replay bytes exceed the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 11,
        replayEventCount: 1,
        replayEncodedBytes: THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES + 1,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("rejects pathological raw payloads before decoding them", () => {
    expect(isThreadReplayRawPayloadSafe(THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES)).toBe(true);
    expect(isThreadReplayRawPayloadSafe(THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES + 1)).toBe(false);

    // Raw safety and projected transport size are deliberately separate. A
    // tiny projected replay is transport-safe even when its raw source is not.
    expect(
      decideThreadResume({
        afterSequence: 9,
        highWater: 10,
        replayEventCount: 1,
        replayEncodedBytes: 1,
      }),
    ).toEqual({ mode: "replay", afterSequence: 9, throughSequence: 10 });
  });

  it("falls back to a snapshot when the client cursor is ahead of the store", () => {
    expect(
      decideThreadResume({
        afterSequence: 50,
        highWater: 40,
        replayEventCount: 0,
        replayEncodedBytes: 0,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("counts UTF-8 bytes across projected stream items", () => {
    expect(threadReplayEncodedBytes([{ value: "a" }, { value: "🦊" }])).toBe(
      Buffer.byteLength('{"value":"a"}', "utf8") + Buffer.byteLength('{"value":"🦊"}', "utf8"),
    );
  });

  it("builds socket fallback snapshots with a bounded timeline and history cursor", () => {
    const snapshot = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 44,
      projection: timelineProjection(80),
    });

    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.snapshotSequence).toBe(44);
    expect(snapshot.projection.visibleTurnItems).toHaveLength(75);
    expect(snapshot.projection.turnItems).toHaveLength(75);
    expect(snapshot.historyCursor).not.toBeNull();
    expect(snapshot.hasMoreHistory).toBe(true);
    expect(snapshot.latestLocalTurnOrdinal).toBe(80);
    expect(snapshot.payloadBudgetExceeded).toBe(false);
  });

  it("rejects a 10 MiB raw replay even when its projected form fits the wire budget", () => {
    const item = {
      id: TurnItemId.make("large-dynamic-tool"),
      type: "dynamic_tool",
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Large result",
      toolName: "mcp__test__large_result",
      input: { query: "small" },
      output: { text: "x".repeat(LARGE_PROJECTABLE_OUTPUT_BYTES) },
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    } satisfies OrchestrationV2TurnItem;
    const event = {
      id: EventId.make("large-dynamic-tool-event"),
      type: "turn-item.updated" as const,
      threadId: THREAD_ID,
      occurredAt: NOW,
      payload: item,
    };
    const rawReplay = [{ kind: "event" as const, sequence: 10, event }];
    const projectedReplay = [
      {
        kind: "event" as const,
        sequence: 10,
        event: projectDomainEventForWire(event),
      },
    ];

    const rawPayloadBytes = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
    expect(rawPayloadBytes).toBe(LARGE_PROJECTABLE_RAW_PAYLOAD_BYTES);
    expect(rawPayloadBytes).toBeGreaterThan(THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES);
    expect(isThreadReplayRawPayloadSafe(rawPayloadBytes)).toBe(false);
    expect(threadReplayEncodedBytes(rawReplay)).toBeGreaterThan(
      THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
    );
    const projectedBytes = threadReplayEncodedBytes(projectedReplay);
    expect(projectedBytes).toBeLessThanOrEqual(MAX_PROJECTED_DYNAMIC_REPLAY_BYTES);
    expect(
      decideThreadResume({
        afterSequence: 9,
        highWater: 10,
        replayEventCount: projectedReplay.length,
        replayEncodedBytes: projectedBytes,
      }),
    ).toEqual({ mode: "replay", afterSequence: 9, throughSequence: 10 });
  });
});

describe("compact bounded snapshots", () => {
  const FORK_PARENT = ThreadId.make("thread-stream-parent");
  const decodeStreamItem = Schema.decodeUnknownSync(
    Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
  );
  const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

  /** Fork child: inherited parent rows and marker, then local rows, plus an older interrupt request. */
  function forkProjection(): OrchestrationV2ThreadProjection {
    const base = timelineProjection(6);
    const local = base.visibleTurnItems.slice(3).map((row, index) => ({ ...row, position: index }));
    const inherited = base.visibleTurnItems.slice(0, 3).map((row, index) => {
      const item = { ...row.item, id: TurnItemId.make(`parent-${index}`), threadId: FORK_PARENT };
      return {
        position: index,
        visibility: "inherited" as const,
        sourceThreadId: FORK_PARENT,
        sourceItemId: item.id,
        item,
      };
    });
    const request = {
      ...base.turnItems[0]!,
      id: TurnItemId.make("interrupt-request"),
      type: "run_interrupt_request",
      ordinal: 0,
      message: "Stop",
    } as unknown as OrchestrationV2TurnItem;
    return {
      ...base,
      turnItems: [request, ...local.map((row) => row.item)],
      visibleTurnItems: [...inherited, ...local].map((row, position) => ({ ...row, position })),
    };
  }

  it.each([
    ["linear", () => timelineProjection(80)],
    ["fork with retained interrupt request", forkProjection],
  ])("restores the exact opted-out snapshot for %s threads", (_, makeProjection) => {
    const base = makeProjection();
    // The shared fixture omits a model; the wire codec requires one.
    const projection = {
      ...base,
      thread: { ...base.thread, modelSelection: { instanceId: "codex", model: "gpt-5" } },
    } as OrchestrationV2ThreadProjection;
    const full = buildBoundedThreadStreamSnapshot({ snapshotSequence: 44, projection });
    const compact = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 44,
      projection,
      compactTurnItems: true,
    });

    // Opted-out clients get exactly the previous representation.
    expect("turnItemsOmitLocalVisible" in full).toBe(false);
    expect(compact.turnItemsOmitLocalVisible).toBe(true);
    expect(compact.projection.turnItems.length).toBeLessThan(full.projection.turnItems.length);
    const { turnItemsOmitLocalVisible: _marker, ...compactFields } = compact;
    expect({ ...compactFields, projection: full.projection }).toEqual(full);

    // Decode the wire form like a client, then restore before use.
    const decodedFull = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(full))));
    const decodedCompact = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(compact))));
    if (decodedFull.kind !== "snapshot" || decodedCompact.kind !== "snapshot") {
      throw new Error("Expected snapshots");
    }
    expect(boundedSnapshotProjection(decodedCompact)).toEqual(decodedFull.projection);
  });

  it("keeps the retained interrupt request outside the visible window", () => {
    const compact = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 1,
      projection: forkProjection(),
      compactTurnItems: true,
    });
    expect(compact.projection.turnItems.map((item) => item.id)).toEqual(["interrupt-request"]);
    expect(boundedSnapshotProjection(compact).turnItems.map((item) => String(item.id))).toEqual([
      "item-3",
      "item-4",
      "item-5",
      "interrupt-request",
    ]);
  });

  it("omits the marker when the window has no local rows", () => {
    const fork = forkProjection();
    const inheritedOnly = {
      ...fork,
      turnItems: fork.turnItems.slice(0, 1),
      visibleTurnItems: fork.visibleTurnItems.slice(0, 3),
    };
    const compact = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 1,
      projection: inheritedOnly,
      compactTurnItems: true,
    });
    expect("turnItemsOmitLocalVisible" in compact).toBe(false);
    expect(compact.projection.turnItems.map((item) => item.id)).toEqual(["interrupt-request"]);
  });
});
