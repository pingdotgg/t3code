// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  GROK_WORKFLOW_CONTROL_COMMANDS,
  parseGrokWorkflowScriptMeta,
  readGrokWorkflowSlashCommands,
} from "./GrokWorkflowCommands.ts";

describe("parseGrokWorkflowScriptMeta", () => {
  it("reads name and description from the Rhai meta block", () => {
    const meta = parseGrokWorkflowScriptMeta(
      `let meta = #{
  name: "review-changes",
  description: "Review the latest diff"
};
agent("review", "look at the diff")
`,
    );
    expect(meta).toEqual({
      name: "review-changes",
      description: "Review the latest diff",
    });
  });

  it("falls back to the filename when meta has no name", () => {
    expect(parseGrokWorkflowScriptMeta('agent("hello", "there")', "t1")).toEqual({
      name: "t1",
      description: undefined,
    });
  });

  it("rejects path-like names", () => {
    expect(
      parseGrokWorkflowScriptMeta(`let meta = #{ name: "../escape" };`, "safe"),
    ).toBeUndefined();
  });
});

describe("readGrokWorkflowSlashCommands", () => {
  it("includes pause/resume/stop and project scripts override user scripts", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-wf-"));
    const userDir = NodePath.join(root, "home", ".grok", "workflows");
    const projectDir = NodePath.join(root, "project", ".grok", "workflows");
    NodeFS.mkdirSync(userDir, { recursive: true });
    NodeFS.mkdirSync(projectDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(userDir, "review-changes.rhai"),
      `let meta = #{ name: "review-changes", description: "user copy" };\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(projectDir, "review-changes.rhai"),
      `let meta = #{ name: "review-changes", description: "project copy" };\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(projectDir, "nowah-web-e2e.rhai"),
      `let meta = #{ name: "nowah-web-e2e", description: "Write locked Playwright specs" };\n`,
    );

    const commands = readGrokWorkflowSlashCommands({
      homeDir: NodePath.join(root, "home"),
      projectRoot: NodePath.join(root, "project"),
    });
    expect(commands.slice(0, 3)).toEqual([...GROK_WORKFLOW_CONTROL_COMMANDS]);
    expect(commands).toContainEqual({
      name: "workflow review-changes",
      description: "project copy",
    });
    expect(commands).toContainEqual({
      name: "workflow nowah-web-e2e",
      description: "Write locked Playwright specs",
    });
  });

  it("reads only the capped prefix of an oversized workflow script", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-wf-cap-"));
    const userDir = NodePath.join(root, ".grok", "workflows");
    NodeFS.mkdirSync(userDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(userDir, "huge.rhai"),
      `let meta = #{ name: "huge", description: "from prefix" };\n` + "x".repeat(80 * 1024),
    );
    const commands = readGrokWorkflowSlashCommands({ homeDir: root });
    expect(commands).toContainEqual({
      name: "workflow huge",
      description: "from prefix",
    });
  });
});
