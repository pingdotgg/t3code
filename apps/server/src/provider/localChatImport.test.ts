import { expect, it } from "@effect/vitest";

import { parseCodexTranscript, parseOpenCodeRows } from "./localChatImport.ts";

it("parses Codex messages, titles, commands, outputs, and artifact paths", () => {
  const transcript = [
    {
      timestamp: "2026-01-01T10:00:00Z",
      type: "session_meta",
      payload: { id: "codex-1", cwd: "C:/repo", timestamp: "2026-01-01T10:00:00Z" },
    },
    {
      timestamp: "2026-01-01T10:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Build it" }],
      },
    },
    {
      timestamp: "2026-01-01T10:00:02Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: '{"cmd":"pnpm build","workdir":"C:/repo"}',
      },
    },
    {
      timestamp: "2026-01-01T10:00:03Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"stdout":"Build complete","exit_code":0}',
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");

  const session = parseCodexTranscript(
    { path: "rollout.jsonl", contents: transcript },
    new Map([["codex-1", "Imported Codex work"]]),
  );

  expect(session?.id).toBe("codex-1");
  expect(session?.title).toBe("Imported Codex work");
  expect(session?.cwd).toBe("C:/repo");
  expect(session?.messages).toHaveLength(1);
  expect(session?.activities[0]?.payload.itemType).toBe("command_execution");
  expect(session?.activities[0]?.payload.data.command).toBe("pnpm build");
  expect(session?.activities[0]?.payload.data.stdout).toBe("Build complete");
  expect(session?.activities[0]?.payload.data.files).toContain("C:/repo");
});

it("parses OpenCode text and completed tool parts", () => {
  const sessions = parseOpenCodeRows({
    sessions: [
      {
        id: "oc-1",
        directory: "C:/repo",
        title: "OpenCode work",
        model: '{"id":"model-1"}',
        time_created: 1_700_000_000_000,
      },
    ],
    messages: [
      {
        id: "message-1",
        session_id: "oc-1",
        time_created: 1_700_000_001_000,
        data: '{"role":"assistant"}',
      },
    ],
    parts: [
      {
        id: "part-text",
        message_id: "message-1",
        time_created: 1_700_000_001_000,
        data: '{"type":"text","text":"Done"}',
      },
      {
        id: "part-tool",
        message_id: "message-1",
        time_created: 1_700_000_002_000,
        data: JSON.stringify({
          type: "tool",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "C:/repo/src/new.ts" },
            output: "Wrote file",
          },
        }),
      },
    ],
  });

  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.messages[0]?.text).toBe("Done");
  expect(sessions[0]?.model).toBe("model-1");
  expect(sessions[0]?.activities[0]?.payload.itemType).toBe("file_change");
  expect(sessions[0]?.activities[0]?.payload.data.files).toEqual(["C:/repo/src/new.ts"]);
});

it("skips malformed and empty Codex transcripts", () => {
  expect(parseCodexTranscript({ path: "bad.jsonl", contents: "not-json" })).toBeNull();
  expect(
    parseCodexTranscript({
      path: "empty.jsonl",
      contents: JSON.stringify({ type: "session_meta", payload: { id: "empty" } }),
    }),
  ).toBeNull();
});
