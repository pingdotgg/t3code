import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  hermesSessionActivities,
  hermesSessionMessages,
  hermesSessionTitle,
  isHermesSubagentSession,
  parseHermesSessionsExport,
} from "./hermesImport.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it("filters only sessions explicitly identified as Hermes subagents", () => {
  expect(isHermesSubagentSession({ source: "subagent", parent_session_id: "parent" })).toBe(true);
  expect(isHermesSubagentSession({ source: " SUBAGENT " })).toBe(true);
  expect(isHermesSubagentSession({ source: "cli", parent_session_id: "parent" })).toBe(false);
  expect(isHermesSubagentSession({ source: "telegram", parent_session_id: "parent" })).toBe(false);
  expect(isHermesSubagentSession({ parent_session_id: "parent" })).toBe(false);
});

it.effect("parses Hermes JSONL exports and normalizes visible conversation messages", () =>
  Effect.gen(function* () {
    const sessions = yield* parseHermesSessionsExport(
      '{"id":"session-1","started_at":1700000000,"messages":[' +
        '{"id":1,"role":"user","content":"  Explain ACP  ","timestamp":1700000001},' +
        '{"id":2,"role":"assistant","content":[{"text":"Agent Client"},{"text":"Protocol"}]},' +
        '{"id":3,"role":"tool","content":"hidden tool output"},' +
        '{"id":4,"role":"assistant","content":""}]}\n',
    );

    expect(sessions).toHaveLength(1);
    const messages = hermesSessionMessages(sessions[0]!);
    expect(messages).toEqual([
      {
        id: "1",
        role: "user",
        text: "Explain ACP",
        createdAt: "2023-11-14T22:13:21.000Z",
      },
      {
        id: "2",
        role: "assistant",
        text: "Agent Client\n\nProtocol",
        createdAt: "2023-11-14T22:13:20.000Z",
      },
    ]);
    expect(hermesSessionTitle(sessions[0]!, messages)).toBe("Explain ACP");
  }),
);

it.effect("loads Hermes tool outputs, commands, failures, and artifact paths", () =>
  Effect.gen(function* () {
    const exportLine = yield* encodeJson({
      id: "session-tools",
      started_at: 1_700_000_000,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          tool_calls: [
            {
              id: "call-terminal",
              type: "function",
              function: { name: "terminal", arguments: '{"command":"pnpm build"}' },
            },
            {
              id: "call-write",
              type: "function",
              function: { name: "write_file", arguments: '{"path":"src/new.ts"}' },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          tool_call_id: "call-terminal",
          tool_name: "terminal",
          content: '{"output":"Build complete\\n","exit_code":0}',
          timestamp: 1_700_000_001,
        },
        {
          id: "tool-2",
          role: "tool",
          tool_call_id: "call-write",
          tool_name: "write_file",
          content:
            '{"success":true,"resolved_path":"C:/repo/src/new.ts","files_modified":["C:/repo/src/new.ts"]}',
          timestamp: 1_700_000_002,
        },
        {
          id: "tool-3",
          role: "tool",
          tool_call_id: "call-failed",
          tool_name: "terminal",
          content: '{"stderr":"command failed","exit_code":1}',
          timestamp: 1_700_000_003,
        },
        {
          id: "hidden-tool",
          role: "tool",
          tool_name: "memory",
          display_kind: "hidden",
          content: "private memory payload",
        },
      ],
    });
    const sessions = yield* parseHermesSessionsExport(`${exportLine}\n`);

    const activities = hermesSessionActivities(sessions[0]!);
    expect(activities).toHaveLength(3);
    expect(activities[0]).toMatchObject({
      id: "tool-1",
      summary: "Terminal",
      tone: "tool",
      payload: {
        itemType: "command_execution",
        status: "completed",
        detail: "pnpm build",
        data: {
          toolCallId: "call-terminal",
          rawInput: { command: "pnpm build" },
          rawOutput: { output: "Build complete\n", stdout: "Build complete\n", exit_code: 0 },
          item: { command: "pnpm build" },
        },
      },
    });
    expect(activities[1]).toMatchObject({
      summary: "Write File",
      payload: {
        itemType: "file_change",
        data: { files: [{ path: "C:/repo/src/new.ts" }] },
      },
    });
    expect(activities[2]).toMatchObject({
      tone: "error",
      payload: { status: "failed", detail: "command failed" },
    });
  }),
);

it.effect("recovers structured Hermes results from untrusted wrappers", () =>
  Effect.gen(function* () {
    const exportLine = yield* encodeJson({
      id: "session-wrapper",
      messages: [
        {
          id: "wrapped",
          role: "tool",
          tool_name: "web_search",
          content:
            '<untrusted_tool_result origin="web_search">{"results":[{"title":"ACP"}]}</untrusted_tool_result>',
        },
      ],
    });
    const sessions = yield* parseHermesSessionsExport(`${exportLine}\n`);

    expect(hermesSessionActivities(sessions[0]!)[0]).toMatchObject({
      payload: {
        itemType: "web_search",
        data: { rawOutput: { results: [{ title: "ACP" }] } },
      },
    });
  }),
);

it.effect("rejects a malformed Hermes export instead of silently dropping it", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(parseHermesSessionsExport("{not-json}\n"));
    expect(exit._tag).toBe("Failure");
  }),
);
