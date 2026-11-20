import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { resolveRoles, ROLES } from "./roles";

const rolesDir = NodePath.resolve(import.meta.dirname, "../../roles");
const byName = (name: string) => {
  const role = ROLES.find((entry) => entry.name === name);
  if (role === undefined) throw new Error(`no role ${name}`);
  return role;
};

describe("the role registry", () => {
  it.each([
    ["task", "implementation", "worktree", "claude-sonnet-5-5", "high"],
    ["scout", "research", "shared", "claude-sonnet-5-5", "medium"],
    ["reviewer", "review", "shared", "claude-fable-5-1", "xhigh"],
    ["security-reviewer", "review", "shared", "claude-opus-5-5", "high"],
    ["sonic", "implementation", "worktree", "claude-haiku-5-5", "low"],
  ])(
    "Given the role %s, when it is looked up, then it is %s in %s isolation on %s at %s",
    (name, t3Role, isolation, slug, effort) => {
      expect(byName(name)).toMatchObject({ t3Role, isolation, model: { slug, effort } });
    },
  );

  it("Given the registry, when it is counted, then it has 18 roles with unique names", () => {
    expect(ROLES).toHaveLength(18);
    expect(new Set(ROLES.map((role) => role.name)).size).toBe(18);
  });

  it("Given every registry file, when roles/ is read, then each exists and names its own role", () => {
    for (const role of ROLES) {
      const text = NodeFS.readFileSync(NodePath.join(rolesDir, role.file), "utf8");
      expect(text.split("\n")[1]).toBe(`name: ${role.name}`);
    }
    expect(NodeFS.readdirSync(rolesDir).toSorted()).toEqual(
      ROLES.map((role) => role.file).toSorted(),
    );
  });

  it("Given no omp-only front matter keys, when roles/ is read, then none carries tools, model, spawns, or thinking-level", () => {
    for (const role of ROLES) {
      const text = NodeFS.readFileSync(NodePath.join(rolesDir, role.file), "utf8");
      const frontMatter = text.slice(0, text.indexOf("\n---\n", 4));
      expect(frontMatter).not.toMatch(/^(tools|model|spawns|thinking-level|output):/m);
    }
  });

  it("Given an instance that offers every model, when the roles resolve, then each keeps its own model on that instance", () => {
    const resolved = resolveRoles(ROLES, {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      offered: ROLES.map((role) => role.model.slug),
    });
    expect(resolved.find((role) => role.name === "reviewer")).toMatchObject({
      target: { providerInstanceId: "claudeAgent", model: "claude-fable-5-1", effort: "xhigh" },
      fallback: null,
    });
  });

  it("Given an instance without claude-fable-5-1, when the roles resolve, then only the reviewer falls back and says why", () => {
    const resolved = resolveRoles(ROLES, {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      offered: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    });
    const fallen = resolved.filter((role) => role.fallback !== null);
    expect(fallen.map((role) => role.name)).toEqual(["reviewer"]);
    expect(fallen[0]).toMatchObject({
      target: { providerInstanceId: "claudeAgent" },
      fallback:
        "claude-fable-5-1 is not offered by claudeAgent, so it uses the orchestrator's model",
    });
  });

  it("Given a Codex orchestrator, when the roles resolve, then every child inherits its model", () => {
    const resolved = resolveRoles(ROLES, { instanceId: "codex", driver: "codex", offered: [] });
    expect(
      resolved.every(
        (role) => role.target.providerInstanceId === "codex" && role.target.model === undefined,
      ),
    ).toBe(true);
  });
});
