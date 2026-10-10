import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { AGENT_SKILL_FOLDERS } from "@t3tools/provider-core/server/AgentSkillFolders";

import {
  AGENT_INSTRUCTION_FILES,
  claudeManagedInstructionPath,
  instructionRulesFor,
  projectInstructionFile,
} from "./AgentInstructionFiles.ts";

const driver = ProviderDriverKind.make;

describe("AGENT_INSTRUCTION_FILES", () => {
  it("covers every agent that has skill folders, once each", () => {
    const agents = AGENT_INSTRUCTION_FILES.map((rules) => rules.agent);
    expect(new Set(agents).size).toBe(agents.length);
    expect(new Set(agents)).toEqual(new Set(AGENT_SKILL_FOLDERS.map((table) => table.agent)));
  });

  it.each(AGENT_INSTRUCTION_FILES.map((rules) => [rules.agent, rules] as const))(
    "%s describes files it can actually use",
    (_agent, rules) => {
      for (const list of [
        rules.project?.files.map((entry) => entry.name) ?? [],
        rules.home?.files ?? [],
      ]) {
        expect(new Set(list).size).toBe(list.length);
      }
      if (rules.home !== null) {
        // The shared file has to be one the agent reads from its home folder.
        expect(rules.home.files).toContain(rules.home.shared.file);
        // Only an agent that can import a file is joined by an import line.
        expect(rules.home.shared.join === "import").toBe(rules.imports);
      }
    },
  );

  it("limits Claude's setting to the files the setting governs", () => {
    const governed = instructionRulesFor(driver("claudeAgent"))?.project?.files.filter(
      (entry) => entry.governedBy !== undefined,
    );
    expect(governed?.map((entry) => entry.name)).toEqual(["AGENTS.md", ".claude/AGENTS.md"]);
    for (const rules of AGENT_INSTRUCTION_FILES) {
      if (rules.agent === driver("claudeAgent")) continue;
      expect(rules.project?.files.some((entry) => entry.governedBy !== undefined)).toBe(false);
    }
  });
});

describe("instructionRulesFor", () => {
  it("finds a known agent and not an unknown one", () => {
    expect(instructionRulesFor(driver("codex"))?.agent).toBe(driver("codex"));
    expect(instructionRulesFor(driver("ollama"))).toBeUndefined();
  });
});

describe("projectInstructionFile", () => {
  it("returns the rule for a name the agent reads", () => {
    expect(projectInstructionFile(driver("claudeAgent"), "AGENTS.md")).toEqual({
      name: "AGENTS.md",
      governedBy: "claudeProjectInstructions",
    });
    expect(projectInstructionFile(driver("claudeAgent"), "CLAUDE.md")).toEqual({
      name: "CLAUDE.md",
    });
    expect(projectInstructionFile(driver("opencode"), "CLAUDE.md")).toEqual({ name: "CLAUDE.md" });
  });

  it("returns nothing for a name the agent doesn't read", () => {
    expect(projectInstructionFile(driver("codex"), "CLAUDE.md")).toBeUndefined();
    expect(projectInstructionFile(driver("cursor"), "CLAUDE.local.md")).toBeUndefined();
    expect(projectInstructionFile(driver("ollama"), "AGENTS.md")).toBeUndefined();
  });
});

describe("claudeManagedInstructionPath", () => {
  it.each([
    ["darwin", "/Library/Application Support/ClaudeCode/CLAUDE.md"],
    ["linux", "/etc/claude-code/CLAUDE.md"],
    ["win32", "C:\\Program Files\\ClaudeCode\\CLAUDE.md"],
    ["freebsd", undefined],
  ] as const)("%s", (platform, expected) => {
    expect(claudeManagedInstructionPath(platform)).toBe(expected);
  });
});
