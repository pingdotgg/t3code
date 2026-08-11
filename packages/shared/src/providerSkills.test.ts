import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterProviderSkillsForWorkspace,
  normalizeProviderSkillWorkspacePath,
} from "./providerSkills.ts";

function skill(name: string, sourceCwd?: string): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
    ...(sourceCwd ? { sourceCwd, scope: "project" } : { scope: "user" }),
  };
}

describe("normalizeProviderSkillWorkspacePath", () => {
  it("strips trailing separators", () => {
    expect(normalizeProviderSkillWorkspacePath("/tmp/project/")).toBe("/tmp/project");
    expect(normalizeProviderSkillWorkspacePath("/tmp/project\\")).toBe("/tmp/project");
  });

  it("collapses mid-path separators and dot segments", () => {
    expect(normalizeProviderSkillWorkspacePath("/tmp//project/./app/../lib")).toBe(
      "/tmp/project/lib",
    );
    expect(normalizeProviderSkillWorkspacePath("/tmp/project/.")).toBe("/tmp/project");
  });

  it("keeps root paths", () => {
    expect(normalizeProviderSkillWorkspacePath("/")).toBe("/");
  });

  it("matches path.resolve-style absolute forms used on the server", () => {
    // Server stamps via path.resolve; clients often see trailing slashes or
    // mixed separators from wire / UI state.
    expect(normalizeProviderSkillWorkspacePath("/workspace/a")).toBe(
      normalizeProviderSkillWorkspacePath("/workspace/a/"),
    );
    expect(normalizeProviderSkillWorkspacePath("/workspace/a")).toBe(
      normalizeProviderSkillWorkspacePath("/workspace//a/./"),
    );
  });
});

describe("filterProviderSkillsForWorkspace", () => {
  const inventory = [
    skill("user-only"),
    skill("a-only", "/workspace/a"),
    skill("b-only", "/workspace/b"),
    skill("shared", "/workspace/a"),
    skill("shared", "/workspace/b"),
  ];

  it("returns only user skills when no workspace is active", () => {
    expect(filterProviderSkillsForWorkspace(inventory, null).map((entry) => entry.name)).toEqual([
      "user-only",
    ]);
    expect(filterProviderSkillsForWorkspace(inventory, "  ").map((entry) => entry.name)).toEqual([
      "user-only",
    ]);
  });

  it("returns user skills plus the matching project bag", () => {
    expect(
      filterProviderSkillsForWorkspace(inventory, "/workspace/a").map((entry) => entry.name),
    ).toEqual(["a-only", "shared", "user-only"]);
    expect(
      filterProviderSkillsForWorkspace(inventory, "/workspace/b/").map((entry) => [
        entry.name,
        entry.sourceCwd,
      ]),
    ).toEqual([
      ["b-only", "/workspace/b"],
      ["shared", "/workspace/b"],
      ["user-only", undefined],
    ]);
  });

  it("does not leak sibling workspace skills", () => {
    const scoped = filterProviderSkillsForWorkspace(inventory, "/workspace/a");
    expect(scoped.some((entry) => entry.name === "b-only")).toBe(false);
    expect(scoped.find((entry) => entry.name === "shared")?.sourceCwd).toBe("/workspace/a");
  });

  it("lets project skills override user skills on name collision", () => {
    const withCollision = [skill("deploy"), skill("deploy", "/workspace/a")];
    const scoped = filterProviderSkillsForWorkspace(withCollision, "/workspace/a");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.sourceCwd).toBe("/workspace/a");
  });

  it("includes project-root skills when filtering by a worktree of that project", () => {
    const withRootOnly = [
      skill("user-only"),
      skill("root-skill", "/workspace/a"),
      skill("other-skill", "/workspace/b"),
    ];
    const scoped = filterProviderSkillsForWorkspace(withRootOnly, "/workspace/a-worktrees/feat", {
      projectRoot: "/workspace/a",
    });
    expect(scoped.map((entry) => entry.name)).toEqual(["root-skill", "user-only"]);
    expect(scoped.some((entry) => entry.name === "other-skill")).toBe(false);
  });

  it("prefers worktree-tagged skills over project-root tags on name collision", () => {
    const inventoryWithBoth = [
      skill("deploy", "/workspace/a"),
      skill("deploy", "/workspace/a-worktrees/feat"),
    ];
    const scoped = filterProviderSkillsForWorkspace(
      inventoryWithBoth,
      "/workspace/a-worktrees/feat",
      { projectRoot: "/workspace/a" },
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.sourceCwd).toBe("/workspace/a-worktrees/feat");
  });

  it("matches when client path form differs from server-stamped sourceCwd", () => {
    const stamped = [skill("deploy", "/workspace/a")];
    const scoped = filterProviderSkillsForWorkspace(stamped, "/workspace//a/./");
    expect(scoped.map((entry) => entry.name)).toEqual(["deploy"]);
  });
});
