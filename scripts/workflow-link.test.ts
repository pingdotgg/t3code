// @effect-diagnostics nodeBuiltinImport:off - exercises real symlinks in a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { linkWorkflowSkills } from "./workflow-link.ts";

function fixture() {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-link-"));
  const skillsRoot = NodePath.join(base, "skills");
  const target = NodePath.join(base, "target");
  const addSkill = (source: string, name: string) => {
    const dir = NodePath.join(skillsRoot, source, name);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    return dir;
  };
  return {
    skillsRoot,
    target,
    addSkill,
    [Symbol.dispose]: () => NodeFS.rmSync(base, { recursive: true, force: true }),
  };
}

it("links new skills, drops removed ones, and leaves foreign entries alone", () => {
  using f = fixture();
  const keep = f.addSkill("ak", "keep");
  const gone = f.addSkill("pstack", "gone");
  NodeFS.mkdirSync(NodePath.join(f.target, "mine"), { recursive: true });
  NodeFS.symlinkSync(NodePath.join(f.skillsRoot, "ak", "keep"), NodePath.join(f.target, "taken"));
  f.addSkill("ak", "mine");

  expect(linkWorkflowSkills(f.skillsRoot, [f.target]).skipped).toEqual([
    NodePath.join(f.target, "mine"),
  ]);
  expect(NodeFS.realpathSync(NodePath.join(f.target, "keep"))).toBe(NodeFS.realpathSync(keep));
  expect(NodeFS.existsSync(NodePath.join(f.target, "taken"))).toBe(false);

  NodeFS.rmSync(gone, { recursive: true });
  const second = linkWorkflowSkills(f.skillsRoot, [f.target]);
  expect(second.removed).toEqual([NodePath.join(f.target, "gone")]);
  expect(second.linked).toEqual([]);
  expect(NodeFS.lstatSync(NodePath.join(f.target, "mine")).isDirectory()).toBe(true);
});

it("leaves a target that opted out untouched", () => {
  using f = fixture();
  f.addSkill("ak", "keep");
  NodeFS.mkdirSync(f.target, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(f.target, ".no-workflow-skills"), "");

  expect(linkWorkflowSkills(f.skillsRoot, [f.target]).linked).toEqual([]);
  expect(NodeFS.readdirSync(f.target)).toEqual([".no-workflow-skills"]);
});

it("refuses two skills with the same folder name", () => {
  using f = fixture();
  f.addSkill("ak", "dup");
  f.addSkill("mattpocock", "dup");
  expect(() => linkWorkflowSkills(f.skillsRoot, [f.target])).toThrow(/dup/);
});
