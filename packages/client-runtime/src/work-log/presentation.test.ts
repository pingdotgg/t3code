import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  resolveWorkEntryToolPresentation,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
} from "./presentation.js";
import {
  resolveT3McpToolDefinition,
  T3_MCP_TOOL_NAMES,
} from "@t3tools/shared/t3McpToolPresentation";
import { summarizeToolGroup } from "./presentation.js";
import { t3ToolSentence } from "./t3ToolSentences.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output and command: %s", (output) => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: 'rg -n "ENOENT|exit code" logs fixtures',
      structuredPayload: commandItem({ output, exitCode: 0, outputIndicatesFailure: true }),
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  const fill = (status: "inProgress" | "completed", result?: unknown) =>
    resolveWorkEntryToolPresentation({
      label: "conn · fill_credential",
      toolLifecycleStatus: status,
      toolData: {
        server: "conn",
        tool: "fill_credential",
        arguments: { itemId: "abcdefghijklmnopqrstuvwxyz", field: "password" },
        ...(result === undefined ? {} : { result }),
      },
    });

  it("names the field and the outcome of a credential fill", () => {
    expect(fill("inProgress")).toEqual({
      displayName: "Waiting to fill the password",
      icon: "credential",
    });
    expect(fill("completed", { structuredContent: { status: "filled" } })?.displayName).toBe(
      "Filled the password",
    );
    expect(fill("completed", { structuredContent: { status: "denied" } })?.displayName).toBe(
      "Fill denied: password",
    );
    expect(
      fill("completed", { content: [{ type: "text", text: '{"status":"origin_mismatch"}' }] })
        ?.displayName,
    ).toBe("Not filled: the site doesn't match the saved login");
  });

  it("names the site of a credential lookup", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "mcp__conn__request_credentials",
        toolLifecycleStatus: "completed",
        toolData: { toolName: "request_credentials", input: { domain: "github.com" } },
      }),
    ).toEqual({ displayName: "Found saved logins for github.com", icon: "credential" });
  });

  it("presents and summarizes every T3 tool using the same structured identity", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const entry: WorkLogPresentationEntry = {
        id: tool,
        createdAt: "2026-09-19T00:00:00.000Z",
        tone: "tool",
        label: "Custom provider title",
        toolData: { server: "conn", tool },
        toolLifecycleStatus: "completed",
        itemType: "dynamic_tool",
        toolSource: { key: "conn", name: "T3 Code", kind: "integration" },
      };
      const presentation = resolveWorkEntryToolPresentation(entry);
      expect(presentation, tool).not.toBeNull();
      // A thread label that misses its sentence falls back to untranslated English.
      const labels = resolveT3McpToolDefinition(tool)!.labels;
      if (labels[3].includes("thread")) expect(t3ToolSentence(labels), tool).toBeDefined();
      expect(presentation?.displayName, tool).not.toContain(tool);
      const summary = summarizeToolGroup([entry]);
      expect(summary.summary, tool).not.toMatch(/Used (?:1 tool|T3 Code integration)/);
      expect(summary.hasFailure, tool).toBe(false);
      const failed = { ...entry, toolLifecycleStatus: "failed" as const };
      expect(resolveWorkEntryToolPresentation(failed)?.displayName, tool).toMatch(/^Failed to /);
      expect(summarizeToolGroup([failed]).hasFailure, tool).toBe(true);
      expect(summarizeToolGroup([failed]).summary, tool).toMatch(
        /^(?:Tried to |Requested thread creation)/,
      );
    }
  });

  it.each([
    ["conn_project_list", "Listing projects", "Listed projects"],
    ["conn_project_clone", "Cloning a repository", "Cloned a repository"],
    ["conn_project_create", "Registering a project", "Registered a project"],
    ["conn_thread_launch", "Launching a project thread", "Launched a project thread"],
    ["conn_queue_edit", "Editing a queued message", "Edited a queued message"],
    ["conn_pending_request_respond", "Answering pending questions", "Answered pending questions"],
    ["conn_thread_configure", "Using thread model settings", "Used thread model settings"],
    ["conn_thread_fork", "Forking this thread", "Requested a fork of this thread"],
    ["conn_thread_send_attachments", "Sending attachments", "Sent attachments"],
    ["run_scheduled_task_now", "Running a scheduled task", "Requested a run of a scheduled task"],
    ["conn_workflow_stop", "Stopping a workflow", "Requested a stop for a workflow"],
  ])("labels %s through its lifecycle", (tool, running, completed) => {
    expect(resolveWorkEntryToolPresentation({ label: `T3-code.${tool}` })?.displayName).toBe(
      running,
    );
    expect(
      resolveWorkEntryToolPresentation({
        label: `T3-code.${tool}`,
        toolLifecycleStatus: "completed",
      })?.displayName,
    ).toBe(completed);
  });

  it("summarizes workflow stop targets separately from their parent thread", () => {
    const entry = {
      id: "workflow-stop",
      createdAt: "2026-10-07T00:00:00.000Z",
      tone: "tool",
      label: "Custom title",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolData: {
        server: "conn",
        tool: "conn_workflow_stop",
        arguments: { threadId: "parent", subagentId: "workflow-1" },
        result: {},
      },
    } satisfies WorkLogPresentationEntry;
    expect(
      summarizeToolGroup([
        entry,
        entry,
        {
          ...entry,
          toolData: {
            ...entry.toolData,
            arguments: { threadId: "parent", subagentId: "workflow-2" },
          },
        },
        {
          ...entry,
          toolData: {
            ...entry.toolData,
            tool: "conn_thread_interrupt",
            arguments: { threadId: "parent" },
          },
        },
      ]),
    ).toEqual({
      summary: "Requested stops for 2 workflows and requested interrupts for 1 thread",
      hasFailure: false,
    });
  });

  it("summarizes project tools from MCP arguments and results without claiming failed effects", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "Custom title",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolData: {
        server: "conn",
        tool: "conn_project_clone",
        arguments: { url: "https://github.com/acme/repo" },
        result: { cwd: "/tmp/repo" },
      },
    };
    const list = { ...entry, toolData: { server: "conn", tool: "conn_project_list" } };
    expect(summarizeToolGroup([list, entry])).toEqual({
      summary: "Listed projects 1 time and cloned 1 repository",
      hasFailure: false,
    });
    const failed = {
      ...entry,
      toolData: { toolName: "T3-code.conn_project_clone", rawOutput: { isError: true } },
    };
    expect(summarizeToolGroup([entry, failed])).toEqual({
      summary: "Cloned 1 repository",
      hasFailure: true,
    });
  });

  it("does not summarize a foreign structured identity as T3 work", () => {
    const entry: WorkLogPresentationEntry = {
      id: "foreign",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "conn_project_clone",
      toolLifecycleStatus: "completed",
      toolData: { server: "another-server", tool: "conn_project_clone" },
    };
    expect(summarizeToolGroup([entry]).summary).toBe("Used 1 tool");
  });

  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.conn_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
  });
  it.each([
    "mcp__conn__preview_click",
    "mcp__conn__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "conn · preview_click completed",
    "conn/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "conn", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["https://github.com/acme/web/pull/7", "PR #7"],
    ["https://gitlab.com/acme/web/-/merge_requests/7", "MR #7"],
  ])("names a linked change request with its host's term (%s)", (url, target) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.link_pull_request",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { url } },
      })?.displayName,
    ).toMatch(new RegExp(` ${target}$`));
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "conn.unknown_tool",
      "conn.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});
