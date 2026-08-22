// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert } from "@effect/vitest";
import { describe, it } from "vite-plus/test";

import { discoverOpenCode2Skills } from "./OpenCode2Skills.ts";

function writeSkill(skillsDir: string, directoryName: string, contents: string): void {
  const skillDir = NodePath.join(skillsDir, directoryName);
  NodeFS.mkdirSync(skillDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(skillDir, "SKILL.md"), contents);
}

function makeWorkspace(): { home: string; workspace: string } {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode2-skills-"));
  const home = NodePath.join(tempDir, "home");
  const workspace = NodePath.join(tempDir, "workspace");
  NodeFS.mkdirSync(NodePath.join(workspace, ".git"), { recursive: true });
  return { home, workspace };
}

describe("discoverOpenCode2Skills", () => {
  it("discovers global and project skills with frontmatter metadata", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "review",
      ["---", "name: review", "description: Review the diff.", "---", "", "# Review"].join("\n"),
    );
    writeSkill(
      NodePath.join(workspace, ".opencode", "skills"),
      "deploy",
      ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });

    assert.deepEqual(skills, [
      {
        name: "deploy",
        path: NodePath.join(workspace, ".opencode", "skills", "deploy", "SKILL.md"),
        enabled: true,
        scope: "project",
        description: "Deploy the app.",
      },
      {
        name: "review",
        path: NodePath.join(home, ".config", "opencode", "skills", "review", "SKILL.md"),
        enabled: true,
        scope: "user",
        description: "Review the diff.",
      },
    ]);
  });

  it("loads Claude and agent compatibility directories", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".claude", "skills"),
      "claude-user",
      ["---", "name: claude-user", "description: Claude user skill.", "---"].join("\n"),
    );
    writeSkill(
      NodePath.join(workspace, ".agents", "skills"),
      "agents-project",
      ["---", "name: agents-project", "description: Agents project skill.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills.map((skill) => skill.name).toSorted(), [
      "agents-project",
      "claude-user",
    ]);
  });

  it("prefers project .opencode skills over global OpenCode skills", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "deploy",
      ["---", "name: deploy", "description: Global deploy.", "---"].join("\n"),
    );
    writeSkill(
      NodePath.join(workspace, ".opencode", "skills"),
      "deploy",
      ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills, [
      {
        name: "deploy",
        path: NodePath.join(workspace, ".opencode", "skills", "deploy", "SKILL.md"),
        enabled: true,
        scope: "project",
        description: "Project deploy.",
      },
    ]);
  });

  it("prefers OPENCODE_CONFIG_DIR over the default config home", () => {
    const { home, workspace } = makeWorkspace();
    const configDir = NodePath.join(NodePath.dirname(home), "opencode-config");
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "ignored",
      ["---", "name: ignored", "description: Default home skill.", "---"].join("\n"),
    );
    writeSkill(
      NodePath.join(configDir, "skills"),
      "custom",
      ["---", "name: custom", "description: Config dir skill.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, {
      HOME: home,
      OPENCODE_CONFIG_DIR: configDir,
    });
    assert.deepEqual(skills, [
      {
        name: "custom",
        path: NodePath.join(configDir, "skills", "custom", "SKILL.md"),
        enabled: true,
        scope: "user",
        description: "Config dir skill.",
      },
    ]);
  });

  it("does not scan the process home when HOME is omitted from the environment", () => {
    const { workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(workspace, ".opencode", "skills"),
      "only-project",
      ["---", "name: only-project", "description: Project only.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, {});
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["only-project"],
    );
  });

  it("skips malformed frontmatter", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "broken",
      ["---", "name: [unterminated", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills, []);
  });

  it("uses the path id and keeps frontmatter name as displayName", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "git-release",
      ["---", "name: Git Release", "description: Prepare a release.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills, [
      {
        name: "git-release",
        displayName: "Git Release",
        path: NodePath.join(home, ".config", "opencode", "skills", "git-release", "SKILL.md"),
        enabled: true,
        scope: "user",
        description: "Prepare a release.",
      },
    ]);
  });

  it("discovers nested SKILL.md and root-level markdown files", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(workspace, ".opencode", "skills", "teams"),
      "release",
      ["---", "description: Nested release skill.", "---"].join("\n"),
    );
    NodeFS.mkdirSync(NodePath.join(workspace, ".opencode", "skills"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(workspace, ".opencode", "skills", "git-release.md"),
      ["---", "description: Flat release skill.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills.map((skill) => skill.name).toSorted(), ["git-release", "release"]);
  });

  it("hides skills with slash: false from the picker catalog", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "hidden",
      ["---", "description: Hidden.", "slash: false", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills, []);
  });

  it("loads extra local directories from the skills config array", () => {
    const { home, workspace } = makeWorkspace();
    const extra = NodePath.join(home, "shared-skills");
    writeSkill(extra, "team-review", ["---", "description: Team review.", "---"].join("\n"));
    NodeFS.mkdirSync(NodePath.join(home, ".config", "opencode"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ skills: [extra] }),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["team-review"],
    );
  });

  it("ignores HTTP catalog URLs in the skills config array", () => {
    const { home, workspace } = makeWorkspace();
    NodeFS.mkdirSync(NodePath.join(home, ".config", "opencode"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ skills: ["https://example.com/opencode/skills/"] }),
    );

    const skills = discoverOpenCode2Skills(workspace, { HOME: home });
    assert.deepEqual(skills, []);
  });

  it("omits project skills when cwd is not provided", () => {
    const { home, workspace } = makeWorkspace();
    writeSkill(
      NodePath.join(home, ".config", "opencode", "skills"),
      "review",
      ["---", "description: User review.", "---"].join("\n"),
    );
    writeSkill(
      NodePath.join(workspace, ".opencode", "skills"),
      "deploy",
      ["---", "description: Project deploy.", "---"].join("\n"),
    );

    const skills = discoverOpenCode2Skills(undefined, { HOME: home });
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["review"],
    );
  });
});
