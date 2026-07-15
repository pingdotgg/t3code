import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderSkill } from "@t3tools/contracts";

import {
  getComposerProviderSkillsCacheEntry,
  resolveComposerProviderSkills,
} from "./composerProviderSkills";

const skill = (name: string): ServerProviderSkill => ({
  name,
  path: `/tmp/${name}/SKILL.md`,
  enabled: true,
});

describe("resolveComposerProviderSkills", () => {
  it("uses the cwd-aware discovery result, including an empty result", () => {
    const snapshotSkills = [skill("snapshot")];

    expect(
      resolveComposerProviderSkills({
        targetKey: "environment\0provider\0/project",
        discoveredSkills: [],
        cachedSkills: null,
        snapshotSkills,
        discoveryUnsupported: true,
      }),
    ).toEqual([]);
  });

  it("retains a last successful result only for the exact target key", () => {
    const cachedSkills = {
      targetKey: "environment\0provider\0/project-a",
      skills: [skill("project-a")],
    };

    expect(
      resolveComposerProviderSkills({
        targetKey: cachedSkills.targetKey,
        discoveredSkills: null,
        cachedSkills,
        snapshotSkills: [skill("snapshot")],
        discoveryUnsupported: false,
      }),
    ).toEqual(cachedSkills.skills);

    expect(
      resolveComposerProviderSkills({
        targetKey: "environment\0provider\0/project-b",
        discoveredSkills: null,
        cachedSkills,
        snapshotSkills: [skill("snapshot")],
        discoveryUnsupported: false,
      }),
    ).toEqual([]);
  });

  it("uses snapshot skills only when project discovery is unsupported", () => {
    const snapshotSkills = [skill("snapshot")];
    const baseInput = {
      targetKey: "environment\0provider\0/project",
      discoveredSkills: null,
      cachedSkills: null,
      snapshotSkills,
    } as const;

    expect(
      resolveComposerProviderSkills({
        ...baseInput,
        discoveryUnsupported: false,
      }),
    ).toEqual([]);
    expect(
      resolveComposerProviderSkills({
        ...baseInput,
        discoveryUnsupported: true,
      }),
    ).toEqual(snapshotSkills);
  });

  it("caches an unsupported-provider snapshot for the exact target", () => {
    const snapshotSkills = [skill("snapshot")];
    const targetKey = "environment\0provider\0/project";

    const cachedSkills = getComposerProviderSkillsCacheEntry({
      targetKey,
      discoveredSkills: null,
      snapshotSkills,
      discoveryUnsupported: true,
    });
    expect(cachedSkills).toEqual({ targetKey, skills: snapshotSkills });
    expect(
      resolveComposerProviderSkills({
        targetKey,
        discoveredSkills: null,
        cachedSkills,
        snapshotSkills,
        // Closing the menu disables the query and clears its current error.
        discoveryUnsupported: false,
      }),
    ).toEqual(snapshotSkills);
    expect(
      resolveComposerProviderSkills({
        targetKey: "environment\0provider\0another-project",
        discoveredSkills: null,
        cachedSkills,
        snapshotSkills,
        discoveryUnsupported: false,
      }),
    ).toEqual([]);
    expect(
      getComposerProviderSkillsCacheEntry({
        targetKey,
        discoveredSkills: null,
        snapshotSkills,
        discoveryUnsupported: false,
      }),
    ).toBeNull();
  });
});
