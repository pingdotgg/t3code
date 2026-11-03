import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { attachmentThreadId, projectAttachmentLine } from "./claudeAttachmentProjection.ts";

const thread = Schema.decodeSync(OrchestrationV2AppThread)({
  id: attachmentThreadId("/claude", "session"),
  projectId: ProjectId.make("project"),
  title: "External session",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  createdBy: "agent",
  creationSource: "provider",
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: null,
    rootThreadId: attachmentThreadId("/claude", "session"),
    relationshipToParent: null,
  },
  forkedFrom: null,
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const isEvent = Schema.is(OrchestrationV2DomainEvent);
const record = {
  type: "assistant",
  uuid: "message-1",
  sessionId: "session",
  timestamp: "2026-01-01T00:01:00Z",
  message: { content: [{ type: "text", text: "Finished the repair." }], stop_reason: "end_turn" },
};

describe("external Claude projection", () => {
  it("joins native tool results to their calls without claiming unfinished history is running", () => {
    const call = projectAttachmentLine({
      sessionId: "session",
      thread,
      parent: null,
      agentId: null,
      ordinal: 10,
      includeActivity: false,
      line: JSON.stringify({
        ...record,
        uuid: "tool-call",
        message: {
          content: [
            { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "file.txt" } },
          ],
        },
      }),
    });
    const item = call.find((event) => event.type === "turn-item.updated")!.payload;
    expect(item).toMatchObject({
      type: "dynamic_tool",
      status: "idle",
      toolName: "Read",
      input: { file_path: "file.txt" },
    });
    const result = projectAttachmentLine({
      sessionId: "session",
      thread,
      parent: null,
      agentId: null,
      ordinal: 20,
      includeActivity: false,
      previousTools: new Map([["call-1", item]]),
      line: JSON.stringify({
        ...record,
        type: "user",
        uuid: "tool-result",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "File contents",
              is_error: false,
            },
          ],
        },
      }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toMatchObject({
      id: item.id,
      type: "dynamic_tool",
      status: "completed",
      ordinal: 10,
      toolName: "Read",
      input: { file_path: "file.txt" },
      output: "File contents",
    });
    const completed = result.find((event) => event.type === "turn-item.updated")!.payload;
    const lateCall = projectAttachmentLine({
      sessionId: "session",
      thread,
      parent: null,
      agentId: null,
      ordinal: 10,
      includeActivity: false,
      previousTools: new Map([["call-1", completed]]),
      line: JSON.stringify({
        ...record,
        uuid: "tool-call",
        message: {
          content: [
            { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "file.txt" } },
          ],
        },
      }),
    });
    expect(lateCall[0]?.payload).toMatchObject({
      status: "completed",
      output: "File contents",
      input: { file_path: "file.txt" },
    });
    for (const event of [...call, ...result, ...lateCall]) expect(isEvent(event)).toBe(true);
  });

  it("projects native child history and completion without creating a provider turn or replaying a prompt", () => {
    const events = projectAttachmentLine({
      sessionId: "session",
      thread,
      parent: { ...thread, id: attachmentThreadId("/claude", "parent") },
      agentId: "child",
      line: JSON.stringify(record),
      ordinal: 1,
    });
    for (const event of events) expect(isEvent(event)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "message.updated",
      "turn-item.updated",
      "node.updated",
      "subagent.updated",
      "node.updated",
    ]);
    const subagent = events.find((e) => e.type === "subagent.updated");
    expect(subagent?.payload.status).toBe("completed");
    expect(subagent?.payload.origin).toBe("provider_native");
    expect(subagent?.payload.childThreadId).toBe(thread.id);
    const again = projectAttachmentLine({
      sessionId: "session",
      thread,
      parent: { ...thread, id: attachmentThreadId("/claude", "parent") },
      agentId: "child",
      line: JSON.stringify(record),
      ordinal: 1,
    });
    expect(again).toEqual(events);
  });
  it("keeps human wording exact and classifies harness traffic as system activity", () => {
    const project = (extra: object) =>
      projectAttachmentLine({
        sessionId: "session",
        thread,
        parent: null,
        agentId: null,
        ordinal: 1,
        includeActivity: false,
        line: JSON.stringify({
          ...record,
          type: "user",
          message: { content: "  My exact\nmessage  " },
          ...extra,
        }),
      });
    const human = project({ origin: { kind: "human" }, promptSource: "typed" });
    expect(human.find((e) => e.type === "message.updated")?.payload).toMatchObject({
      role: "user",
      text: "  My exact\nmessage  ",
    });
    for (const extra of [
      { origin: { kind: "task-notification" }, promptSource: "system" },
      { origin: { kind: "peer" }, isMeta: true },
      { isCompactSummary: true, isVisibleInTranscriptOnly: true },
      { isMeta: true },
      { message: { content: "<command-name>/login</command-name>" } },
    ]) {
      const events = project(extra);
      expect(events.every(isEvent)).toBe(true);
      expect(events.find((e) => e.type === "message.updated")?.payload).toMatchObject({
        role: "system",
        createdBy: "system",
      });
      expect(events.find((e) => e.type === "turn-item.updated")?.payload.type).toBe(
        "system_notice",
      );
    }
  });
  it("does not let old backfill mark agents running and treats stale unfinished tails as unknown idle", () => {
    const input = {
      thread,
      parent: thread,
      agentId: "child",
      ordinal: 1,
      line: JSON.stringify({ ...record, message: { content: "Working", stop_reason: "tool_use" } }),
    };
    expect(
      projectAttachmentLine({ sessionId: "session", ...input, includeActivity: false }).map(
        (e) => e.type,
      ),
    ).toEqual(["message.updated", "turn-item.updated"]);
    const stale = projectAttachmentLine({
      sessionId: "session",
      ...input,
      activityStatus: "idle",
    }).find((e) => e.type === "subagent.updated");
    expect(stale?.payload).toMatchObject({
      status: "idle",
      result: null,
      progress: "No recent activity; final outcome not recorded by Claude.",
    });
    const finished = projectAttachmentLine({
      sessionId: "session",
      ...input,
      activityStatus: "idle",
      line: JSON.stringify({
        ...record,
        message: { content: "Done", stop_reason: "stop_sequence" },
      }),
    }).find((e) => e.type === "subagent.updated");
    expect(finished?.payload).toMatchObject({ status: "completed", result: "Done" });
    expect(finished?.payload.progress).toBeUndefined();
  });
  it("does not expose another session or turn tool-result strings into user prompts", () => {
    const project = (value: unknown) =>
      projectAttachmentLine({
        sessionId: "session",
        thread,
        parent: null,
        agentId: null,
        line: JSON.stringify(value),
        ordinal: 1,
      });
    expect(project({ ...record, sessionId: "unrelated" })).toEqual([]);
    expect(
      project({
        ...record,
        type: "user",
        message: { content: [{ type: "tool_result", content: "sensitive tool output" }] },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ type: "node.updated" })]));
    expect(project({ ...record, timestamp: "invalid" })).toEqual([]);
  });
});

it("preserves explicitly human plugin prompts while keeping ordinary plugin traffic internal", () => {
  for (const [origin, role] of [
    [{ kind: "plugin", name: "t3-live-session", asUser: true }, "user"],
    [{ kind: "plugin", name: "t3-live-session", asUser: false }, "system"],
    [{ kind: "plugin", name: "another-plugin" }, "system"],
    [{ kind: "peer", asUser: true }, "system"],
  ] as const) {
    const events = projectAttachmentLine({
      sessionId: "session",
      thread,
      parent: null,
      agentId: null,
      ordinal: 1,
      line: JSON.stringify({
        ...record,
        type: "user",
        origin,
        message: { content: [{ type: "text", text: "My exact message" }] },
      }),
    });
    expect(events.find((event) => event.type === "message.updated")?.payload).toMatchObject({
      role,
      text: "My exact message",
    });
    for (const event of events) expect(isEvent(event)).toBe(true);
  }
});

it("backfills thinking as separate completed rows without putting it in human chat", () => {
  const events = projectAttachmentLine({
    sessionId: "session",
    thread,
    parent: null,
    agentId: null,
    ordinal: 1,
    includeActivity: false,
    line: JSON.stringify({
      ...record,
      message: {
        content: [
          { type: "thinking", thinking: "First reasoning block", signature: "native-signature" },
          { type: "thinking", thinking: "Second reasoning block" },
          { type: "redacted_thinking", data: "opaque-provider-data" },
          { type: "text", text: "The answer." },
        ],
      },
    }),
  });
  for (const event of events) expect(isEvent(event)).toBe(true);
  const thoughts = events.flatMap((event) =>
    event.type === "turn-item.updated" && event.payload.type === "reasoning" ? [event.payload] : [],
  );
  expect(thoughts).toHaveLength(2);
  expect(thoughts[0]).toMatchObject({
    text: "First reasoning block",
    streaming: false,
    status: "completed",
  });
  expect(thoughts[0]?.id).not.toBe(thoughts[1]?.id);
  expect(
    events.filter((event) => event.type === "message.updated").map((event) => event.payload.text),
  ).toEqual(["The answer."]);
});
