import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, type ThreadFeedActivity } from "../../mobile/src/lib/threadActivity.ts";
import { deriveLatestContextWindowSnapshot } from "../../web/src/lib/contextWindow.ts";
import { deriveWorkLogEntries } from "../../web/src/session-logic.ts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "../src/orchestration/ActivityPayloadProjection.ts";

function makeActivity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      title: itemType,
      detail: `${itemType} detail`,
      status: "completed",
      requestKind: "command",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

function makeThread(activities: ReadonlyArray<OrchestrationThreadActivity>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-projection"),
    projectId: ProjectId.make("project-projection"),
    title: "Activity projection",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
}

const fixtures = [
  makeActivity("command", "command_execution", {
    item: {
      command: ["bash", "-lc", "pnpm test"],
      input: { command: "fallback input", ignored: "input bulk" },
      result: { command: "fallback result", aggregatedOutput: "x".repeat(10_000) },
      commandActions: [{ type: "unknown", output: "y".repeat(5_000) }],
    },
    command: "fallback data",
    kind: "execute",
    toolCallId: "tool-command",
    rawOutput: {
      content: "\n```\nfirst useful line\nsecond line",
      stdout: "unused stdout",
      ignored: "raw bulk",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("file-change", "file_change", {
    item: {
      changes: [
        { oldPath: "src/old.ts", newPath: "src/new.ts", patch: "large patch".repeat(1_000) },
        { filePath: "src/second.ts" },
      ],
    },
    ignored: "top-level bulk",
  }),
  makeActivity("dynamic", "dynamic_tool_call", {
    toolCallId: "tool-dynamic",
    rawOutput: {
      stdout: "dynamic summary\nlong output".repeat(1_000),
    },
    ignored: "top-level bulk",
  }),
  makeActivity("collab", "collab_agent_tool_call", {
    kind: "delegate",
    rawOutput: {
      content: "``` \n```",
      stdout: "must not be used when content is present",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("mcp", "mcp_tool_call", {
    item: {
      server: "repository",
      tool: "search",
      arguments: { query: "activity projection" },
      aggregatedOutput: "mcp bulk is dropped",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("search", "web_search", {
    rawOutput: {
      totalFiles: 42,
      truncated: true,
      content: "ignored because totalFiles wins",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("image", "image_view", {
    ignored: "top-level bulk",
  }),
] satisfies ReadonlyArray<OrchestrationThreadActivity>;

describe("projectActivityPayload", () => {
  function comparableActivity(activity: ThreadFeedActivity) {
    return {
      ...activity,
      fullDetail: activity.getFullDetail(),
      copyText: activity.getCopyText(),
      getFullDetail: undefined,
      getCopyText: undefined,
    };
  }

  function comparableThreadFeed(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return buildThreadFeed(makeThread(activities)).map((entry) =>
      entry.type === "activity-group"
        ? {
            ...entry,
            activities: entry.activities.map(comparableActivity),
          }
        : entry,
    );
  }

  it("drops unread bulk while retaining command, file, tool, and summary inputs", () => {
    const projected = projectActivityPayload(fixtures[0]!);
    expect(projected.payload).toEqual({
      itemType: "command_execution",
      title: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result" },
        },
        command: "fallback data",
        toolCallId: "tool-command",
        kind: "execute",
        rawOutput: { content: "first useful line" },
      },
    });

    expect(projectActivityPayload(fixtures[1]!).payload).toMatchObject({
      data: {
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }, { path: "src/second.ts" }],
      },
    });
  });

  it("projects a Claude Bash result for the web and mobile expanded rows", () => {
    const command = `printf 'first line\nsecond line'\n&& printf done`;
    const source: OrchestrationThreadActivity = {
      ...makeActivity("claude-bash", "command_execution", {}),
      summary: "Command run",
      payload: {
        itemType: "command_execution",
        title: "Command run",
        detail: `Bash: ${command}`,
        status: "completed",
        data: {
          toolName: "Bash",
          input: { command },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "first output line" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      },
    };
    const projected = projectActivityPayload(source);

    expect(projected.payload).toMatchObject({
      data: {
        toolName: "Bash",
        command,
        rawOutput: { content: "first output line" },
      },
    });

    const [webEntry] = deriveWorkLogEntries([projected]);
    expect(webEntry).toMatchObject({ command, detail: "first output line" });

    const [mobileGroup] = buildThreadFeed(makeThread([projected]));
    expect(mobileGroup?.type).toBe("activity-group");
    if (mobileGroup?.type !== "activity-group") return;
    const [mobileRow] = mobileGroup.activities;
    expect(mobileRow).toMatchObject({ detail: command, canExpand: true });
    expect(mobileRow?.getFullDetail()).toBe(`${command}\n\nfirst output line`);
    expect(mobileRow?.getCopyText()).toBe(`Command run\n${command}\n\nfirst output line`);
  });

  it("slims MCP tool data to the fields the expanded row renders", () => {
    expect(projectActivityPayload(fixtures[4]!).payload).toEqual({
      itemType: "mcp_tool_call",
      title: "mcp_tool_call",
      detail: "mcp_tool_call detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          server: "repository",
          tool: "search",
          arguments: { query: "activity projection" },
        },
      },
    });
  });

  it("keeps current web and mobile derived fields for every tool item type", () => {
    for (const activity of fixtures) {
      const projected = projectActivityPayload(activity);
      if (activity === fixtures[0]) {
        expect(deriveWorkLogEntries([projected])).toMatchObject([
          {
            command: "pnpm test",
            rawCommand: 'bash -lc "pnpm test"',
            detail: "first useful line",
          },
        ]);
        expect(comparableThreadFeed([projected])).toMatchObject([
          {
            type: "activity-group",
            activities: [
              {
                detail: "pnpm test",
                fullDetail: 'bash -lc "pnpm test"\n\nfirst useful line',
              },
            ],
          },
        ]);
        continue;
      }
      if (activity === fixtures[4]) {
        // MCP is the one deliberate difference: the expanded row's toolData
        // loses result bulk but keeps the rendered identity fields.
        const [entry] = deriveWorkLogEntries([projected]);
        expect(entry?.toolData).toEqual({
          server: "repository",
          tool: "search",
          arguments: { query: "activity projection" },
        });
        continue;
      }
      expect(deriveWorkLogEntries([projected])).toEqual(deriveWorkLogEntries([activity]));
      expect(comparableThreadFeed([projected])).toEqual(comparableThreadFeed([activity]));
    }
  });

  it("preserves failed stored tool outcomes for web and mobile clients", () => {
    const activities = [
      makeActivity("failed-command", "command_execution", {
        item: {
          command: "vp test run",
          exitCode: 1,
          status: "failed",
        },
      }),
      makeActivity("failed-mcp", "mcp_tool_call", {
        item: {
          server: "simulator",
          tool: "build",
          arguments: {},
          status: "failed",
        },
      }),
    ];

    for (const activity of activities) {
      const projected = projectActivityPayload(activity);
      expect(projected.payload).toMatchObject({ status: "failed" });

      const [webEntry] = deriveWorkLogEntries([projected]);
      expect(webEntry?.toolLifecycleStatus).toBe("failed");

      const [mobileGroup] = buildThreadFeed(makeThread([projected]));
      expect(mobileGroup).toMatchObject({ type: "activity-group" });
      if (mobileGroup?.type === "activity-group") {
        expect(mobileGroup.activities[0]?.status).toBe("failure");
      }
    }
  });

  it("projects snapshot and event transports without mutating their sources", () => {
    const activity = fixtures[0]!;
    const thread = makeThread([activity]);
    const snapshot = { snapshotSequence: 7, thread };
    const projectedSnapshot = projectThreadDetailSnapshot(snapshot);

    expect(projectedSnapshot.thread.activities[0]).not.toBe(activity);
    expect(snapshot.thread.activities[0]).toBe(activity);

    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: "2026-07-27T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projectedEvent = projectActivityEvent(event);
    expect(projectedEvent).not.toBe(event);
    expect(
      projectedEvent.type === "thread.activity-appended"
        ? projectedEvent.payload.activity
        : undefined,
    ).toEqual(projectActivityPayload(activity));
    expect(event.payload.activity).toBe(activity);
  });
});

describe("superseded tool.updated snapshot dedup", () => {
  function makeToolLifecycleActivity(
    id: string,
    kind: "tool.updated" | "tool.completed",
    options: {
      readonly turn?: string;
      readonly title?: string;
      readonly detail?: string;
      readonly toolCallId?: string;
    } = {},
  ): OrchestrationThreadActivity {
    const { turn = "turn-a", title = "File change", detail, toolCallId } = options;
    return {
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: title,
      payload: {
        itemType: "file_change",
        title,
        ...(detail ? { detail } : {}),
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          toolName: "Edit",
          input: { file_path: "src/app.ts" },
        },
      },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  function projectedIds(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    }).thread.activities.map((activity) => activity.id);
  }

  it("drops updates a later completion supersedes in the same turn", () => {
    const update1 = makeToolLifecycleActivity("upd-1", "tool.updated");
    const update2 = makeToolLifecycleActivity("upd-2", "tool.updated");
    const completed = makeToolLifecycleActivity("done-1", "tool.completed");

    expect(projectedIds([update1, update2, completed])).toEqual([completed.id]);
  });

  it("matches on toolCallId when the adapter emits one", () => {
    const otherCall = makeToolLifecycleActivity("upd-other", "tool.updated", {
      toolCallId: "call-b",
    });
    const update = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const completed = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });

    // Same itemType/title, different call: only call-a's update is superseded.
    expect(projectedIds([otherCall, update, completed])).toEqual([otherCall.id, completed.id]);
  });

  it("keeps updates with no matching completion", () => {
    const inFlight = makeToolLifecycleActivity("upd-live", "tool.updated", { title: "Running" });
    const other = makeToolLifecycleActivity("upd-other", "tool.updated", { title: "Reading" });
    const completed = makeToolLifecycleActivity("done-other", "tool.completed", {
      title: "Reading",
    });

    expect(projectedIds([inFlight, other, completed])).toEqual([inFlight.id, completed.id]);
  });

  it("drops interleaved superseded updates even when a parallel call separates them", () => {
    // Deliberate divergence from the clients' adjacency-based collapse: a
    // superseded update separated from its completion by an interleaved
    // parallel call renders as its own in-flight row on full history, and the
    // snapshot omits it. Its final state still shows via the retained
    // completion (1.5% of dropped rows on real data; see the projection's doc
    // comment).
    const updateA = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const updateB = makeToolLifecycleActivity("upd-b", "tool.updated", { toolCallId: "call-b" });
    const completedA = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });
    const completedB = makeToolLifecycleActivity("done-b", "tool.completed", {
      toolCallId: "call-b",
    });

    expect(projectedIds([updateA, updateB, completedA, completedB])).toEqual([
      completedA.id,
      completedB.id,
    ]);
  });

  it("keeps an update whose completion lives in another turn", () => {
    // A live thread.reverted can discard the completing turn while keeping
    // the updating one, which would leave the call unrepresented.
    const update = makeToolLifecycleActivity("upd-kept", "tool.updated", { turn: "turn-kept" });
    const completed = makeToolLifecycleActivity("done-later", "tool.completed", {
      turn: "turn-reverted",
    });

    expect(projectedIds([update, completed])).toEqual([update.id, completed.id]);
  });

  it("keeps an update that follows its completion", () => {
    // A later update under the same identity is the next call, still in flight.
    const completed = makeToolLifecycleActivity("done-first", "tool.completed");
    const nextCall = makeToolLifecycleActivity("upd-next", "tool.updated");

    expect(projectedIds([completed, nextCall])).toEqual([completed.id, nextCall.id]);
  });

  it("keeps identity-less rows the clients never collapse", () => {
    const anonymous: OrchestrationThreadActivity = {
      id: EventId.make("upd-anon"),
      tone: "tool",
      kind: "tool.updated",
      summary: " ",
      payload: { data: { toolName: "Edit" } },
      turnId: TurnId.make("turn-a"),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    const completed: OrchestrationThreadActivity = {
      ...anonymous,
      id: EventId.make("done-anon"),
      kind: "tool.completed",
    };

    expect(projectedIds([anonymous, completed])).toEqual([anonymous.id, completed.id]);
  });

  it("leaves the collapsed work log identical to the full history", () => {
    const activities = [
      makeToolLifecycleActivity("upd-1", "tool.updated", { detail: "writing" }),
      makeToolLifecycleActivity("upd-2", "tool.updated", { detail: "writing" }),
      makeToolLifecycleActivity("done-1", "tool.completed", { detail: "writing" }),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    const before = deriveWorkLogEntries(activities);
    const after = deriveWorkLogEntries(projected.thread.activities);
    expect(after).toHaveLength(before.length);
    expect(after.map((entry) => entry.label)).toEqual(before.map((entry) => entry.label));
  });
});

describe("context-window snapshot dedup", () => {
  function makeContextWindowActivity(
    id: string,
    usedTokens: number,
    turn = `turn-${id}`,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 200_000 },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  it("keeps only the latest context-window activity per turn in snapshots", () => {
    const stale1 = makeContextWindowActivity("ctx-1", 1_000, "turn-a");
    const latestA = makeContextWindowActivity("ctx-2", 2_000, "turn-a");
    const latestB = makeContextWindowActivity("ctx-3", 3_000, "turn-b");
    const tool = fixtures[0]!;

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([stale1, tool, latestA, latestB]),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      tool.id,
      latestA.id,
      latestB.id,
    ]);
    // The retained rows keep their payloads untouched — the tool-data
    // projection only rewrites payloads with a `data` record.
    expect(projected.thread.activities[2]?.payload).toEqual(latestB.payload);
  });

  it("still resolves a meter value after the client reverts the newest turn", () => {
    // A live thread.reverted makes the client drop all activities from
    // discarded turns; each surviving turn must keep a usable row.
    const olderTurn = makeContextWindowActivity("ctx-old", 1_500, "turn-kept");
    const revertedTurn = makeContextWindowActivity("ctx-new", 9_000, "turn-reverted");

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([olderTurn, revertedTurn]),
    });
    const afterRevert = projected.thread.activities.filter(
      (activity) => activity.turnId === TurnId.make("turn-kept"),
    );

    expect(deriveLatestContextWindowSnapshot(afterRevert)).toEqual(
      deriveLatestContextWindowSnapshot([olderTurn]),
    );
  });

  it("matches what the web client derives from the full history", () => {
    const activities = [
      makeContextWindowActivity("ctx-1", 1_000),
      makeContextWindowActivity("ctx-2", 2_000),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot(activities),
    );
  });

  it("does not let a malformed row shadow an earlier valid row in the same turn", () => {
    const valid = makeContextWindowActivity("ctx-valid", 5_000, "turn-a");
    const malformed: OrchestrationThreadActivity = {
      ...makeContextWindowActivity("ctx-broken", 0, "turn-a"),
      payload: { usedTokens: null },
    };

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([valid, malformed]),
    });

    // The malformed row passes through, the valid row survives, and the
    // client's backward walk resolves the same value as with full history.
    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      valid.id,
      malformed.id,
    ]);
    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot([valid, malformed]),
    );
  });

  it("applies only payload slimming when there are no context-window activities", () => {
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([fixtures[4]!]),
    });
    expect(projected.thread.activities).toEqual([projectActivityPayload(fixtures[4]!)]);
  });
});
