import { describe, it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { V2ThreadReadResponse } from "effect-codex-app-server/schema";
import { OrchestrationGetAgentHistoryResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { codexHistoryEntry, readCodexAgentHistory } from "./codexAgentHistory.ts";

const isAgentHistoryResult = Schema.is(OrchestrationGetAgentHistoryResult);

/** Build native snapshots with explicit ancestry and enough items to exercise page boundaries. */
function thread(id: string, parent: string | null, count = 1): V2ThreadReadResponse {
  return {
    thread: {
      id,
      cliVersion: "test",
      createdAt: 0,
      updatedAt: 0,
      cwd: "/workspace",
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      sessionId: "session",
      status: { type: "idle" },
      source: parent
        ? { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }
        : "appServer",
      turns: [
        {
          id: "turn",
          status: "completed",
          error: null,
          items: Array.from({ length: count }, (_, index) => ({
            id: `item-${index}`,
            type: "commandExecution" as const,
            command: `read file ${index}`,
            cwd: "/workspace",
            commandActions: [],
            status: "completed" as const,
            exitCode: 0,
            aggregatedOutput: "x".repeat(9000),
          })),
        },
      ],
    },
  };
}

describe("saved Codex agent history", () => {
  it("labels file edits with their paths while preserving the patch for expansion", () => {
    expect(
      codexHistoryEntry({
        type: "fileChange",
        id: "edit",
        status: "completed",
        changes: [
          { path: "src/X.jsx", kind: { type: "update", move_path: null }, diff: "-old\n+new" },
        ],
      }),
    ).toMatchObject({
      kind: "file-edit",
      title: "Edit src/X.jsx",
      detail: "src/X.jsx\n-old\n+new",
    });
  });
  it("uses native reasoning text when no summary is supplied and omits empty markers", () => {
    expect(
      codexHistoryEntry({
        type: "reasoning",
        id: "r",
        summary: [],
        content: ["Checking the schema."],
      }),
    ).toMatchObject({ title: "Reasoning", detail: "Checking the schema." });
    expect(
      codexHistoryEntry({
        type: "reasoning",
        id: "r",
        summary: ["Reviewing validation."],
        content: ["Other text"],
      }),
    ).toMatchObject({ title: "Reasoning summary", detail: "Reviewing validation." });
    expect(
      codexHistoryEntry({ type: "reasoning", id: "r", summary: [" "], content: [] }),
    ).toBeNull();
  });
  it.effect("reads a stopped nested child's history with bounded, nonoverlapping pages", () =>
    Effect.gen(function* () {
      const calls: Array<[string, boolean]> = [];
      const readThread = (id: string, includeTurns: boolean) => {
        calls.push([id, includeTurns]);
        return Effect.succeed(thread(id, id === "child" ? "coordinator" : "parent", 53));
      };
      const first = yield* readCodexAgentHistory({
        parentThreadId: "parent",
        agentId: "child",
        offset: 0,
        readThread,
      });
      expect(calls).toEqual([
        ["child", false],
        ["coordinator", false],
        ["child", true],
      ]);
      expect(first.entries).toHaveLength(50);
      expect(first.nextOffset).toBe(50);
      expect(first.entries[0]?.truncated).toBe(true);
      expect(first.entries[0]?.detail).toHaveLength(8000);
      expect(isAgentHistoryResult(first)).toBe(true);
      const next = yield* readCodexAgentHistory({
        parentThreadId: "parent",
        agentId: "child",
        offset: first.nextOffset!,
        readThread,
      });
      expect(next.entries.map((entry) => entry.id)).toEqual([
        "turn:item-50",
        "turn:item-51",
        "turn:item-52",
      ]);
      expect(next.nextOffset).toBeNull();
    }),
  );

  for (const scenario of ["unrelated", "cycle", "parent"] as const) {
    it.effect(`rejects ${scenario} without loading conversation content`, () =>
      Effect.gen(function* () {
        const calls: boolean[] = [];
        const result = yield* readCodexAgentHistory({
          parentThreadId: "parent",
          agentId: scenario === "parent" ? "parent" : "child",
          offset: 0,
          readThread: (id, includeTurns) => {
            calls.push(includeTurns);
            return Effect.succeed(thread(id, scenario === "cycle" ? "child" : null));
          },
        });
        expect(result.status).toBe("unavailable");
        expect(result.entries).toEqual([]);
        expect(calls).not.toContain(true);
      }),
    );
  }

  it.effect("surfaces provider read failures instead of claiming there is no activity", () =>
    Effect.gen(function* () {
      const error = new Error("history missing");
      const result = yield* readCodexAgentHistory({
        parentThreadId: "parent",
        agentId: "child",
        offset: 0,
        readThread: () => Effect.fail(error),
      }).pipe(Effect.flip);
      expect(result).toBe(error);
    }),
  );
});
