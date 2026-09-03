import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  resolveViewedImageAsset,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  type WorkLogPresentationEntry,
  workEntryViewedImagePath,
} from "./presentation.js";

describe("summarizeToolGroup", () => {
  it("deduplicates named sources ahead of ordinary actions", () => {
    const source = { key: "browser-use:chrome", name: "Chrome", kind: "integration" as const };
    expect(
      summarizeToolGroup([
        { label: "Open page", tone: "tool", toolSource: source },
        { label: "Inspect page", tone: "tool", toolSource: source },
        {
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          command: "git status",
        },
      ]),
    ).toBe("Used Chrome integration and ran 1 command");
  });

  it("omits the integration suffix for special browser and computer sources", () => {
    expect(
      summarizeToolGroup([
        {
          label: "Inspect page",
          tone: "tool",
          toolSource: { key: "browser-use", name: "Browser", kind: "browser" },
        },
        {
          label: "Click",
          tone: "tool",
          toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
        },
      ]),
    ).toBe("Used Browser and Computer Use");
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
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
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it.each([
    ["inProgress", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
    ["declined", "Declined to click in the preview browser"],
    ["stopped", "Stopped clicking in the preview browser"],
    ["unknown", "Clicking in the preview browser"],
  ])("describes the tool's own %s state", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.preview_click",
        toolLifecycleStatus,
      }),
    ).toEqual({ displayName, icon: "browser" });
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
    ["preview_type", "Typing in the preview browser", "Typed in the preview browser"],
    [
      "preview_set_appearance",
      "Setting preview browser appearance",
      "Set preview browser appearance",
    ],
    [
      "preview_snapshot",
      "Taking a snapshot of the preview page",
      "Took a snapshot of the preview page",
    ],
    [
      "preview_recording_stop",
      "Stopping recording the preview browser",
      "Stopped recording the preview browser",
    ],
    ["t3_thread_read", "Reading a T3 thread", "Read a T3 thread"],
    ["t3_thread_send", "Sending to a T3 thread", "Sent to a T3 thread"],
    [
      "t3_worktree_handoff",
      "Handing off thread to a git worktree",
      "Handed off thread to a git worktree",
    ],
  ])("preserves verb forms and the rest of %s's label", (tool, running, completed) => {
    const entry = { label: `t3-code.${tool}` };
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "inProgress" })
        ?.displayName,
    ).toBe(running);
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe(completed);
  });

  it("keeps T3 branding for non-browser tools and falls back to the original tool label", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "mcp__t3_code__task_status",
        toolTitle: "Check the child task",
      }),
    ).toEqual({ displayName: "Getting delegated task status", icon: "t3-code" });
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
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

describe("browser group summaries", () => {
  const browserEntry: WorkLogPresentationEntry = {
    label: "MCP tool call",
    toolData: { server: "t3-code", tool: "preview_click" },
    itemType: "mcp_tool_call",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };
  const commandEntry: WorkLogPresentationEntry = {
    label: "Ran command",
    command: "/bin/bash -lc 'vp test run'",
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };

  it.each([1, 18])("counts %s browser calls separately from generic tools", (count) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      ...browserEntry,
      toolCallId: `browser-${index}`,
    }));
    expect(summarizeToolGroup(entries)).toBe(
      `Used browser ${count} ${count === 1 ? "time" : "times"}`,
    );
    expect(toolGroupSummaryKind(entries)).toBe("browser");
  });

  it("combines command and browser counts in a single sentence", () => {
    const entries = [
      ...Array.from({ length: 4 }, () => commandEntry),
      ...Array.from({ length: 15 }, () => browserEntry),
    ];
    expect(summarizeToolGroup(entries)).toBe("Ran 4 commands and used browser 15 times");
    expect(toolGroupSummaryKind(entries)).toBe("mixed");
  });

  it("preserves first-seen action ordering alongside non-browser tools", () => {
    expect(
      summarizeToolGroup([
        browserEntry,
        commandEntry,
        {
          ...browserEntry,
          toolData: { server: "t3-code", tool: "task_status" },
        },
      ]),
    ).toBe("Used browser 1 time, ran 1 command, and used 1 tool");
  });

  it("recognizes Claude browser identity without treating script metadata as a shell command", () => {
    expect(
      summarizeToolGroup([
        {
          ...browserEntry,
          command: "node inspect-page.js",
          toolData: { toolName: "mcp__t3_code__preview_evaluate" },
        },
      ]),
    ).toBe("Used browser 1 time");
  });

  it("keeps foreign tools and web searches out of the browser count", () => {
    expect(
      summarizeToolGroup([
        browserEntry,
        {
          ...browserEntry,
          label: "preview_click",
          toolData: { server: "another-server", tool: "preview_click" },
        },
        { label: "Search", tone: "tool", itemType: "web_search" },
      ]),
    ).toBe("Used browser 1 time, used 1 tool, and searched the web 1 time");
  });

  it("keeps browser screenshots in the browser count while preserving their image path", () => {
    const entry = { ...browserEntry, viewedImagePath: "/workspace/page.png" };
    expect(summarizeToolGroup([entry])).toBe("Used browser 1 time");
    expect(workEntryViewedImagePath(entry)).toBe("/workspace/page.png");
  });
});

describe("command work-log details", () => {
  it("extracts Claude result blocks and projected output", () => {
    expect(
      extractCommandOutputText({
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\nsecond");
    expect(extractCommandOutputText({ rawOutput: { content: "projected summary" } })).toBe(
      "projected summary",
    );
  });

  it("only removes a detail with the matching tool-name prefix", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "warning: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(false);
  });

  it("treats an ingestion-truncated echo of a long command as a repeat", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const truncated = `Bash: ${command}`.slice(0, 177) + "...";
    expect(
      commandDetailRepeatsCommand({
        detail: truncated,
        command,
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello...",
        command: "printf goodbye",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf goodbye" },
      }),
    ).toBe(false);
  });

  it("treats ACP command echoes as synthetic even without a tool kind", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { toolCallId: "tool-1", command: "pnpm test" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { command: "pnpm test" },
      }),
    ).toBe(false);
  });
});

describe("workEntryViewedImagePath", () => {
  const entry = { label: "Read", tone: "tool" } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        viewedImagePath: " /workspace/reference image.webp ",
      }),
    ).toBe("/workspace/reference image.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("toolGroupAction", () => {
  it("groups legacy Claude image reads with other reads", () => {
    expect(
      toolGroupAction({
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        viewedImagePath: "/workspace/reference.png",
      }),
    ).toBe("read");
  });
});

describe("resolveViewedImageAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("serves t3 attachment paths in place like any other host path", () => {
    const path = "/Users/demo/.t3/dev/attachments/11111111-1111-4111-8111-111111111111.png";
    expect(resolveViewedImageAsset(path, { threadId, workspaceRoot: "/workspace" })).toEqual({
      resource: { _tag: "media-file", threadId, path },
      alt: "11111111-1111-4111-8111-111111111111.png",
      srcFragment: "",
    });
  });

  it("normalizes workspace image sources", () => {
    expect(
      resolveViewedImageAsset("screens/logo.svg?v=2#mark", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "media-file",
        threadId,
        path: "/workspace/screens/logo.svg",
      },
      alt: "logo.svg",
      srcFragment: "#mark",
    });
    expect(resolveViewedImageAsset("https://example.com/logo.png", { threadId })).toBeNull();
  });
});
