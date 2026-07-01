import type { ServerProviderSkill } from "@t3tools/contracts";
import { ServerProviderSkillsListError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderWorkspaceSkillsError,
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

describe("formatProviderWorkspaceSkillsError", () => {
  it("appends structured provider skill diagnostics without putting cause text in the wrapper message", () => {
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
    expect(error.message).not.toContain("raw platform detail");
  });

  it("preserves the query wrapper message when structured detail is available", () => {
    const error = new ServerProviderSkillsListError({
      reason: "home-prepare-failed",
      operation: "ProviderSkillsLister.prepareCodexHome",
      message: "Failed to prepare Codex home for 'codex'.",
      detail: "Check the configured Codex home paths and filesystem permissions.",
    });

    expect(
      formatProviderWorkspaceSkillsError({
        error: "Environment request failed: Failed to prepare Codex home for 'codex'.",
        cause: Cause.fail(error),
      }),
    ).toBe(
      "Environment request failed: Failed to prepare Codex home for 'codex'. Check the configured Codex home paths and filesystem permissions.",
    );
  });

  it("leaves provider skill errors without detail unchanged", () => {
    const error = new ServerProviderSkillsListError({
      reason: "probe-failed",
      operation: "ProviderSkillsLister.listCodexProviderSkills",
      message: "Failed to list Codex skills.",
    });

    expect(
      formatProviderWorkspaceSkillsError({
        error: error.message,
        cause: Cause.fail(error),
      }),
    ).toBe("Failed to list Codex skills.");
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
        error: null,
        currentKey: null,
        currentSkills: [],
        fallbackSkills: [skill("provider-fallback")],
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
        error: null,
        currentKey: "environment:codex:/repo",
        currentSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(loadedSkills);
  });

  it("uses fallback skills for empty loaded workspace skills", () => {
    const loadedSkills: ReadonlyArray<ServerProviderSkill> = [];
    const fallbackSkills = [skill("provider-fallback")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: loadedSkills,
        isPending: true,
        error: null,
        currentKey: "environment:codex:/repo",
        currentSkills: [skill("repo-local")],
        fallbackSkills,
      }),
    ).toBe(fallbackSkills);
  });

  it("preserves current skills while refreshing the same workspace", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "environment:codex:/repo",
        currentSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(currentSkills);
  });

  it("clears current skills while loading a different workspace", () => {
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/new-repo",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "environment:codex:/old-repo",
        currentSkills: [skill("old-repo-skill")],
        fallbackSkills: [skill("provider-fallback")],
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
        error: null,
        currentKey: "environment:codex:/repo-a",
        currentSkills: repoASkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toEqual([]);
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo-a",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "environment:codex:/repo-b",
        currentSkills: repoBSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toEqual([]);
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo-a",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "environment:codex:/repo-a",
        currentSkills: repoASkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(repoASkills);
  });

  it("clears skills after a non-pending query with no data", () => {
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: null,
        isPending: false,
        error: null,
        currentKey: "environment:codex:/repo",
        currentSkills: [skill("repo-local")],
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toEqual([]);
  });

  it("uses fallback skills after a query error", () => {
    const fallbackSkills = [skill("provider-fallback")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "environment:codex:/repo",
        nextSkills: null,
        isPending: false,
        error: "Invalid git cwd",
        currentKey: "environment:codex:/repo",
        currentSkills: [],
        fallbackSkills,
      }),
    ).toBe(fallbackSkills);
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
