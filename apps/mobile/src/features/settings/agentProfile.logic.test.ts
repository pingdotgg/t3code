import { describe, expect, it } from "@effect/vitest";

import {
  buildAgentProfileDocument,
  draftFromProfile,
  isProfileDocumentForSummary,
  resolveProfileBaselineForSave,
  selectChatAgentProfiles,
  sortAgentProfiles,
} from "./agentProfile.logic";

describe("mobile agent profile editor", () => {
  it("builds a complete provider-neutral document from the compact draft", () => {
    const document = buildAgentProfileDocument(
      {
        ...draftFromProfile(null, "project"),
        id: "reviewer",
        name: "Reviewer",
        instructions: "Review the change carefully.",
        maxRuns: "2",
      },
      null,
      "2026-08-07T00:00:00.000Z",
    );

    expect(document.scope).toBe("project");
    expect(document.instructions).toContain("Review");
    expect(document.budgets.maxRuns).toBe(2);
    expect(document.runtime.mode).toBe("auto");
    expect(document.chatSelectable).toBe(true);
  });

  it("keeps active profiles ahead of archived profiles", () => {
    const profiles = sortAgentProfiles([
      { id: "old", name: "Old", scope: "environment", archivedAt: "2026-01-01" },
      { id: "new", name: "New", scope: "environment", archivedAt: null },
    ]);
    expect(profiles.map((profile) => profile.id)).toEqual(["new", "old"]);
  });

  it("rejects blank required budget inputs", () => {
    expect(() =>
      buildAgentProfileDocument(
        { ...draftFromProfile(), id: "reviewer", name: "Reviewer", maxRuns: "   " },
        null,
      ),
    ).toThrow("Maximum runs is required.");
  });
  it("reports schema-only invalid profile fields readably", () => {
    expect(() =>
      buildAgentProfileDocument({ ...draftFromProfile(), runtimeMode: "invalid" as "auto" }, null),
    ).toThrow("Profile settings contain an invalid value.");
  });

  it("requires the loaded revision before saving an existing profile", () => {
    const profile = buildAgentProfileDocument(
      { ...draftFromProfile(), id: "reviewer", name: "Reviewer" },
      null,
    );
    expect(() => resolveProfileBaselineForSave(false, profile, undefined)).toThrow(
      "Load the current profile",
    );
    expect(resolveProfileBaselineForSave(false, profile, profile)).toBe(profile);
    expect(resolveProfileBaselineForSave(true, null, undefined)).toBeNull();
  });

  it("does not hydrate a profile from a stale revision", () => {
    const profile = buildAgentProfileDocument(
      { ...draftFromProfile(), id: "reviewer", name: "Reviewer" },
      null,
    );
    expect(isProfileDocumentForSummary(profile, profile)).toBe(true);
    expect(
      isProfileDocumentForSummary(profile, {
        ...profile,
        revision: "b".repeat(64) as typeof profile.revision,
      }),
    ).toBe(false);
  });

  it("hides delegation-only profiles except for a thread that already selected one", () => {
    const profiles = [
      { id: "parent", scope: "environment", chatSelectable: true, archivedAt: null },
      { id: "reviewer", scope: "environment", chatSelectable: false, archivedAt: null },
    ];
    expect(selectChatAgentProfiles(profiles, null)).toEqual([profiles[0]]);
    expect(selectChatAgentProfiles(profiles, { id: "reviewer", scope: "environment" })).toEqual(
      profiles,
    );
  });

  it("retains an archived pinned profile by locator", () => {
    const archived = {
      id: "reviewer",
      scope: "environment",
      chatSelectable: true,
      archivedAt: "2026-08-08T00:00:00.000Z",
    };
    expect(selectChatAgentProfiles([archived], archived)).toEqual([archived]);
    expect(selectChatAgentProfiles([archived], null)).toEqual([]);
  });
});
