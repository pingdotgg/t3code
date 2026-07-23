// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  type ClaudeSkillDiscoveryContext,
  parseClaudeReloadedSkills,
} from "./ClaudeSkillDiscovery.ts";

const CONFIG_DIR = "/home/dev/.claude";
const CWD = "/repo";

function makeCtx(overrides?: Partial<ClaudeSkillDiscoveryContext>): ClaudeSkillDiscoveryContext {
  return {
    claudeConfigDir: CONFIG_DIR,
    cwd: CWD,
    pathExists: () => false,
    ...overrides,
  };
}

describe("parseClaudeReloadedSkills", () => {
  it("strips the scope suffix and maps it, using the config-dir fallback path", () => {
    const skills = parseClaudeReloadedSkills(
      [{ name: "disk-cleanup", description: "Reclaim disk space (user)" }],
      makeCtx(),
    );

    expect(skills).toEqual([
      {
        name: "disk-cleanup",
        path: NodePath.join(CONFIG_DIR, "skills", "disk-cleanup"),
        enabled: true,
        description: "Reclaim disk space",
        scope: "user",
      },
    ]);
  });

  it("maps project/local suffixes to project and builtin/bundled/system to system", () => {
    const scopes = parseClaudeReloadedSkills(
      [
        { name: "a", description: "A (project)" },
        { name: "b", description: "B (local)" },
        { name: "c", description: "C (builtin)" },
        { name: "d", description: "D (bundled)" },
        { name: "e", description: "E (system)" },
        { name: "f", description: "F (policy)" },
      ],
      makeCtx(),
    ).map((skill) => skill.scope);

    expect(scopes).toEqual(["project", "project", "system", "system", "system", "policy"]);
  });

  it("resolves a project path when the workspace skill dir exists (defaulting scope to project)", () => {
    const projectPath = NodePath.join(CWD, ".claude", "skills", "review");
    const skills = parseClaudeReloadedSkills(
      [{ name: "review", description: "Review changes" }],
      makeCtx({ pathExists: (candidate) => candidate === projectPath }),
    );

    expect(skills[0]).toEqual({
      name: "review",
      path: projectPath,
      enabled: true,
      description: "Review changes",
      scope: "project",
    });
  });

  it("resolves a user path when only the config-dir skill dir exists", () => {
    const userPath = NodePath.join(CONFIG_DIR, "skills", "review");
    const skills = parseClaudeReloadedSkills(
      [{ name: "review" }],
      makeCtx({ pathExists: (candidate) => candidate === userPath }),
    );

    expect(skills[0]).toEqual({
      name: "review",
      path: userPath,
      enabled: true,
      scope: "user",
    });
  });

  it("prefers the description suffix scope over the filesystem default", () => {
    const projectPath = NodePath.join(CWD, ".claude", "skills", "review");
    const skills = parseClaudeReloadedSkills(
      [{ name: "review", description: "Review changes (user)" }],
      makeCtx({ pathExists: (candidate) => candidate === projectPath }),
    );

    // Lives in the project dir, but the CLI reported it as a user skill.
    expect(skills[0]?.path).toBe(projectPath);
    expect(skills[0]?.scope).toBe("user");
  });

  it("falls back to a constructed path with no scope when nothing resolves", () => {
    const skills = parseClaudeReloadedSkills([{ name: "orphan" }], makeCtx());

    expect(skills[0]).toEqual({
      name: "orphan",
      path: NodePath.join(CONFIG_DIR, "skills", "orphan"),
      enabled: true,
    });
  });

  it("does not filesystem-resolve plugin-qualified names", () => {
    const skills = parseClaudeReloadedSkills(
      [{ name: "my-plugin:helper", description: "Helper (plugin)" }],
      makeCtx({
        pathExists: () => {
          throw new Error("pathExists must not be called for plugin-qualified names");
        },
      }),
    );

    expect(skills[0]).toEqual({
      name: "my-plugin:helper",
      path: NodePath.join(CONFIG_DIR, "skills", "my-plugin:helper"),
      enabled: true,
      description: "Helper",
      scope: "plugin",
    });
  });

  it("dedupes by lowercased name and backfills missing parsed metadata", () => {
    const skills = parseClaudeReloadedSkills(
      [
        { name: "Review" },
        { name: "review", description: "Filled in later (user)" },
        { name: "review", description: "Ignored" },
      ],
      makeCtx(),
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("Review");
    expect(skills[0]?.description).toBe("Filled in later");
    expect(skills[0]?.scope).toBe("user");
  });

  it("skips entries with empty or whitespace-only names", () => {
    const skills = parseClaudeReloadedSkills(
      [{ name: "  " }, { name: "" }, { name: "keep" }],
      makeCtx(),
    );

    expect(skills.map((skill) => skill.name)).toEqual(["keep"]);
  });
});
