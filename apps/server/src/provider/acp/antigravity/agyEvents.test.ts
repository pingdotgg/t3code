import { describe, expect, it } from "vite-plus/test";

import {
  agyHookResponse,
  agyTargetPath,
  agyToolCallId,
  agyToolKind,
  agyToolTitle,
  hookSessionUpdate,
  makeAgyTurnState,
  type AgyHookEvent,
} from "./agyEvents.ts";

const preToolUse = (overrides: Record<string, unknown> = {}): AgyHookEvent => ({
  event: "pre-tool-use",
  payload: {
    conversationId: "conversation-1",
    stepIdx: 3,
    transcriptPath: "/brain/conversation-1/.system_generated/logs/transcript_full.jsonl",
    modelName: "gemini-3.1-pro-high",
    toolCall: { name: "run_command", args: { CommandLine: "ls -la src" } },
    ...overrides,
  },
});

describe("agyToolKind", () => {
  it("maps Antigravity tool names onto ACP kinds", () => {
    expect(agyToolKind("replace_file_content")).toBe("edit");
    expect(agyToolKind("write_to_file")).toBe("edit");
    expect(agyToolKind("view_file")).toBe("read");
    expect(agyToolKind("list_dir")).toBe("read");
    expect(agyToolKind("grep_search")).toBe("search");
    expect(agyToolKind("run_command")).toBe("execute");
    expect(agyToolKind("delete_file")).toBe("delete");
  });

  it("treats browser tools as fetch and unknown tools as other", () => {
    expect(agyToolKind("browser_navigate")).toBe("fetch");
    expect(agyToolKind("some_future_tool")).toBe("other");
    expect(agyToolKind(undefined)).toBe("other");
  });
});

describe("agyToolTitle", () => {
  it("prefers Antigravity's own summary over the raw tool name", () => {
    expect(agyToolTitle({ name: "run_command", args: { toolSummary: "List files in src" } })).toBe(
      "List files in src",
    );
  });

  it("falls back through toolAction to the tool name", () => {
    expect(agyToolTitle({ name: "run_command", args: { toolAction: "Listing files" } })).toBe(
      "Listing files",
    );
    expect(agyToolTitle({ name: "run_command", args: {} })).toBe("run_command");
    expect(agyToolTitle(null)).toBe("Antigravity tool");
  });
});

describe("agyTargetPath", () => {
  it("reads the path from whichever PascalCase key the tool used", () => {
    expect(agyTargetPath({ name: "replace_file_content", args: { TargetFile: "/a/b.ts" } })).toBe(
      "/a/b.ts",
    );
    expect(agyTargetPath({ name: "view_file", args: { AbsolutePath: "/a/c.ts" } })).toBe("/a/c.ts");
    expect(agyTargetPath({ name: "list_dir", args: { DirectoryPath: "/a" } })).toBe("/a");
    expect(agyTargetPath({ name: "run_command", args: { CommandLine: "ls" } })).toBeUndefined();
  });
});

describe("hookSessionUpdate", () => {
  it("announces a tool call and records it as in flight", () => {
    const state = makeAgyTurnState();
    const update = hookSessionUpdate(preToolUse(), state);

    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: agyToolCallId("conversation-1", 3),
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "ls -la src" },
    });
    expect(state.toolCalls.get(3)?.completed).toBe(false);
  });

  it("learns the conversation and transcript from any hook, not just stop", () => {
    const state = makeAgyTurnState();
    hookSessionUpdate(preToolUse(), state);

    expect(state.conversationId).toBe("conversation-1");
    expect(state.modelName).toBe("gemini-3.1-pro-high");
    expect(state.transcriptPath).toBe(
      "/brain/conversation-1/.system_generated/logs/transcript_full.jsonl",
    );
  });

  it("ignores hook pairs for internal planner steps that carry no tool", () => {
    const state = makeAgyTurnState();
    const update = hookSessionUpdate(
      { event: "pre-tool-use", payload: { conversationId: "c", stepIdx: 1, toolCall: null } },
      state,
    );

    expect(update).toBeNull();
    expect(state.toolCalls.size).toBe(0);
  });

  it("completes a tool call that was announced", () => {
    const state = makeAgyTurnState();
    hookSessionUpdate(preToolUse(), state);
    const update = hookSessionUpdate(
      {
        event: "post-tool-use",
        payload: { conversationId: "conversation-1", stepIdx: 3, error: "" },
      },
      state,
    );

    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: { isError: false },
    });
    // Retained, not deleted: the transcript record carrying this step's output
    // is often read in the same drain pass and still needs the tool call id.
    expect(state.toolCalls.get(3)?.completed).toBe(true);
  });

  it("ignores a duplicate post hook for an already completed step", () => {
    const state = makeAgyTurnState();
    hookSessionUpdate(preToolUse(), state);
    const post = {
      event: "post-tool-use",
      payload: { conversationId: "conversation-1", stepIdx: 3, error: "" },
    } as const;

    expect(hookSessionUpdate(post, state)).not.toBeNull();
    expect(hookSessionUpdate(post, state)).toBeNull();
  });

  it("marks a tool call failed and carries the error through", () => {
    const state = makeAgyTurnState();
    hookSessionUpdate(preToolUse(), state);
    const update = hookSessionUpdate(
      {
        event: "post-tool-use",
        payload: { conversationId: "conversation-1", stepIdx: 3, error: "exit status 1" },
      },
      state,
    );

    expect(update).toMatchObject({
      status: "failed",
      rawOutput: { isError: true, error: "exit status 1" },
    });
  });

  it("drops a post hook whose pre hook was never observed", () => {
    const state = makeAgyTurnState();
    const update = hookSessionUpdate(
      { event: "post-tool-use", payload: { conversationId: "c", stepIdx: 9, error: "" } },
      state,
    );

    expect(update).toBeNull();
  });

  it("emits a diff from the file contents captured around an edit", () => {
    const state = makeAgyTurnState();
    hookSessionUpdate(
      preToolUse({
        toolCall: { name: "replace_file_content", args: { TargetFile: "/repo/greet.js" } },
      }),
      state,
      'return "hi";',
    );
    const update = hookSessionUpdate(
      {
        event: "post-tool-use",
        payload: { conversationId: "conversation-1", stepIdx: 3, error: "" },
      },
      state,
      'return "hello";',
    );

    expect(update).toMatchObject({
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/repo/greet.js",
          oldText: 'return "hi";',
          newText: 'return "hello";',
        },
      ],
    });
  });

  it("omits the diff when an edit left the file byte-identical", () => {
    const state = makeAgyTurnState();
    hookSessionUpdate(
      preToolUse({
        toolCall: { name: "write_to_file", args: { TargetFile: "/repo/a.ts" } },
      }),
      state,
      "same",
    );
    const update = hookSessionUpdate(
      {
        event: "post-tool-use",
        payload: { conversationId: "conversation-1", stepIdx: 3, error: "" },
      },
      state,
      "same",
    );

    expect(update).not.toHaveProperty("content");
  });
});

describe("agyHookResponse", () => {
  it("allows tools only while a bridge observer is attached", () => {
    expect(agyHookResponse("pre-tool-use", true)).toEqual({ decision: "allow" });
    expect(agyHookResponse("pre-tool-use", false)).toMatchObject({ decision: "ask" });
  });

  it("answers the stop contract with a decision", () => {
    expect(agyHookResponse("stop", true)).toEqual({ decision: "stop" });
    expect(agyHookResponse("post-tool-use", true)).toEqual({});
  });
});

describe("resolveAgyCommand", () => {
  it("returns unchanged command for non-windows platforms", async () => {
    const { resolveAgyCommand } = await import("./agyBridge.ts");
    expect(resolveAgyCommand("agy", {}, "linux")).toEqual({ command: "agy", shell: false });
    expect(resolveAgyCommand("agy", {}, "darwin")).toEqual({ command: "agy", shell: false });
  });

  it("identifies explicit cmd files on windows", async () => {
    const { resolveAgyCommand } = await import("./agyBridge.ts");
    expect(resolveAgyCommand("C:\\tools\\agy.cmd", {}, "win32")).toEqual({
      command: "C:\\tools\\agy.cmd",
      shell: true,
    });
  });
});
