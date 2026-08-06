import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe } from "vite-plus/test";

import {
  buildImportedThreadEvents,
  importedMessageId,
  mapClaudeSessionMessages,
  parseCodexRollout,
  type ImportedTranscriptEntry,
} from "./SessionImportTranscript.ts";

const threadId = ThreadId.make("thread-import-test");
const fallbackAt = DateTime.makeUnsafe("2026-08-06T10:00:00.000Z");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

function summarize(entry: ImportedTranscriptEntry): ReadonlyArray<string> {
  switch (entry.kind) {
    case "message":
      return [entry.kind, entry.sourceId, entry.role, entry.text];
    case "reasoning":
      return [entry.kind, entry.sourceId, entry.text];
    case "command":
      return [entry.kind, entry.sourceId, entry.input, entry.output ?? ""];
    case "file_change":
      return [entry.kind, entry.sourceId, entry.fileName];
  }
}

describe("mapClaudeSessionMessages", () => {
  it("keeps user/assistant text and drops synthetic context", () => {
    const entries = mapClaudeSessionMessages([
      { type: "user", uuid: "u1", message: { content: "  hello  " } },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "text", text: "hi" }] },
      },
      { type: "system", uuid: "s1", message: { content: "system" } },
      { type: "user", uuid: "u3", message: { content: "<system-reminder>noise" } },
    ]);
    assert.deepStrictEqual(entries.map(summarize), [
      ["message", "u1", "user", "hello"],
      ["message", "a1", "assistant", "hi"],
    ]);
  });

  it("maps thinking, tool calls with their results, and file edits", () => {
    const entries = mapClaudeSessionMessages([
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "on it" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Edit",
              input: { file_path: "/src/a.ts", old_string: "old", new_string: "new" },
            },
            { type: "tool_use", id: "tool-3", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "total 0\n" },
            {
              type: "tool_result",
              tool_use_id: "tool-3",
              content: [{ type: "text", text: "a.ts:1" }],
            },
          ],
        },
      },
    ]);
    assert.deepStrictEqual(entries.map(summarize), [
      ["message", "a1", "assistant", "on it"],
      ["reasoning", "a1:r0", "pondering"],
      ["command", "tool-1", "ls -la", "total 0"],
      ["file_change", "tool-2", "/src/a.ts"],
      ["command", "tool-3", 'Grep {"pattern":"foo"}', "a.ts:1"],
    ]);
    const edit = entries[3];
    assert.strictEqual(edit?.kind === "file_change" && edit.oldStr, "old");
    assert.strictEqual(edit?.kind === "file_change" && edit.newStr, "new");
  });
});

describe("parseCodexRollout", () => {
  it("reads session meta, messages, reasoning, and function calls with outputs", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-08-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "t1", cwd: "/work/project" },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "m1",
          role: "user",
          content: [{ type: "input_text", text: "question" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "reasoning", id: "r1", summary: [{ text: "thinking hard" }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: ["ls", "-la"] }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: JSON.stringify({ output: "total 0" }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", id: "m2", message: "answer" },
      }),
      "not json",
    ].join("\n");
    const transcript = parseCodexRollout(lines);
    assert.strictEqual(transcript.workspaceRoot, "/work/project");
    assert.deepStrictEqual(transcript.entries.map(summarize), [
      ["message", "m1", "user", "question"],
      ["reasoning", "r1", "thinking hard"],
      ["command", "c1", "ls -la", "total 0"],
      ["message", "m2", "assistant", "answer"],
    ]);
  });

  it("dedupes response_item/event_msg pairs sharing an id", () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", id: "m1", message: "question" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "m1",
          role: "user",
          content: [{ type: "input_text", text: "question" }],
        },
      }),
    ].join("\n");
    assert.strictEqual(parseCodexRollout(lines).entries.length, 1);
  });
});

describe("buildImportedThreadEvents", () => {
  const entries: ReadonlyArray<{ entry: ImportedTranscriptEntry; index: number }> = [
    {
      entry: { kind: "message", sourceId: "u1", role: "user", text: "hello", timestamp: undefined },
      index: 0,
    },
    {
      entry: { kind: "reasoning", sourceId: "a1:r0", text: "hmm", timestamp: undefined },
      index: 1,
    },
    {
      entry: {
        kind: "message",
        sourceId: "a1",
        role: "assistant",
        text: "hi",
        timestamp: "2026-08-02T00:00:00.000Z",
      },
      index: 2,
    },
  ];

  it("emits a message/turn-item pair per message and a single item otherwise", () => {
    const batch = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: claudeDriver,
      threadId,
      entries,
      fallbackAt,
    });
    assert.deepStrictEqual(
      batch.events.map((event) => event.type),
      [
        "message.updated",
        "turn-item.updated",
        "turn-item.updated",
        "message.updated",
        "turn-item.updated",
      ],
    );
    const again = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: claudeDriver,
      threadId,
      entries,
      fallbackAt,
    });
    assert.deepStrictEqual(
      again.events.map((event) => event.id),
      batch.events.map((event) => event.id),
    );
    assert.deepStrictEqual(
      batch.positions.map((position) => position.ordinal),
      [1, 2, 3],
    );
  });

  it("shifts position ordinals by ordinalBase for sync appends", () => {
    const batch = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: claudeDriver,
      threadId,
      entries,
      fallbackAt,
      ordinalBase: 2_000_123,
    });
    assert.deepStrictEqual(
      batch.positions.map((position) => position.ordinal),
      [2_000_124, 2_000_125, 2_000_126],
    );
  });

  it("uses the transcript timestamp when present and the fallback otherwise", () => {
    const batch = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: claudeDriver,
      threadId,
      entries,
      fallbackAt,
    });
    assert.strictEqual(DateTime.formatIso(batch.events[0]!.occurredAt), "2026-08-06T10:00:00.000Z");
    assert.strictEqual(DateTime.formatIso(batch.events[3]!.occurredAt), "2026-08-02T00:00:00.000Z");
  });

  it("derives stable message ids from driver, thread, index and source id", () => {
    assert.strictEqual(
      importedMessageId({ driver: "codex", threadId, index: 3, sourceId: "abc" }),
      `imported:codex:${threadId}:000003:abc`,
    );
  });
});
