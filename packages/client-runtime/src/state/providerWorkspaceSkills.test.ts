import {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderSkillsListError,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderWorkspaceSkillsError,
  providerWorkspaceSkillsTargetKey,
  resolveNextProviderWorkspaceSkillsSnapshot,
  resolveProviderWorkspaceSkills,
} from "./providerWorkspaceSkills.ts";

function skill(name: string): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  };
}

describe("providerWorkspaceSkillsTargetKey", () => {
  it("normalizes an enabled environment, provider, and cwd target", () => {
    expect(
      providerWorkspaceSkillsTargetKey({
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "  /repo/worktree  ",
        enabled: true,
      }),
    ).toBe("local:codex:/repo/worktree");
  });

  it("disables workspace queries without a usable cwd", () => {
    expect(
      providerWorkspaceSkillsTargetKey({
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "   ",
        enabled: true,
      }),
    ).toBeNull();
  });
});

describe("resolveProviderWorkspaceSkills", () => {
  it("preserves loaded skills while the same workspace refreshes", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "local:codex:/repo",
        currentSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(currentSkills);
  });

  it("does not leak skills across workspace switches", () => {
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo-b",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "local:codex:/repo-a",
        currentSkills: [skill("repo-a")],
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toEqual([]);
  });

  it("preserves verified same-workspace skills while the environment is unavailable", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo",
        nextSkills: null,
        isPending: false,
        error: null,
        unavailable: true,
        currentKey: "local:codex:/repo",
        currentSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(currentSkills);
  });

  it("uses provider fallback skills when a different workspace is unavailable", () => {
    const fallbackSkills = [skill("provider-fallback")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo-b",
        nextSkills: null,
        isPending: false,
        error: null,
        unavailable: true,
        currentKey: "local:codex:/repo-a",
        currentSkills: [skill("repo-a")],
        fallbackSkills,
      }),
    ).toBe(fallbackSkills);
  });

  it("uses provider snapshot skills for empty and failed workspace responses", () => {
    const fallbackSkills = [skill("provider-fallback")];
    const base = {
      nextKey: "local:codex:/repo",
      currentKey: null,
      currentSkills: [],
      fallbackSkills,
    } as const;

    expect(
      resolveProviderWorkspaceSkills({
        ...base,
        nextSkills: [],
        isPending: false,
        error: null,
      }),
    ).toBe(fallbackSkills);
    expect(
      resolveProviderWorkspaceSkills({
        ...base,
        // Effect AsyncResult failures retain the previous success, so query
        // consumers can receive stale data and an error at the same time.
        nextSkills: [skill("stale-workspace-skill")],
        isPending: false,
        error: "Failed to list skills.",
      }),
    ).toBe(fallbackSkills);
  });
});

describe("resolveNextProviderWorkspaceSkillsSnapshot", () => {
  it("keeps the settled snapshot during refresh and clears it when disabled", () => {
    const current = {
      key: "local:codex:/repo",
      skills: [skill("repo-local")],
    };

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: current.key,
        skills: [skill("fresh-repo-local")],
        isPending: true,
        error: null,
        current,
      }),
    ).toBe(current);
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: null,
        skills: current.skills,
        isPending: false,
        error: null,
        current,
      }),
    ).toBeNull();
  });

  it("clears a stale snapshot after a failed refresh", () => {
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "local:codex:/repo",
        skills: [skill("stale-repo-local")],
        isPending: false,
        error: "Failed to list skills.",
        current: {
          key: "local:codex:/repo",
          skills: [skill("repo-local")],
        },
      }),
    ).toBeNull();
  });

  it("retains only a same-workspace snapshot while unavailable", () => {
    const current = {
      key: "local:codex:/repo-a",
      skills: [skill("repo-a")],
    };

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: current.key,
        skills: null,
        isPending: false,
        error: null,
        unavailable: true,
        current,
      }),
    ).toBe(current);
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "local:codex:/repo-b",
        skills: null,
        isPending: false,
        error: null,
        unavailable: true,
        current,
      }),
    ).toBeNull();
  });
});

describe("formatProviderWorkspaceSkillsError", () => {
  it("adds bounded structured detail without exposing a raw cause", () => {
    const error = new ServerProviderSkillsListError({
      reason: "invalid-cwd",
      operation: "ProviderSkillsLister.normalizeCwd",
      message: "Invalid Codex skills cwd '/missing'.",
      detail: "Workspace root does not exist: /missing.",
      cause: new Error("raw platform detail"),
    });

    expect(
      formatProviderWorkspaceSkillsError({
        error: error.message,
        cause: Cause.fail(error),
      }),
    ).toBe("Invalid Codex skills cwd '/missing'. Workspace root does not exist: /missing.");
  });
});
