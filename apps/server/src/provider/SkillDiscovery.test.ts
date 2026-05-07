import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Effect } from "effect";
import { afterEach, describe, it } from "vitest";

import {
  discoverClaudeSkills,
  discoverSkillsFromRoots,
  mergeProviderSkills,
  parseSkillMarkdown,
} from "./SkillDiscovery.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, contents: string): string {
  const skillDir = NodePath.join(root, name);
  NodeFS.mkdirSync(skillDir, { recursive: true });
  const skillPath = NodePath.join(skillDir, "SKILL.md");
  NodeFS.writeFileSync(skillPath, contents, "utf8");
  return skillPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { force: true, recursive: true });
  }
});

describe("parseSkillMarkdown", () => {
  it("parses minimal SKILL.md metadata", () => {
    const skill = parseSkillMarkdown({
      path: NodePath.join("skills", "review", "SKILL.md"),
      scope: "project",
      invocationPrefix: "$",
      contents: [
        "---",
        "name: review",
        "description: Review changes for correctness.",
        "display_name: Review Changes",
        "---",
        "",
        "## Instructions",
        "Inspect the diff.",
      ].join("\n"),
    });

    assert.deepStrictEqual(skill, {
      name: "review",
      description: "Review changes for correctness.",
      shortDescription: "Review changes for correctness.",
      displayName: "Review Changes",
      path: NodePath.join("skills", "review", "SKILL.md"),
      scope: "project",
      enabled: true,
      invocationPrefix: "$",
    });
  });

  it("falls back to directory name and body text", () => {
    const skill = parseSkillMarkdown({
      path: NodePath.join("skills", "release-helper", "SKILL.md"),
      scope: "user",
      invocationPrefix: "/",
      contents: ["# Release Helper", "", "Prepare release notes from merged pull requests."].join(
        "\n",
      ),
    });

    assert.equal(skill?.name, "release-helper");
    assert.equal(skill?.description, "Prepare release notes from merged pull requests.");
    assert.equal(skill?.invocationPrefix, "/");
  });

  it("ignores malformed frontmatter safely", () => {
    const skill = parseSkillMarkdown({
      path: NodePath.join("skills", "broken", "SKILL.md"),
      scope: "project",
      invocationPrefix: "$",
      contents: ["---", "name: invalid", "description: missing close", "", "Body"].join("\n"),
    });

    assert.equal(skill?.name, "broken");
    assert.equal(skill?.enabled, true);
  });

  it("marks non-user-invocable skills disabled", () => {
    const skill = parseSkillMarkdown({
      path: NodePath.join("skills", "background-context", "SKILL.md"),
      scope: "project",
      invocationPrefix: "$",
      contents: [
        "---",
        "name: background-context",
        "description: Internal context.",
        "user-invocable: false",
        "---",
      ].join("\n"),
    });

    assert.equal(skill?.enabled, false);
  });
});

describe("skill discovery", () => {
  it("discovers Claude project and user skills", async () => {
    const repo = makeTempDir("t3-claude-skills-repo-");
    const home = makeTempDir("t3-claude-skills-home-");
    NodeFS.mkdirSync(NodePath.join(repo, ".git"));
    writeSkill(
      NodePath.join(repo, ".claude", "skills"),
      "summarize-changes",
      ["---", "name: summarize-changes", "description: Summarize changes.", "---"].join("\n"),
    );
    writeSkill(
      NodePath.join(home, ".claude", "skills"),
      "personal-review",
      ["---", "name: personal-review", "description: Review personal workflow.", "---"].join("\n"),
    );

    const skills = await Effect.runPromise(discoverClaudeSkills({ cwd: repo, homeDir: home }));

    assert.deepStrictEqual(
      skills.map((skill) => [skill.name, skill.scope, skill.invocationPrefix]).toSorted(),
      [
        ["personal-review", "user", "/"],
        ["summarize-changes", "project", "/"],
      ],
    );
  });

  it("deduplicates provider-native skills before discovered skills", () => {
    const nativePath = NodePath.resolve("shared", "SKILL.md");
    const merged = mergeProviderSkills(
      [
        {
          name: "review",
          path: nativePath,
          scope: "project",
          enabled: true,
          invocationPrefix: "$",
        },
      ],
      [
        {
          name: "review",
          path: NodePath.resolve("other", "SKILL.md"),
          scope: "project",
          enabled: true,
          invocationPrefix: "$",
        },
        {
          name: "unique",
          path: NodePath.resolve("unique", "SKILL.md"),
          scope: "project",
          enabled: true,
          invocationPrefix: "$",
        },
      ],
    );

    assert.deepStrictEqual(
      merged.map((skill) => skill.name),
      ["review", "unique"],
    );
  });

  it("skips unreadable skill files without failing discovery", async () => {
    const root = makeTempDir("t3-skills-unreadable-");
    writeSkill(root, "good", ["---", "name: good", "description: Good skill.", "---"].join("\n"));
    NodeFS.mkdirSync(NodePath.join(root, "bad", "SKILL.md"), { recursive: true });

    const skills = await Effect.runPromise(
      discoverSkillsFromRoots({
        roots: [{ path: root, scope: "project" }],
        invocationPrefix: "$",
      }),
    );

    assert.deepStrictEqual(
      skills.map((skill) => skill.name),
      ["good"],
    );
  });
});
