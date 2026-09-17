import type { ProviderSkillKey, ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSkillsSettingsModel,
  toggleDisabledSkill,
  unfoldSettingsDisabledSkills,
} from "./skillsSettings.logic";

function skill(overrides: Partial<ServerProviderSkill> & { name: string }): ServerProviderSkill {
  return {
    path: `/home/dev/.claude/skills/${overrides.name}/SKILL.md`,
    enabled: true,
    scope: "user",
    ...overrides,
  } as ServerProviderSkill;
}

function providers(skills: ReadonlyArray<ServerProviderSkill>, label = "Claude") {
  return [{ id: "claude-1", label, skills }];
}

describe("buildSkillsSettingsModel", () => {
  it("groups a provider's skills by source", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([
        skill({ name: "review" }),
        skill({ name: "deploy", scope: "repo", path: "/repo/.claude/skills/deploy/SKILL.md" }),
      ]),
      disabledSkills: [],
    });

    expect(model.providers[0]?.sources.map((source) => source.source)).toEqual([
      "repo",
      "personal",
    ]);
  });

  it("switches a row off when a stored key matches its source and folded name", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review" })]),
      disabledSkills: [{ source: "personal", name: " Review " } as ProviderSkillKey],
    });

    expect(model.providers[0]?.sources[0]?.rows[0]?.disabled).toBe(true);
  });

  it("leaves a row on when the stored key names another source", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review" })]),
      disabledSkills: [{ source: "repo", name: "review" } as ProviderSkillKey],
    });

    expect(model.providers[0]?.sources[0]?.rows[0]?.disabled).toBe(false);
  });

  it("locks a row the provider itself switched off", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review", enabled: false, disabledBy: "provider" })]),
      disabledSkills: [],
    });

    const row = model.providers[0]?.sources[0]?.rows[0];
    expect(row?.disabled).toBe(true);
    expect(row?.disabledByProvider).toBe(true);
  });

  it("lists a stored key nothing discovered as stale", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review" })]),
      disabledSkills: [{ source: "repo", name: "gone" } as ProviderSkillKey],
    });

    expect(model.stale.map((row) => row.key.name)).toEqual(["gone"]);
  });

  it("keeps one row for a skill two workspace snapshots both report", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review" }), skill({ name: "Review" })]),
      disabledSkills: [],
    });

    expect(model.providers[0]?.sources[0]?.rows).toHaveLength(1);
  });

  it("filters rows by the query and says rows were hidden", () => {
    const model = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review" }), skill({ name: "deploy" })]),
      disabledSkills: [],
      query: "revi",
    });

    expect(model.providers[0]?.sources[0]?.rows.map((row) => row.key.name)).toEqual(["review"]);
    expect(model.hasHiddenRows).toBe(false);

    const noMatch = buildSkillsSettingsModel({
      providers: providers([skill({ name: "review" })]),
      disabledSkills: [],
      query: "nothing",
    });
    expect(noMatch.hasHiddenRows).toBe(true);
  });
});

describe("toggleDisabledSkill", () => {
  it("adds the trimmed key when a switch goes off", () => {
    expect(
      toggleDisabledSkill([], { source: "personal", name: " review " } as ProviderSkillKey, true),
    ).toEqual([{ source: "personal", name: "review" }]);
  });

  it("removes every matching entry when a switch goes on", () => {
    const stored = [
      { source: "personal", name: "Review" },
      { source: "repo", name: "review" },
    ] as ProviderSkillKey[];

    expect(
      toggleDisabledSkill(
        stored,
        { source: "personal", name: "review" } as ProviderSkillKey,
        false,
      ),
    ).toEqual([{ source: "repo", name: "review" }]);
  });
});

describe("unfoldSettingsDisabledSkills", () => {
  it("lets the project list decide by peeling the environment fold off", () => {
    const [folded, byProvider] = unfoldSettingsDisabledSkills([
      skill({ name: "review", enabled: false, disabledBy: "settings" }),
      skill({ name: "deploy", enabled: false, disabledBy: "provider" }),
    ]);

    expect(folded).toEqual({ ...skill({ name: "review" }), enabled: true });
    expect(byProvider).toMatchObject({ enabled: false, disabledBy: "provider" });
  });

  it("keeps a project's own list off once it is rebuilt from the unfolded skills", () => {
    const model = buildSkillsSettingsModel({
      providers: providers(
        unfoldSettingsDisabledSkills([
          skill({ name: "review", enabled: false, disabledBy: "settings" }),
          skill({ name: "deploy", enabled: false, disabledBy: "settings" }),
        ]),
      ),
      disabledSkills: [{ source: "personal", name: "deploy" }] as ProviderSkillKey[],
    });

    expect(model.providers[0]?.sources[0]?.rows.map((row) => [row.title, row.disabled])).toEqual([
      ["Deploy", true],
      ["Review", false],
    ]);
  });
});
