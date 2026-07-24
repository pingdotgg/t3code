import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildComposerSkillItems } from "./thread-composer-skill-items";

function skill(
  name: string,
  input: Partial<Omit<ServerProviderSkill, "name" | "path">> = {},
): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
    ...input,
  };
}

describe("buildComposerSkillItems", () => {
  it("exposes enabled workspace skills and excludes disabled snapshot entries", () => {
    const repoLocal = skill("update-worktrees", { displayName: "Update Worktrees" });

    expect(
      buildComposerSkillItems([repoLocal, skill("disabled", { enabled: false })], "$"),
    ).toEqual([
      {
        id: "skill:update-worktrees",
        type: "skill",
        skill: repoLocal,
        label: "Update Worktrees",
        description: "",
      },
    ]);
  });

  it("searches workspace skill names, labels, and descriptions", () => {
    const releaseNotes = skill("release-notes", {
      displayName: "Find Release Notes",
      shortDescription: "Assess changelog entries",
    });
    const updateWorktrees = skill("update-worktrees", {
      displayName: "Update Worktrees",
      description: "Refresh active workspaces",
    });

    expect(buildComposerSkillItems([updateWorktrees, releaseNotes], "$release")).toEqual([
      expect.objectContaining({ skill: releaseNotes }),
    ]);
    expect(buildComposerSkillItems([releaseNotes, updateWorktrees], "workspaces")).toEqual([
      expect.objectContaining({ skill: updateWorktrees }),
    ]);
  });
});
