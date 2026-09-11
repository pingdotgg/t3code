import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Part } from "@opencode-ai/sdk/v2";
import { readOpenCodeAgentHistory } from "./openCodeAgentHistory.ts";

const parts = Array.from({ length: 53 }, (_, i): Part => ({
  type: "tool",
  id: `part-${i}`,
  callID: `call-${i}`,
  sessionID: "child",
  messageID: "message",
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "pwd" },
    output: "x".repeat(9000),
    title: "pwd",
    metadata: {},
    time: { start: 1, end: 2 },
  },
}));

it.effect("reads nested children with bounded, stable pages and tool results", () =>
  Effect.gen(function* () {
    const readSession = (id: string) =>
      Effect.succeed({ id, parentID: id === "child" ? "nested" : "parent" });
    const readMessages = () =>
      Effect.succeed([{ info: { id: "message", role: "assistant" as const }, parts }]);
    const input = {
      parentSessionId: "parent",
      agentId: "child",
      offset: 0,
      readSession,
      readMessages,
    };
    const first = yield* readOpenCodeAgentHistory(input);
    expect(first.entries).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    expect(first.entries[0]).toMatchObject({ id: "message:part-0", kind: "tool", truncated: true });
    expect(first.entries[0]?.detail).toHaveLength(8000);
    const second = yield* readOpenCodeAgentHistory({ ...input, offset: 50 });
    expect(second.entries.map((entry) => entry.id)).toEqual([
      "message:part-50",
      "message:part-51",
      "message:part-52",
    ]);
    expect(second.nextOffset).toBeNull();
  }),
);

for (const scenario of ["unrelated", "cycle", "parent"] as const) {
  it.effect(`rejects ${scenario} before reading messages`, () =>
    Effect.gen(function* () {
      const result = yield* readOpenCodeAgentHistory({
        parentSessionId: "parent",
        agentId: scenario === "parent" ? "parent" : "child",
        offset: 0,
        readSession: (id) =>
          Effect.succeed({ id, ...(scenario === "cycle" ? { parentID: "child" } : {}) }),
        readMessages: () => Effect.die("must not read messages"),
      });
      expect(result.status).toBe("unavailable");
    }),
  );
}

it.effect("honors native revert boundaries and maps text, reasoning and failed tools", () =>
  Effect.gen(function* () {
    const base = { sessionID: "child", messageID: "message" };
    const result = yield* readOpenCodeAgentHistory({
      parentSessionId: "parent",
      agentId: "child",
      offset: 0,
      readSession: (id) =>
        Effect.succeed({ id, parentID: "parent", revert: { messageID: "removed" } }),
      readMessages: () =>
        Effect.succeed([
          {
            info: { id: "message", role: "user" as const },
            parts: [
              { ...base, id: "text", type: "text" as const, text: "Prompt" },
              {
                ...base,
                id: "reason",
                type: "reasoning" as const,
                text: "Thinking",
                time: { start: 1 },
              },
              {
                ...base,
                id: "error",
                callID: "error",
                type: "tool" as const,
                tool: "bash",
                state: {
                  status: "error" as const,
                  input: {},
                  error: "failed",
                  time: { start: 1, end: 2 },
                },
              },
            ],
          },
          { info: { id: "removed", role: "assistant" as const }, parts },
        ]),
    });
    expect(result.entries.map((entry) => entry.kind)).toEqual(["user", "reasoning", "tool"]);
    expect(result.entries[2]?.detail).toContain('"error": "failed"');
  }),
);

it.effect("labels edits by file path", () =>
  Effect.gen(function* () {
    const result = yield* readOpenCodeAgentHistory({
      parentSessionId: "parent",
      agentId: "child",
      offset: 0,
      readSession: (id) => Effect.succeed({ id, parentID: "parent" }),
      readMessages: () =>
        Effect.succeed([
          {
            info: { id: "message", role: "assistant" as const },
            parts: [
              {
                type: "tool" as const,
                id: "edit",
                callID: "edit",
                sessionID: "child",
                messageID: "message",
                tool: "edit",
                state: {
                  status: "completed" as const,
                  input: { filePath: "src/X.jsx", newString: "new" },
                  output: "patched",
                  title: "edit",
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            ],
          },
        ]),
    });
    expect(result.entries[0]).toMatchObject({ kind: "file-edit", title: "Edit src/X.jsx" });
  }),
);
