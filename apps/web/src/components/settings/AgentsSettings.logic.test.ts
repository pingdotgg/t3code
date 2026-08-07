import { describe, expect, it } from "vite-plus/test";
import {
  buildAgentProfileDocument,
  draftFromProfile,
  agentSettingsContextKey,
  resolveProfileBaselineForSave,
  sortAgentProfiles,
} from "./AgentsSettings.logic";

describe("agent profile settings model", () => {
  it("creates a complete provider-neutral document from the form defaults", () => {
    const document = buildAgentProfileDocument(
      { ...draftFromProfile({ scope: "environment" }), id: "default", name: "Default" },
      null,
    );
    expect(document.id).toBe("default");
    expect(document.scope).toBe("environment");
    expect(document.instructions).toBe("");
    expect(document.runtime.mode).toBe("auto");
    expect(document.workspace.access).toBe("workspace-write");
    expect(document.chatSelectable).toBe(true);
    expect(document.budgets.maxDepth).toBe(0);
    expect(document.hooks).toEqual([]);
  });

  it("rejects blank required budget inputs", () => {
    expect(() =>
      buildAgentProfileDocument({ ...draftFromProfile(), maxRuns: "   " }, null),
    ).toThrow("Maximum runs is required.");
  });

  it("preserves a revision and parses structured policy fields", () => {
    const draft = draftFromProfile();
    const document = buildAgentProfileDocument(
      {
        ...draft,
        id: "reviewer",
        name: "Reviewer",
        chatSelectable: false,
        defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
        hooks:
          '[{"stage":"beforeSpawn","kind":"shell","command":"echo ready","timeoutSeconds":5,"failurePolicy":"warn"}]',
        rules: '[{"id":"safe","path":"rules/safe.md"}]',
      },
      buildAgentProfileDocument({ ...draft, id: "reviewer", name: "Old" }, null),
    );
    expect(document.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(document.defaultModelSelection).toMatchObject({ model: "gpt-5" });
    expect(document.chatSelectable).toBe(false);
    expect(document.hooks[0]).toMatchObject({ kind: "shell", stage: "beforeSpawn" });
    expect(document.rules).toEqual([{ id: "safe", path: "rules/safe.md" }]);
  });

  it("sorts active environment profiles before project and archived profiles", () => {
    const profiles = [
      { id: "z", name: "Z", scope: "project" as const, archivedAt: null },
      { id: "a", name: "A", scope: "environment" as const, archivedAt: "2026-01-01" },
      { id: "b", name: "B", scope: "environment" as const, archivedAt: null },
    ];
    expect(sortAgentProfiles(profiles).map((profile) => profile.id)).toEqual(["b", "z", "a"]);
  });

  it("rejects malformed structured policy fields", () => {
    expect(() =>
      buildAgentProfileDocument(
        { ...draftFromProfile(), id: "reviewer", name: "Reviewer", hooks: "not json" },
        null,
      ),
    ).toThrow("Hooks must contain valid JSON.");
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

  it("changes when a local editor generation changes", () => {
    const context = { environmentId: "env", projectId: null, selectionKey: null };
    expect(agentSettingsContextKey({ ...context, generation: 1 })).not.toBe(
      agentSettingsContextKey({ ...context, generation: 2 }),
    );
  });
});
