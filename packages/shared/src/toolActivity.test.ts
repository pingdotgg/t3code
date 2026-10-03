import { describe, expect, it } from "vite-plus/test";

import {
  claudeAgentMessage,
  claudeAgentMessageTitle,
  claudeSkillInvocation,
  classifyToolActivity,
  collectToolFilePaths,
  deriveToolActivityPresentation,
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
  isClaudeAgentMessageItem,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read /tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("formats read and search labels from structured input", () => {
    expect(formatReadToolLabel("src/env.ts")).toBe("Read src/env.ts");
    expect(formatReadToolLabel("src/env.ts", 2)).toBe("Read src/env.ts +2 more");
    expect(formatReadToolLabel("")).toBe("Read file");
    expect(
      formatSearchToolLabel({
        input: { pattern: "TODO", path: "apps/web" },
      }),
    ).toBe("Searched TODO in web");
    expect(
      formatSearchToolLabel({
        input: { glob: "*.ts", path: "/tmp/t3chat-new" },
      }),
    ).toBe("Searched files *.ts in t3chat-new");
    expect(
      formatSearchToolLabel({ rawInput: {}, input: { pattern: "TODO", path: "apps/web" } }),
    ).toBe("Searched TODO in web");
    expect(formatSearchToolLabel({ input: { globPattern: "*.tsx", path: "apps/web" } })).toBe(
      "Searched files *.tsx in web",
    );
    expect(
      formatSearchToolLabel({ input: { pattern: "TODO", glob: "*.ts", path: "apps/web" } }),
    ).toBe("Searched TODO in web");
  });

  it("keeps bare filenames from explicit path fields", () => {
    expect(collectToolFilePaths({ input: { file_path: "README" } })).toEqual(["README"]);
  });

  it("keeps the first non-empty rawInput when a later update is empty", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { path: "src/a.ts", startLine: 4 } });
  });

  it("titles Claude skill calls with the skill they load", () => {
    expect(dynamicToolTitle("Skill", { skill: "full-send" })).toBe("Skill: full-send");
    expect(claudeSkillInvocation("Skill", { skill: "claude-api", args: " pricing " })).toEqual({
      name: "claude-api",
      args: "pricing",
    });
    expect(dynamicToolTitle("Skill", { skill: " " })).toBeUndefined();
    expect(dynamicToolTitle("Read", { skill: "full-send" })).toBeUndefined();
  });

  it("reads Claude agent messages as recorded by Claude Code", () => {
    // Shaped like a real call: the CLI echoes a truncated `content` and the
    // recipient beside the fields the agent wrote.
    const input = {
      to: "aa0c54c7feb61e9a3",
      summary: "Draft the 0.9 release notes",
      message: "## Release notes for 0.9\n\nPlease draft them.",
      type: "message",
      recipient: "aa0c54c7feb61e9a3",
      content: "## Release notes for 0.9\n\nPlease…",
    };
    expect(claudeAgentMessage("SendMessage", input)).toEqual({
      to: "aa0c54c7feb61e9a3",
      summary: "Draft the 0.9 release notes",
      message: "## Release notes for 0.9\n\nPlease draft them.",
      preview: "Draft the 0.9 release notes",
      notifyWhenIdle: false,
    });
    expect(claudeAgentMessageTitle("SendMessage", input)).toBe("Message to agent aa0c54c");
    expect(claudeAgentMessageTitle("SendMessage", input, "Release notes writer")).toBe(
      "Message to Release notes writer",
    );
    // Without a summary the collapsed row previews the body's first line.
    expect(
      claudeAgentMessage("SendMessage", { to: "main", message: "## Status\nAll green." })?.preview,
    ).toBe("Status");
    // The body keeps its Markdown indentation; the preview skips to the first text.
    const indented = claudeAgentMessage("SendMessage", { to: "main", message: "\n    npm test\n" });
    expect(indented?.message).toBe("\n    npm test\n");
    expect(indented?.preview).toBe("npm test");
    expect(
      claudeAgentMessage("SendMessage", { to: "main", message: "  " })?.message,
    ).toBeUndefined();
    expect(claudeAgentMessage("Read", input)).toBeUndefined();
    // Structured protocol messages keep the generic tool view.
    expect(
      claudeAgentMessage("SendMessage", { to: "x", message: { type: "shutdown_request" } }),
    ).toBeUndefined();
  });

  it("names agent message recipients the way the agent addressed them", () => {
    const titleFor = (input: Record<string, unknown>) =>
      claudeAgentMessageTitle("SendMessage", { message: "hi", ...input });
    expect(titleFor({ to: "main" })).toBe("Message to main agent");
    expect(titleFor({ to: "release-bot [c9ede1]" })).toBe("Message to release-bot");
    expect(titleFor({ to: "uds:/tmp/cc-socks/54926.sock" })).toBe("Message to another session");
    expect(titleFor({ type: "broadcast" })).toBe("Message to everyone");
    expect(titleFor({})).toBe("Message");
    expect(
      claudeAgentMessageTitle("SendMessage", { to: "docs-writer", notify_when_idle: true }),
    ).toBe("Notify when docs-writer is idle");
  });

  it("counts text and transport-summarized messages, not protocol payloads", () => {
    expect(isClaudeAgentMessageItem("SendMessage", { to: "main", message: "Done." })).toBe(true);
    expect(isClaudeAgentMessageItem("SendMessage", '{ "to": "ghost-agent", …')).toBe(true);
    expect(
      isClaudeAgentMessageItem("SendMessage", {
        to: "researcher",
        message: { type: "shutdown_request" },
      }),
    ).toBe(false);
    expect(isClaudeAgentMessageItem("send_message", { message: "hi" })).toBe(false);
  });
});
