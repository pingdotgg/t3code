// Reads the macOS client's mirrored lifecycle-title table off disk to fail on
// drift; plain node fs is the whole point here, not an Effect resource.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ToolPresentation } from "@t3tools/contracts";

import {
  TOOL_LIFECYCLE_TITLES,
  canonicalToolTitle,
  deriveToolPresentation,
  parseToolIdentity,
} from "./toolPresentation.ts";

const decodePresentation = Schema.decodeUnknownSync(ToolPresentation);
const driver = Schema.decodeSync(ProviderDriverKind);

describe("parseToolIdentity", () => {
  it("splits the MCP wire name into server and tool", () => {
    expect(parseToolIdentity({ toolName: "mcp__linear__create_issue" })).toEqual({
      surface: "mcp",
      provenance: {
        origin: "mcp",
        toolName: "mcp__linear__create_issue",
        serverName: "linear",
        displayName: "create_issue",
      },
    });
  });

  it("keeps a name that merely contains 'create' as a builtin-shaped tool, not a file change", () => {
    // ClaudeAdapter's substring classifier calls `mcp__x__create_issue` a
    // file_change; identity parsing must not repeat that.
    const identity = parseToolIdentity({ toolName: "mcp__github__create_pull_request" });
    expect(identity.surface).toBe("mcp");
    expect(identity.provenance.serverName).toBe("github");
  });

  it("resolves a skill invocation from the Skill tool input", () => {
    expect(parseToolIdentity({ toolName: "Skill", toolInput: { skill: "deep-research" } })).toEqual(
      {
        surface: "skill",
        provenance: {
          origin: "skill",
          toolName: "Skill",
          skillName: "deep-research",
          displayName: "deep-research",
        },
      },
    );
  });

  it("attributes a plugin-scoped skill to its plugin", () => {
    expect(
      parseToolIdentity({ toolName: "Skill", toolInput: { skill: "caveman:cavecrew" } }),
    ).toEqual({
      surface: "skill",
      provenance: {
        origin: "plugin",
        toolName: "Skill",
        pluginName: "caveman",
        skillName: "cavecrew",
        displayName: "cavecrew",
      },
    });
  });

  it("reads Codex's typed MCP item instead of the tool name", () => {
    expect(
      parseToolIdentity({
        data: { item: { type: "mcpToolCall", server: "linear", tool: "search" } },
      }),
    ).toEqual({
      surface: "mcp",
      provenance: {
        origin: "mcp",
        toolName: "linear__search",
        serverName: "linear",
        displayName: "search",
      },
    });
  });

  it("carries the subagent type for Task spawns", () => {
    const identity = parseToolIdentity({
      toolName: "Task",
      toolInput: { subagent_type: "Explore", description: "map the repo" },
    });
    expect(identity.surface).toBe("subagent");
    expect(identity.provenance).toMatchObject({ origin: "subagent", subagentType: "Explore" });
  });

  it("marks unrecognized tools as unknown origin", () => {
    const identity = parseToolIdentity({ toolName: "AcmeDoThing" });
    expect(identity.surface).toBeUndefined();
    expect(identity.provenance).toMatchObject({ origin: "unknown", displayName: "AcmeDoThing" });
  });
});

describe("deriveToolPresentation", () => {
  it("derives a command surface with the command, exit code, and output", () => {
    const presentation = deriveToolPresentation({
      itemType: "command_execution",
      status: "completed",
      title: "Command run",
      data: {
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: { content: [{ type: "text", text: "3 passed" }], exitCode: 0 },
      },
      provider: driver("claudeAgent"),
    });

    expect(presentation.surface).toBe("command");
    expect(presentation.title).toBe("Ran command");
    expect(presentation.subtitle).toBe("pnpm test");
    expect(presentation.state).toBe("succeeded");
    expect(presentation.provenance).toMatchObject({ origin: "builtin", provider: "claudeAgent" });
    expect(presentation.inputs).toEqual([
      { label: "command", value: "pnpm test", kind: "command" },
    ]);
    expect(presentation.result).toMatchObject({ text: "3 passed", exitCode: 0 });
    expect(decodePresentation(presentation)).toBeDefined();
  });

  it("uses the progressive tense for in-flight invocations", () => {
    const runningEdit = deriveToolPresentation({
      itemType: "file_change",
      status: "inProgress",
      data: {
        toolName: "Edit",
        input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
      },
    });
    expect(runningEdit.title).toBe("Changing files");
    expect(runningEdit.state).toBe("running");

    const runningCommand = deriveToolPresentation({
      itemType: "command_execution",
      data: { toolName: "Bash", input: { command: "pnpm test" } },
      fallbackState: "running",
    });
    expect(runningCommand.title).toBe("Running command");

    const runningRead = deriveToolPresentation({
      itemType: "dynamic_tool_call",
      status: "in_progress",
      data: { toolName: "Read", input: { file_path: "/repo/README.md" } },
    });
    expect(runningRead.title).toBe("Reading file");

    const completedEdit = deriveToolPresentation({
      itemType: "file_change",
      status: "completed",
      data: {
        toolName: "Edit",
        input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
      },
    });
    expect(completedEdit.title).toBe("Changed files");
  });

  it("renders a Skill call as a skill surface even though the adapter typed it as a dynamic tool", () => {
    const presentation = deriveToolPresentation({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "Tool call",
      data: {
        toolName: "Skill",
        input: { skill: "caveman:cavecrew", args: "review the diff" },
      },
      provider: driver("claudeAgent"),
    });

    expect(presentation.surface).toBe("skill");
    expect(presentation.title).toBe("Skill: cavecrew");
    expect(presentation.subtitle).toBe("review the diff");
    expect(presentation.state).toBe("running");
    expect(presentation.provenance).toMatchObject({ origin: "plugin", pluginName: "caveman" });
    expect(presentation.result).toBeUndefined();
    expect(decodePresentation(presentation)).toBeDefined();
  });

  it("renders an MCP call with server and tool identity", () => {
    const presentation = deriveToolPresentation({
      itemType: "mcp_tool_call",
      status: "completed",
      data: {
        toolName: "mcp__linear__create_issue",
        input: { title: "Fix crash", teamId: "SER" },
        result: "created SER-1",
      },
      provider: driver("claudeAgent"),
    });

    expect(presentation.surface).toBe("mcp");
    expect(presentation.title).toBe("linear · create_issue");
    expect(presentation.provenance).toMatchObject({ origin: "mcp", serverName: "linear" });
    expect(presentation.inputs).toEqual([
      { label: "title", value: "Fix crash", kind: "text" },
      { label: "teamId", value: "SER", kind: "text" },
    ]);
    expect(presentation.result).toMatchObject({ text: "created SER-1" });
  });

  it("falls back to a generic surface with bounded inputs for unknown tools", () => {
    const presentation = deriveToolPresentation({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "Tool call",
      detail: "AcmeDoThing: {...}",
      data: {
        toolName: "AcmeDoThing",
        input: { widget: "sprocket", count: 3, nested: { a: 1 } },
      },
    });

    expect(presentation.surface).toBe("generic");
    expect(presentation.title).toBe("AcmeDoThing");
    expect(presentation.subtitle).toBe("AcmeDoThing: {...}");
    expect(presentation.provenance.origin).toBe("unknown");
    expect(presentation.inputs).toEqual([
      { label: "widget", value: "sprocket", kind: "text" },
      { label: "count", value: "3", kind: "text" },
      { label: "nested", value: '{"a":1}', kind: "json" },
    ]);
    expect(decodePresentation(presentation)).toBeDefined();
  });

  it("keeps a usable title when there is no tool name at all", () => {
    const presentation = deriveToolPresentation({
      itemType: "dynamic_tool_call",
      data: {},
      fallbackState: "running",
    });

    expect(presentation.surface).toBe("generic");
    expect(presentation.title).toBe("Tool");
    expect(presentation.provenance.origin).toBe("unknown");
    expect(presentation.inputs).toEqual([]);
  });

  it("derives file paths for edits and reads", () => {
    const edit = deriveToolPresentation({
      itemType: "file_change",
      status: "completed",
      data: {
        toolName: "Edit",
        input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
      },
    });
    expect(edit.surface).toBe("file_change");
    expect(edit.subtitle).toBe("/repo/src/app.ts");
    expect(edit.inputs).toEqual([{ label: "path", value: "/repo/src/app.ts", kind: "path" }]);
    expect(edit.result?.paths).toEqual(["/repo/src/app.ts"]);

    const read = deriveToolPresentation({
      itemType: "dynamic_tool_call",
      status: "completed",
      data: { toolName: "Read", input: { file_path: "/repo/README.md" } },
    });
    expect(read.surface).toBe("file_read");
    expect(read.subtitle).toBe("/repo/README.md");
  });

  it("marks a declined tool as denied", () => {
    const presentation = deriveToolPresentation({
      itemType: "command_execution",
      status: "declined",
      data: { toolName: "Bash", input: { command: "rm -rf /" } },
    });

    expect(presentation.state).toBe("declined");
    expect(presentation.permission).toEqual({ decision: "denied" });
  });

  it("classifies ACP tool calls that only carry a kind", () => {
    const presentation = deriveToolPresentation({
      itemType: "command_execution",
      status: "completed",
      title: "Terminal",
      data: { kind: "execute", command: "ls -la", rawOutput: "a\nb <exited with exit code 0>" },
      provider: driver("grok"),
    });

    expect(presentation.surface).toBe("command");
    expect(presentation.subtitle).toBe("ls -la");
    expect(presentation.result?.text).toBe("a\nb");
  });
});

describe("tool lifecycle titles", () => {
  it("folds both halves of every lifecycle pair onto one identity", () => {
    for (const [surface, titles] of Object.entries(TOOL_LIFECYCLE_TITLES)) {
      expect(canonicalToolTitle(titles.inProgress)).toBe(surface);
      expect(canonicalToolTitle(titles.settled)).toBe(surface);
    }
  });

  it("leaves titles it never rewrites as their own identity", () => {
    expect(canonicalToolTitle("Skill: brainstorm")).toBe("skill: brainstorm");
    expect(canonicalToolTitle("linear · create_issue")).toBe("linear · create_issue");
  });

  it("keeps the macOS mirror of the lifecycle titles in sync", () => {
    // The macOS client folds a completion onto its running row by title when
    // the activity carries no `toolCallId`, so it mirrors this table in Swift.
    // A pair added or reworded here and not there silently brings back the
    // duplicate row that never stops running.
    const swiftPath = NodeURL.fileURLToPath(
      new URL("../../../apps/mac/Sources/SergeCodeMac/Model/Entities.swift", import.meta.url),
    );
    const source = NodeFS.readFileSync(swiftPath, "utf8");
    const literal = /static let lifecycleTitles: \[String: String\] = \[([\s\S]*?)\n {4}\]/u.exec(
      source,
    );
    expect(literal, "ToolLifecycleTitle.lifecycleTitles not found in Entities.swift").toBeTruthy();

    const mirrored = new Map<string, string>();
    for (const [, title, surface] of (literal?.[1] ?? "").matchAll(/"([^"]+)": "([^"]+)"/gu)) {
      mirrored.set(title as string, surface as string);
    }
    const expected = new Map<string, string>();
    for (const [surface, titles] of Object.entries(TOOL_LIFECYCLE_TITLES)) {
      expected.set(titles.inProgress.toLowerCase(), surface);
      expected.set(titles.settled.toLowerCase(), surface);
    }

    expect(Object.fromEntries([...mirrored].sort())).toEqual(
      Object.fromEntries([...expected].sort()),
    );
  });
});
