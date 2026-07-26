import { describe, expect, it } from "vite-plus/test";

import { hookSessionUpdate, makeAgyTurnState, type AgyTurnState } from "./agyEvents.ts";
import {
  AgyTranscriptCursor,
  normalizeToolOutput,
  parseTranscriptLine,
  transcriptRecordUpdates,
} from "./agyTranscript.ts";

function stateWithActiveTool(stepIdx: number, name = "run_command"): AgyTurnState {
  const state = makeAgyTurnState();
  hookSessionUpdate(
    {
      event: "pre-tool-use",
      payload: { conversationId: "conversation-1", stepIdx, toolCall: { name, args: {} } },
    },
    state,
  );
  return state;
}

describe("parseTranscriptLine", () => {
  it("returns null for blank and half-written lines", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine('{"step_index": 1, "type": "RUN_COM')).toBeNull();
  });

  it("parses a complete record", () => {
    expect(parseTranscriptLine('{"step_index":2,"type":"PLANNER_RESPONSE"}')).toMatchObject({
      step_index: 2,
      type: "PLANNER_RESPONSE",
    });
  });
});

describe("normalizeToolOutput", () => {
  it("strips the timestamp preamble", () => {
    const output = normalizeToolOutput(
      "Created At: 2026-07-24T17:31:41-04:00\nCompleted At: 2026-07-24T17:31:41-04:00\nresult",
    );
    expect(output).toBe("result");
  });

  it("dedents Antigravity's tab-indented framing without touching flush-left output", () => {
    // Antigravity indents its own framing with tabs but writes the tool's real
    // output flush left, so a plain common-prefix dedent would find zero.
    const output = normalizeToolOutput(
      "Created At: x\n\n\t\t\t\tThe command exited with code 0.\n\t\t\t\tOutput:\n\t\t\t\ttotal 16\ndrwxr-xr-x  4 alex staff",
    );
    expect(output).toBe(
      "The command exited with code 0.\nOutput:\ntotal 16\ndrwxr-xr-x  4 alex staff",
    );
  });

  it("dedents tab-indented source uniformly", () => {
    expect(normalizeToolOutput("\t\tconst a = 1;\n\t\t\tconst b = 2;")).toBe(
      "const a = 1;\n\tconst b = 2;",
    );
  });
});

describe("transcriptRecordUpdates", () => {
  it("streams assistant text as an agent message chunk", () => {
    const result = transcriptRecordUpdates(
      { step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", content: "All done." },
      makeAgyTurnState(),
    );

    expect(result.emittedAssistantText).toBe(true);
    expect(result.updates[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "All done." },
    });
  });

  it("skips empty planner responses", () => {
    const result = transcriptRecordUpdates(
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", content: "   " },
      makeAgyTurnState(),
    );

    expect(result.updates).toHaveLength(0);
    expect(result.emittedAssistantText).toBe(false);
  });

  it("ignores bookkeeping records that would read as assistant output", () => {
    for (const type of ["CHECKPOINT", "CONVERSATION_HISTORY", "USER_INPUT", "SYSTEM_MESSAGE"]) {
      const result = transcriptRecordUpdates(
        { step_index: 1, source: "SYSTEM", type, content: "internal" },
        makeAgyTurnState(),
      );
      expect(result.updates).toHaveLength(0);
    }
  });

  it("attaches tool output to the call the matching hook announced", () => {
    const state = stateWithActiveTool(3);
    const result = transcriptRecordUpdates(
      {
        step_index: 3,
        source: "MODEL",
        type: "RUN_COMMAND",
        content:
          "Created At: x\n\t\t\t\tThe command exited with code 0.\n\t\t\t\tOutput:\n\t\t\t\tok",
      },
      state,
    );

    expect(result.updates[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "agy-conversation-1-3",
      content: [
        {
          type: "content",
          content: { type: "text", text: "The command exited with code 0.\nOutput:\nok" },
        },
      ],
    });
  });

  it("still attaches output after the post hook completed the call", () => {
    // One drain pass reads hooks before the transcript, so for a fast tool the
    // PostToolUse hook and the record carrying its output arrive together. If
    // completing a call dropped its bookkeeping, that output would be lost.
    const state = stateWithActiveTool(3);
    hookSessionUpdate(
      { event: "post-tool-use", payload: { conversationId: "conversation-1", stepIdx: 3 } },
      state,
    );

    const result = transcriptRecordUpdates(
      { step_index: 3, source: "MODEL", type: "RUN_COMMAND", content: "Created At: x\nok" },
      state,
    );

    expect(result.updates[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "agy-conversation-1-3",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
  });

  it("drops tool output with no announced call rather than inventing one", () => {
    const result = transcriptRecordUpdates(
      { step_index: 99, source: "MODEL", type: "RUN_COMMAND", content: "orphan" },
      makeAgyTurnState(),
    );

    expect(result.updates).toHaveLength(0);
  });
});

describe("AgyTranscriptCursor", () => {
  it("holds back a partial trailing line until the rest arrives", () => {
    const cursor = new AgyTranscriptCursor();

    expect(cursor.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(cursor.push("2}\n")).toEqual(['{"b":2}']);
  });

  it("tracks the byte offset it has consumed", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.push("abc\n");

    expect(cursor.bytesConsumed).toBe(4);
  });

  it("flushes the trailing line once the writer is finished", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.push('{"a":1}\n{"b":2}');

    expect(cursor.flush()).toEqual(['{"b":2}']);
    expect(cursor.flush()).toEqual([]);
  });
});
