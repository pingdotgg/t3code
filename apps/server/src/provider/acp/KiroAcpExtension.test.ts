import { describe, expect, it } from "@effect/vitest";

import {
  classifyKiroExtensionNotification,
  extractKiroTodoPlan,
  isKiroTodoToolCall,
} from "./KiroAcpExtension.ts";

/** Announcement Kiro sends when it starts a `todo_list create`. */
const TODO_CREATE_ANNOUNCEMENT = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "toolu_bdrk_01BpqzwG872CmxNJ4y1YYc2Q",
    title: "Creating task list: Two-step placeholder list",
    rawInput: {
      command: "create",
      task_list_description: "Two-step placeholder list",
      tasks: [{ task_description: "step one" }, { task_description: "step two" }],
      __tool_use_purpose: "Create the two-step todo list the user asked for.",
    },
    _meta: { kiro: { toolName: "todo_list" } },
  },
};

/** Result Kiro reports once the command has run. */
const TODO_CREATE_RESULT = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_bdrk_01BpqzwG872CmxNJ4y1YYc2Q",
    kind: "other",
    status: "completed",
    rawInput: TODO_CREATE_ANNOUNCEMENT.update.rawInput,
    rawOutput: {
      items: [
        {
          Json: {
            tasks: [
              { id: "1", task_description: "step one", completed: false },
              { id: "2", task_description: "step two", completed: false },
            ],
            description: "Two-step placeholder list",
            context: [],
            modified_files: [],
          },
        },
      ],
    },
  },
};

const TODO_COMPLETE_RESULT = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_bdrk_01Gc7qfjJesqgSjS3XpncLDK",
    status: "completed",
    rawInput: { command: "complete", completed_task_ids: ["1"] },
    rawOutput: {
      items: [
        {
          Json: {
            tasks: [
              { id: "1", task_description: "step one", completed: true },
              { id: "2", task_description: "step two", completed: false },
            ],
            description: "Two-step placeholder list",
          },
        },
      ],
    },
  },
};

const SHELL_TOOL_CALL = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "toolu_shell",
    title: "Running: echo hello",
    kind: "execute",
    rawInput: { command: "echo hello" },
    _meta: { kiro: { toolName: "shell" } },
  },
};

describe("isKiroTodoToolCall", () => {
  it("recognises the task-list tool by its Kiro metadata", () => {
    expect(isKiroTodoToolCall(TODO_CREATE_ANNOUNCEMENT)).toBe(true);
  });

  it("ignores other tools and unrecognised payloads", () => {
    expect(isKiroTodoToolCall(SHELL_TOOL_CALL)).toBe(false);
    // The result notification carries no _meta, so detection relies on the
    // announcement; the extractor is still safe to call on it.
    expect(isKiroTodoToolCall(TODO_CREATE_RESULT)).toBe(false);
    expect(isKiroTodoToolCall(undefined)).toBe(false);
    expect(isKiroTodoToolCall("nonsense")).toBe(false);
    expect(isKiroTodoToolCall({ update: { _meta: { kiro: {} } } })).toBe(false);
  });
});

describe("extractKiroTodoPlan", () => {
  it("shows the requested steps as pending while the call is only announced", () => {
    expect(extractKiroTodoPlan(TODO_CREATE_ANNOUNCEMENT)).toEqual({
      explanation: "Two-step placeholder list",
      plan: [
        { step: "step one", status: "pending" },
        { step: "step two", status: "pending" },
      ],
    });
  });

  it("prefers the reported task state once the command has run", () => {
    expect(extractKiroTodoPlan(TODO_COMPLETE_RESULT)).toEqual({
      explanation: "Two-step placeholder list",
      plan: [
        { step: "step one", status: "completed" },
        { step: "step two", status: "pending" },
      ],
    });
  });

  it("never invents an in-progress step, since Kiro tracks tasks as done or not", () => {
    const plan = extractKiroTodoPlan(TODO_CREATE_RESULT);
    expect(plan?.plan.every((entry) => entry.status === "pending")).toBe(true);
  });

  it("drops blank task descriptions", () => {
    expect(
      extractKiroTodoPlan({
        update: {
          rawInput: {
            tasks: [{ task_description: "  " }, { task_description: "real step" }],
          },
        },
      }),
    ).toEqual({ plan: [{ step: "real step", status: "pending" }] });
  });

  it("returns nothing for payloads without a task list", () => {
    expect(extractKiroTodoPlan(SHELL_TOOL_CALL)).toBeUndefined();
    expect(extractKiroTodoPlan({ update: { rawInput: { command: "list" } } })).toBeUndefined();
    expect(extractKiroTodoPlan({ update: { rawOutput: { items: [] } } })).toBeUndefined();
    expect(extractKiroTodoPlan(undefined)).toBeUndefined();
  });

  it("survives a reshaped payload instead of throwing", () => {
    expect(
      extractKiroTodoPlan({ update: { rawOutput: { items: "not-an-array" } } }),
    ).toBeUndefined();
    expect(
      extractKiroTodoPlan({ update: { rawInput: { tasks: [{ task_description: 42 }] } } }),
    ).toBeUndefined();
  });
});

describe("classifyKiroExtensionNotification", () => {
  it("lists the slash commands Kiro advertises", () => {
    const notification = classifyKiroExtensionNotification("_kiro.dev/commands/available", {
      sessionId: "session-1",
      commands: [
        { name: "/agent", description: "Select or list available agents", meta: { local: true } },
        { name: "/clear", description: "Clear conversation history" },
        { name: "  " },
      ],
    });

    assertTag(notification, "AvailableCommands");
    if (notification._tag === "AvailableCommands") {
      expect(notification.commandNames).toEqual(["/agent", "/clear"]);
    }
  });

  it("names an initialized MCP server", () => {
    const notification = classifyKiroExtensionNotification("_kiro.dev/mcp/server_initialized", {
      sessionId: "session-1",
      serverName: "vg-ai",
    });

    assertTag(notification, "McpServerInitialized");
    if (notification._tag === "McpServerInitialized") {
      expect(notification.serverName).toBe("vg-ai");
    }
  });

  it("surfaces an MCP authorization URL under any of its plausible field names", () => {
    for (const field of ["url", "authorizationUrl", "oauthUrl"] as const) {
      const notification = classifyKiroExtensionNotification("_kiro.dev/mcp/oauth_request", {
        sessionId: "session-1",
        serverName: "github",
        [field]: "https://example.test/oauth",
      });

      assertTag(notification, "McpAuthorizationRequired");
      if (notification._tag === "McpAuthorizationRequired") {
        expect(notification.url).toBe("https://example.test/oauth");
        expect(notification.serverName).toBe("github");
      }
    }
  });

  it("reports Kiro's usage numbers without pretending they are token counts", () => {
    const notification = classifyKiroExtensionNotification("_kiro.dev/metadata", {
      sessionId: "session-1",
      contextUsagePercentage: 3.11,
      meteringUsage: [{ value: 0.237, unit: "credit", unitPlural: "credits" }],
      turnDurationMs: 4028,
    });

    assertTag(notification, "UsageReport");
    if (notification._tag === "UsageReport") {
      expect(notification.contextUsagePercentage).toBe(3.11);
      expect(notification.turnDurationMs).toBe(4028);
    }
  });

  it("classifies the remaining observed notifications", () => {
    expect(
      classifyKiroExtensionNotification("_kiro.dev/session/update", {
        update: { sessionUpdate: "tool_call_chunk", toolCallId: "t1" },
      })._tag,
    ).toBe("ToolCallChunk");
    expect(
      classifyKiroExtensionNotification("_kiro.dev/subagent/list_update", {
        subagents: [],
        pendingStages: [],
      })._tag,
    ).toBe("SubagentListUpdate");
    expect(
      classifyKiroExtensionNotification("_kiro.dev/compaction/status", { status: "compacting" })
        ._tag,
    ).toBe("CompactionStatus");
    expect(
      classifyKiroExtensionNotification("_kiro.dev/clear/status", { status: "cleared" })._tag,
    ).toBe("ClearStatus");
  });

  it("degrades unknown methods and malformed payloads instead of throwing", () => {
    const unknown = classifyKiroExtensionNotification("_kiro.dev/some/future/thing", {
      whatever: true,
    });
    assertTag(unknown, "Unrecognised");
    if (unknown._tag === "Unrecognised") {
      expect(unknown.method).toBe("_kiro.dev/some/future/thing");
    }

    // Reshaped payloads still classify by method, just without detail.
    const commands = classifyKiroExtensionNotification("_kiro.dev/commands/available", {
      commands: "not-an-array",
    });
    assertTag(commands, "AvailableCommands");
    if (commands._tag === "AvailableCommands") {
      expect(commands.commandNames).toEqual([]);
    }
    expect(classifyKiroExtensionNotification("_kiro.dev/metadata", null)._tag).toBe("UsageReport");
    expect(classifyKiroExtensionNotification("_kiro.dev/mcp/oauth_request", "nonsense")._tag).toBe(
      "McpAuthorizationRequired",
    );
  });
});

function assertTag(notification: { readonly _tag: string }, expected: string): void {
  expect(notification._tag).toBe(expected);
}
