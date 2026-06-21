import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveNextProviderWorkspaceSkillsSnapshot,
  resolvePendingProviderWorkspaceSkills,
  resolveProviderWorkspaceSkills,
} from "./providerWorkspaceSkillsState";

function skill(name: string): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  };
}

describe("resolvePendingProviderWorkspaceSkills", () => {
  it("preserves current skills while refreshing the same workspace key", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolvePendingProviderWorkspaceSkills({
        currentKey: "environment:codex:/repo",
        nextKey: "environment:codex:/repo",
        currentSkills,
      }),
    ).toBe(currentSkills);
  });

  it("does not expose previous or snapshot skills while a different workspace key is pending", () => {
    const pendingSkills = resolvePendingProviderWorkspaceSkills({
      currentKey: "environment:codex:/old-repo",
      nextKey: "environment:codex:/new-repo",
      currentSkills: [skill("old-repo-skill"), skill("snapshot-skill")],
    });

    expect(pendingSkills).toEqual([]);
  });
});

describe("resolveProviderWorkspaceSkills", () => {
  it("uses loaded skills as soon as workspace data is available", () => {
    const loadedSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: loadedSkills,
        isPending: false,
        currentKey: null,
        currentSkills: [],
      }),
    ).toBe(loadedSkills);
  });

  it("uses loaded skills even when the query is still pending", () => {
    const loadedSkills = [skill("repo-local")];
    const currentSkills = [skill("stale-repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: loadedSkills,
        isPending: true,
        currentKey: "environment:codex:/repo",
        currentSkills,
      }),
    ).toBe(loadedSkills);
  });

  it("uses an empty loaded skill list as available workspace data", () => {
    const loadedSkills: ReadonlyArray<ServerProviderSkill> = [];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: loadedSkills,
        isPending: true,
        currentKey: "environment:codex:/repo",
        currentSkills: [skill("repo-local")],
      }),
    ).toBe(loadedSkills);
  });

  it("preserves current skills while refreshing the same workspace", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: null,
        isPending: true,
        currentKey: "environment:codex:/repo",
        currentSkills,
      }),
    ).toBe(currentSkills);
  });

  it("clears current skills while loading a different workspace", () => {
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/new-repo",
        nextSkills: null,
        isPending: true,
        currentKey: "environment:codex:/old-repo",
        currentSkills: [skill("old-repo-skill")],
      }),
    ).toEqual([]);
  });

  it("does not leak skills during rapid workspace switches", () => {
    const repoASkills = [skill("repo-a")];
    const repoBSkills = [skill("repo-b")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo-b",
        nextSkills: null,
        isPending: true,
        currentKey: "environment:codex:/repo-a",
        currentSkills: repoASkills,
      }),
    ).toEqual([]);
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo-a",
        nextSkills: null,
        isPending: true,
        currentKey: "environment:codex:/repo-b",
        currentSkills: repoBSkills,
      }),
    ).toEqual([]);
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo-a",
        nextSkills: null,
        isPending: true,
        currentKey: "environment:codex:/repo-a",
        currentSkills: repoASkills,
      }),
    ).toBe(repoASkills);
  });

  it("clears skills after a non-pending query with no data", () => {
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: null,
        isPending: false,
        currentKey: "environment:codex:/repo",
        currentSkills: [skill("repo-local")],
      }),
    ).toEqual([]);
  });
});

describe("resolveNextProviderWorkspaceSkillsSnapshot", () => {
  it("stores settled workspace skills for the active key", () => {
    const loadedSkills = [skill("repo-local")];

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "environment:codex:/repo",
        skills: loadedSkills,
        isPending: false,
        current: null,
      }),
    ).toEqual({
      key: "environment:codex:/repo",
      skills: loadedSkills,
    });
  });

  it("preserves the current snapshot while pending", () => {
    const current = {
      key: "environment:codex:/repo",
      skills: [skill("repo-local")],
    };

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "environment:codex:/repo",
        skills: [skill("fresh-repo-local")],
        isPending: true,
        current,
      }),
    ).toBe(current);
  });

  it("clears the snapshot when the target is disabled", () => {
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: null,
        skills: [skill("repo-local")],
        isPending: false,
        current: {
          key: "environment:codex:/repo",
          skills: [skill("repo-local")],
        },
      }),
    ).toBeNull();
  });

  it("clears the snapshot after a settled query without data", () => {
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "environment:codex:/repo",
        skills: null,
        isPending: false,
        current: {
          key: "environment:codex:/repo",
          skills: [skill("repo-local")],
        },
      }),
    ).toBeNull();
  });
});
