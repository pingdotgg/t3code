// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - runs from the update flow, before or without `vp i`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** A target folder holding this file is left alone, e.g. a Claude home shared with other tools. */
export const OPT_OUT_FILE = ".no-workflow-skills";

export interface LinkReport {
  readonly linked: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/** Every skill folder, keyed by its name. Skills sit at `<source>/<skill>` or one level down in a role folder, `<source>/<role>/<skill>`. */
export function listWorkflowSkills(skillsRoot: string): Map<string, string> {
  const skills = new Map<string, string>();
  const add = (dir: string) => {
    const name = NodePath.basename(dir);
    const existing = skills.get(name);
    if (existing) throw new Error(`Skill "${name}" exists in both ${existing} and ${dir}`);
    skills.set(name, dir);
  };
  const subdirs = (dir: string) =>
    NodeFS.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => NodePath.join(dir, entry.name));
  const isSkill = (dir: string) => NodeFS.existsSync(NodePath.join(dir, "SKILL.md"));
  for (const source of subdirs(skillsRoot)) {
    for (const entry of subdirs(source)) {
      if (isSkill(entry)) add(entry);
      else subdirs(entry).filter(isSkill).forEach(add);
    }
  }
  return skills;
}

function readLink(path: string): string | undefined {
  try {
    return NodePath.resolve(NodePath.dirname(path), NodeFS.readlinkSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Converges each target folder to one symlink per workflow skill. Only symlinks that point
 * into `skillsRoot` are ours to replace or delete; anything else in a target is left alone.
 */
export function linkWorkflowSkills(skillsRoot: string, targets: ReadonlyArray<string>): LinkReport {
  const root = NodePath.resolve(skillsRoot);
  const skills = listWorkflowSkills(root);
  const linked: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const target of targets) {
    if (NodeFS.existsSync(NodePath.join(target, OPT_OUT_FILE))) continue;
    NodeFS.mkdirSync(target, { recursive: true });
    for (const entry of NodeFS.readdirSync(target)) {
      const path = NodePath.join(target, entry);
      const destination = readLink(path);
      if (!destination?.startsWith(root + NodePath.sep)) continue;
      if (skills.get(entry) === destination) continue;
      NodeFS.unlinkSync(path);
      removed.push(path);
    }
    for (const [name, dir] of skills) {
      const path = NodePath.join(target, name);
      if (readLink(path) === dir) continue;
      if (NodeFS.existsSync(path) || readLink(path) !== undefined) {
        skipped.push(path);
        continue;
      }
      NodeFS.symlinkSync(dir, path, "dir");
      linked.push(path);
    }
  }
  return { linked, removed, skipped };
}

// Claude reads ~/.claude/skills; Codex, Grok and OpenCode read ~/.agents/skills, and Codex also
// ~/.codex/skills. Grok and OpenCode see a skill in two of these and collapse it by name.
export function defaultTargets(home: string): string[] {
  return [".claude/skills", ".agents/skills", ".codex/skills"].map((dir) =>
    NodePath.join(home, dir),
  );
}

if (import.meta.main) {
  // Links must point at the main checkout, never at a worktree that will be removed.
  const commonDir = NodeChildProcess.execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: import.meta.dirname, encoding: "utf8" },
  ).trim();
  const skillsRoot = NodePath.join(NodePath.dirname(commonDir), "workflow", "skills");
  const report = linkWorkflowSkills(skillsRoot, defaultTargets(NodeOS.homedir()));
  console.log(
    `workflow-link: ${report.linked.length} linked, ${report.removed.length} removed, ${report.skipped.length} skipped`,
  );
  for (const path of report.skipped) console.warn(`  skipped ${path}: not a workflow symlink`);
}
