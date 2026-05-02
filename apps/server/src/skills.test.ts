import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { searchSkills } from "./skills.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  rootPath: string,
  skillName: string,
  contents: string,
  nestedFolder?: string,
) {
  const skillDir = nestedFolder
    ? path.join(rootPath, nestedFolder, skillName)
    : path.join(rootPath, skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), contents, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("searchSkills", () => {
  it("prefers workspace skills and extracts frontmatter fields", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();

    await writeSkill(
      path.join(cwd, ".codex", "skills"),
      "agent-browser",
      ["---", "name: agent-browser", "description: Browse and inspect apps", "---"].join("\n"),
    );
    await writeSkill(
      path.join(codexHome, "skills"),
      "agent-browser",
      ["---", "name: agent-browser", "description: Fallback personal copy", "---"].join("\n"),
    );

    const result = await searchSkills({
      cwd,
      query: "agent-browser",
      limit: 10,
      codexHomePath: codexHome,
    });

    expect(result.truncated).toBe(false);
    expect(result.skills).toEqual([
      {
        name: "agent-browser",
        description: "Browse and inspect apps",
        skillPath: path.join(cwd, ".codex", "skills", "agent-browser", "SKILL.md"),
        rootPath: path.join(cwd, ".codex", "skills"),
        source: "workspace",
      },
    ]);
  });

  it("treats dollar-only queries as match-all and discovers nested skill directories", async () => {
    const cwd = await makeTempDir();
    const extraRoot = await makeTempDir();
    const emptyCodexHome = await makeTempDir();

    await writeSkill(path.join(cwd, ".codex", "skills"), "local-review", "# Local review");
    await writeSkill(
      extraRoot,
      "gh-fix-ci",
      ["---", "description: Fix CI failures", "---"].join("\n"),
      "github",
    );

    const result = await searchSkills({
      cwd,
      query: "$",
      limit: 10,
      codexHomePath: emptyCodexHome,
      extraRoots: [extraRoot],
    });

    expect(result.skills.map((skill: { readonly name: string }) => skill.name)).toEqual([
      "local-review",
      "gh-fix-ci",
    ]);
    expect(result.skills[1]).toMatchObject({
      source: "extra-root",
      rootPath: extraRoot,
    });
  });
});
