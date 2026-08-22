// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { readResolvedSkillFile } from "./SkillFileAccess.ts";

describe("readResolvedSkillFile", () => {
  it("reads text inside the resolved skill directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-"));
    await NodeFSP.mkdir(NodePath.join(root, "references"));
    await NodeFSP.writeFile(NodePath.join(root, "SKILL.md"), "# Skill");
    await NodeFSP.writeFile(NodePath.join(root, "references", "note.md"), "hello");

    const target = { skillName: "review", skillPath: NodePath.join(root, "SKILL.md") };
    await expect(
      Effect.runPromise(readResolvedSkillFile({ ...target, relativePath: "references/note.md" })),
    ).resolves.toMatchObject({ contents: "hello", relativePath: "references/note.md" });
  });

  it("rejects traversal and symlink escapes", async () => {
    const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-"));
    const root = NodePath.join(parent, "skill");
    await NodeFSP.mkdir(root);
    await NodeFSP.writeFile(NodePath.join(root, "SKILL.md"), "# Skill");
    await NodeFSP.writeFile(NodePath.join(parent, "secret.md"), "secret");
    await NodeFSP.symlink(NodePath.join(parent, "secret.md"), NodePath.join(root, "linked.md"));
    const target = { skillName: "review", skillPath: NodePath.join(root, "SKILL.md") };

    await expect(
      Effect.runPromise(readResolvedSkillFile({ ...target, relativePath: "../secret.md" })),
    ).rejects.toMatchObject({ failure: "path_outside_skill" });
    await expect(
      Effect.runPromise(readResolvedSkillFile({ ...target, relativePath: "linked.md" })),
    ).rejects.toMatchObject({ failure: "path_outside_skill" });
  });
});
