import { PiNativeRuntimeId, PiNativeSessionKey, ProjectId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { PiSessionCatalogRecord } from "./SessionCatalog.ts";
import {
  projectPiActiveBranch,
  projectPiBacking,
  projectPiLiveEvent,
  projectPiThread,
  projectPiThreadOverlay,
} from "./PiSessionProjection.ts";

const record: PiSessionCatalogRecord = {
  sourceKey: PiNativeSessionKey.make("opaque-source"),
  threadId: ThreadId.make("external:pi:session-1"),
  canonicalFile: "/private/session.jsonl",
  sessionId: "session-1",
  cwd: "/workspace",
  title: "native session",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:01:00.000Z",
  fileSize: 1,
  fileMtimeMs: 1,
  historyTruncation: {
    truncated: false,
    omittedEntryCount: 0,
  },
};

const entries = [
  {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-07-30T00:00:01.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    },
  },
  {
    type: "message",
    id: "abandoned",
    parentId: "user-1",
    timestamp: "2026-07-30T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] },
  },
  {
    type: "message",
    id: "user-2",
    parentId: "user-1",
    timestamp: "2026-07-30T00:00:03.000Z",
    message: { role: "user", content: [{ type: "text", text: "active branch" }] },
  },
  {
    type: "message",
    id: "assistant-2",
    parentId: "user-2",
    timestamp: "2026-07-30T00:00:04.000Z",
    message: {
      role: "assistant",
      provider: "openai",
      model: "gpt-5",
      content: [
        { type: "text", text: "active answer" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      ],
    },
  },
  {
    type: "message",
    id: "tool-result",
    parentId: "assistant-2",
    timestamp: "2026-07-30T00:00:05.000Z",
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
    },
  },
] as const;

describe("PiSessionProjection", () => {
  it("follows only the active parent chain", () => {
    expect(projectPiActiveBranch(entries).entries.map((entry) => entry.id)).toEqual([
      "user-1",
      "user-2",
      "assistant-2",
      "tool-result",
    ]);
  });

  it("projects normal messages, tool activity, and authoritative capabilities", () => {
    const snapshot = projectPiThread({
      record,
      entries,
      projectId: ProjectId.make("project-1"),
    });

    expect(snapshot.thread.messages.map((message) => message.text)).toEqual([
      "first",
      "active branch",
      "active answer",
    ]);
    expect(snapshot.thread.activities).toHaveLength(1);
    expect(snapshot.thread.messages[0]?.attachments).toBeUndefined();
    expect(snapshot.thread.activities[0]?.kind).toBe("item.completed");
    expect(snapshot.thread.backing).toEqual(projectPiBacking(record, undefined));
    expect(snapshot.thread.backing?.control).toBe("readOnly");
    expect(snapshot.thread.backing?.capabilities.send).toBe(false);
    expect(snapshot.thread.backing?.capabilities.attachments).toBe(false);
    expect(snapshot.thread.backing?.capabilities.rename).toBe(false);
    expect(snapshot.thread.backing?.capabilities.settle).toBe(true);
    expect(snapshot.thread.backing?.capabilities.unsettle).toBe(true);
    expect(snapshot.thread.historyTruncation?.truncated).toBe(false);
  });

  it("preserves Pi tool arguments and presentation in completed history", () => {
    const toolEntries = [
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: "2026-07-30T00:00:01.000Z",
        message: { role: "user", content: "inspect files" },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp: "2026-07-30T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "bash", name: "bash", arguments: { cmd: "git status" } },
            {
              type: "toolCall",
              id: "grep",
              name: "grep",
              arguments: { pattern: "needle", glob: "**/*.ts" },
            },
            {
              type: "toolCall",
              id: "find",
              name: "find",
              arguments: { filePattern: "*.md" },
            },
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { path: "notes.md", content: "hello" },
            },
            {
              type: "toolCall",
              id: "edit",
              name: "edit",
              arguments: { file_path: "src/app.ts", oldText: "old", newText: "new" },
            },
          ],
        },
      },
      ...["bash", "grep", "find", "write", "edit"].map((toolName, index) => ({
        type: "message",
        id: `${toolName}-result`,
        parentId:
          index === 0 ? "assistant" : `${["bash", "grep", "find", "write"][index - 1]}-result`,
        timestamp: `2026-07-30T00:00:0${index + 3}.000Z`,
        message: {
          role: "toolResult",
          toolCallId: toolName,
          toolName,
          content: [{ type: "text", text: "  completed  " }],
          details: { truncation: null },
          isError: false,
        },
      })),
    ];

    const snapshot = projectPiThread({
      record,
      entries: toolEntries,
      projectId: ProjectId.make("project-1"),
    });
    const activities = new Map(
      snapshot.thread.activities.map(
        (activity) => [String(activity.id), activity.payload] as const,
      ),
    );

    expect(activities.get("session-1:tool:bash")).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      data: {
        command: "git status",
        rawInput: { cmd: "git status" },
        rawOutput: { content: "completed", truncation: null },
      },
    });
    expect(activities.get("session-1:tool:grep")).toMatchObject({
      detail: "/needle/ in **/*.ts",
      data: { rawInput: { pattern: "needle", glob: "**/*.ts" } },
    });
    expect(activities.get("session-1:tool:find")).toMatchObject({
      detail: "*.md in .",
      data: { rawInput: { filePattern: "*.md" } },
    });
    expect(activities.get("session-1:tool:write")).toMatchObject({
      itemType: "file_change",
      data: { item: { changes: [{ path: "notes.md" }] } },
    });
    expect(activities.get("session-1:tool:edit")).toMatchObject({
      itemType: "file_change",
      data: { item: { changes: [{ path: "src/app.ts" }] } },
    });
  });

  it("projects every durable Pi message surface", () => {
    const surfaceEntries = [
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: "2026-07-30T00:00:01.000Z",
        message: { role: "user", content: "start" },
      },
      {
        type: "custom_message",
        id: "hidden-custom",
        parentId: "user",
        timestamp: "2026-07-30T00:00:02.000Z",
        customType: "hidden.extension",
        content: "do not render",
        display: false,
      },
      {
        type: "custom_message",
        id: "custom",
        parentId: "hidden-custom",
        timestamp: "2026-07-30T00:00:03.000Z",
        customType: "review.extension",
        content: [{ type: "text", text: "Extension output" }],
        display: true,
      },
      {
        type: "compaction",
        id: "compaction",
        parentId: "custom",
        timestamp: "2026-07-30T00:00:04.000Z",
        summary: "Earlier context summary",
        firstKeptEntryId: "custom",
        tokensBefore: 1234,
      },
      {
        type: "branch_summary",
        id: "branch-summary",
        parentId: "compaction",
        timestamp: "2026-07-30T00:00:05.000Z",
        fromId: "other-branch",
        summary: "Work retained from the other branch",
      },
      {
        type: "message",
        id: "system",
        parentId: "branch-summary",
        timestamp: "2026-07-30T00:00:06.000Z",
        message: { role: "system", content: "Provider notice" },
      },
    ] as const;

    const snapshot = projectPiThread({
      record,
      entries: surfaceEntries,
      projectId: ProjectId.make("project-1"),
    });

    expect(
      snapshot.thread.messages.map(({ role, text, surface }) => ({ role, text, surface })),
    ).toEqual([
      { role: "user", text: "start", surface: undefined },
      {
        role: "system",
        text: "Extension output",
        surface: { kind: "custom", label: "review.extension" },
      },
      {
        role: "system",
        text: "Earlier context summary",
        surface: { kind: "compaction", label: "Context compacted" },
      },
      {
        role: "system",
        text: "Work retained from the other branch",
        surface: { kind: "branch-summary", label: "Branch summarized" },
      },
      {
        role: "system",
        text: "Provider notice",
        surface: { kind: "provider", label: "System message" },
      },
    ]);
  });

  it("projects a persisted external lifecycle override", () => {
    const settled = projectPiThread({
      record,
      entries,
      projectId: ProjectId.make("project-1"),
      lifecycle: {
        override: "settled",
        updatedAt: "2026-07-30T00:02:00.000Z",
      },
    });
    const active = projectPiThread({
      record,
      entries,
      projectId: ProjectId.make("project-1"),
      lifecycle: {
        override: "active",
        updatedAt: "2026-07-30T00:03:00.000Z",
      },
    });

    expect(settled.thread.settledOverride).toBe("settled");
    expect(settled.thread.settledAt).toBe("2026-07-30T00:02:00.000Z");
    expect(active.thread.settledOverride).toBe("active");
    expect(active.thread.settledAt).toBeNull();
  });

  it("retains catalog activity for inactivity-based settlement", () => {
    const snapshot = projectPiThread({
      record: {
        ...record,
        lastActivityAt: "2026-07-20T00:00:00.000Z",
      },
      entries: [],
      projectId: ProjectId.make("project-1"),
    });

    expect(snapshot.thread.latestTurn?.requestedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(snapshot.thread.settledOverride).toBeNull();
  });

  it("does not advertise images without an external asset resolver", () => {
    const runtime = {
      runtimeId: PiNativeRuntimeId.make("runtime-1"),
      writerKind: "rpc",
      status: "idle",
      sequence: 1,
    } as const;
    expect(projectPiBacking(record, runtime).capabilities.attachments).toBe(false);
    expect(
      projectPiBacking(record, {
        ...runtime,
        writerKind: "tuiBridge",
      }).capabilities.attachments,
    ).toBe(false);
  });

  it("marks reconnect history when the bounded live overlay omitted events", () => {
    const snapshot = projectPiThread({
      record,
      entries,
      projectId: ProjectId.make("project-1"),
    });
    const projected = projectPiThreadOverlay(snapshot, record, [], record.updatedAt, 2);

    expect(projected.thread.historyTruncation).toMatchObject({
      truncated: true,
      omittedEntryCount: 2,
    });
  });

  it("projects queued steering and follow-up intent outside timeline history", () => {
    const snapshot = projectPiThread({
      record,
      entries,
      projectId: ProjectId.make("project-1"),
    });
    const projected = projectPiThreadOverlay(snapshot, record, [
      {
        type: "event",
        sequence: 8,
        event: {
          type: "event",
          event: "queue_update",
          data: {
            steering: ["adjust this"],
            followUp: ["then test"],
            omittedSteering: 1,
            omittedFollowUp: 0,
          },
        },
      } as never,
    ]);

    expect(projected.thread.pendingComposerIntents).toEqual([
      { behavior: "steer", text: "adjust this" },
      { behavior: "followUp", text: "then test" },
    ]);
    expect(projected.thread.pendingComposerIntentOmittedCount).toBe(1);
    expect(projected.thread.messages.map((message) => message.text)).not.toContain("adjust this");
  });

  it("does not associate an earlier assistant with a later user turn", () => {
    const snapshot = projectPiThread({
      record,
      entries: entries.slice(0, 3),
      projectId: ProjectId.make("project-1"),
    });

    expect(snapshot.thread.latestTurn?.assistantMessageId).toBeNull();
  });

  it("projects live text prompts without unsupported attachment metadata", () => {
    const event = projectPiLiveEvent({
      record,
      runtime: {
        runtimeId: PiNativeRuntimeId.make("runtime-1"),
        writerKind: "rpc",
        status: "streaming",
        sequence: 9,
      },
      item: {
        type: "event",
        runtimeId: PiNativeRuntimeId.make("runtime-1"),
        sequence: 9,
        eventId: "runtime:9" as never,
        event: {
          type: "message_start",
          message: { role: "user", content: [{ type: "text", text: "new prompt" }] },
        },
      },
      activeTurnId: null,
      occurredAt: record.updatedAt,
    });

    expect(event?.type).toBe("thread.message-sent");
    expect(event?.payload).not.toHaveProperty("attachments");
  });

  it("keeps a delivered user prompt visible during streaming before jsonl settles", () => {
    const snapshot = projectPiThread({
      record,
      entries,
      projectId: ProjectId.make("project-1"),
      runtime: {
        runtimeId: PiNativeRuntimeId.make("runtime-1"),
        writerKind: "rpc",
        status: "streaming",
        sequence: 8,
      },
    });
    const projected = projectPiThreadOverlay(snapshot, record, [
      {
        type: "event",
        sequence: 9,
        eventId: "runtime:9",
        event: {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text: "new prompt" }],
          },
        },
      } as never,
      {
        type: "event",
        sequence: 10,
        eventId: "runtime:10",
        event: {
          type: "message_update",
          update: {
            partial: {
              content: [{ type: "text", text: "streaming answer" }],
            },
          },
        },
      } as never,
    ]);

    expect(projected.thread.messages.findLast((message) => message.role === "user")?.text).toBe(
      "new prompt",
    );
    expect(projected.thread.messages.at(-1)?.turnId).toBe(projected.thread.latestTurn?.turnId);
    expect(projected.thread.latestTurn?.state).toBe("running");
    expect(projected.thread.session?.activeTurnId).toBe(projected.thread.latestTurn?.turnId);
  });

  it("reconciles a retained live prompt with its persisted jsonl message", () => {
    const persistedEntries = [
      ...entries,
      {
        type: "message",
        id: "user-3",
        parentId: "tool-result",
        timestamp: "2026-07-30T00:00:06.000Z",
        message: { role: "user", content: [{ type: "text", text: "same prompt" }] },
      },
    ];
    const snapshot = projectPiThread({
      record,
      entries: persistedEntries,
      projectId: ProjectId.make("project-1"),
      runtime: {
        runtimeId: PiNativeRuntimeId.make("runtime-1"),
        writerKind: "rpc",
        status: "streaming",
        sequence: 9,
      },
    });
    const projected = projectPiThreadOverlay(snapshot, record, [
      {
        type: "event",
        sequence: 9,
        eventId: "runtime:9",
        event: {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text: "same prompt" }],
          },
        },
      } as never,
    ]);

    expect(
      projected.thread.messages.filter((message) => message.text === "same prompt"),
    ).toHaveLength(1);
    expect(projected.thread.latestTurn?.turnId).toBe(snapshot.thread.latestTurn?.turnId);
  });
});

it.layer(SqlitePersistenceMemory)("Pi external history ownership", (it) => {
  it.effect("projects history without creating orchestration sqlite rows", () =>
    Effect.gen(function* () {
      projectPiThread({
        record,
        entries,
        projectId: ProjectId.make("project-1"),
      });
      const sql = yield* SqlClient.SqlClient;
      const [counts] = yield* sql<{
        readonly threads: number;
        readonly messages: number;
        readonly activities: number;
        readonly events: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_threads) AS threads,
          (SELECT COUNT(*) FROM projection_thread_messages) AS messages,
          (SELECT COUNT(*) FROM projection_thread_activities) AS activities,
          (SELECT COUNT(*) FROM orchestration_events) AS events
      `;

      expect(counts).toEqual({ threads: 0, messages: 0, activities: 0, events: 0 });
    }),
  );
});
