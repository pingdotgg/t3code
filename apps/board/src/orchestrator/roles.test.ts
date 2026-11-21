import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { resolveRoles, ROLES } from "./roles";

const rolesDir = NodePath.resolve(import.meta.dirname, "../../roles");

describe("the role registry", () => {
  it("Given the registry, when it is read, then it is these 16 roles on these models", () => {
    const SONNET = ["claude-sonnet-5-5", "medium"];
    const OPUS = ["claude-opus-5-5", "medium"];
    expect(
      ROLES.map((role) => [
        role.name,
        role.t3Role,
        role.isolation,
        role.model.slug,
        role.model.effort,
      ]),
    ).toEqual([
      ["task", "implementation", "worktree", ...SONNET],
      ["scout", "research", "shared", ...SONNET],
      ["reviewer", "review", "shared", ...SONNET],
      ["security-reviewer", "review", "shared", "claude-opus-5-5", "high"],
      ["sonic", "implementation", "worktree", "claude-haiku-5-5", "low"],
      ["comment-sicko", "review", "shared", ...OPUS],
      ["poteto-agent", "general", "worktree", ...OPUS],
      ["egm-bootstrap-orchestrator", "general", "worktree", ...OPUS],
      ["egm-codebase-details", "review", "shared", ...OPUS],
      ["egm-comprehension", "review", "shared", ...OPUS],
      ["egm-design", "design", "shared", ...OPUS],
      ["egm-implementation-readiness", "review", "shared", ...OPUS],
      ["egm-structural", "review", "shared", ...OPUS],
      ["egm-style", "review", "shared", ...OPUS],
      ["egm-synthesizer", "general", "shared", ...OPUS],
      ["egm-zoom-out", "design", "shared", ...OPUS],
    ]);
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
      offered: ROLES.map((role) => role.model.slug),
    });
    expect(resolved.find((role) => role.name === "security-reviewer")).toMatchObject({
      target: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
      fallback: null,
    });
  });

  it("Given an instance without claude-haiku-5-5, when the roles resolve, then only sonic falls back and says why", () => {
    const resolved = resolveRoles(ROLES, {
      instanceId: "claudeAgent",
      offered: ["claude-opus-5-5", "claude-sonnet-5-5"],
    });
    const fallen = resolved.filter((role) => role.fallback !== null);
    expect(fallen.map((role) => role.name)).toEqual(["sonic"]);
    expect(fallen[0]).toMatchObject({
      target: { providerInstanceId: "claudeAgent" },
      fallback:
        "claude-haiku-5-5 is not offered by claudeAgent, so it uses the orchestrator's model",
    });
  });
});
