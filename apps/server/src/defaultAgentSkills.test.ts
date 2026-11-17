import { agentSkillDigest, type AgentSkill } from "@t3tools/contracts";
import { DEFAULT_AGENT_SKILL_NAMES } from "@t3tools/shared/agentPresets";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DefaultAgentSkills from "./defaultAgentSkills.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const defaultIds = DEFAULT_AGENT_SKILL_NAMES.map((name) => `t3-default-${name}`);
const at = "2026-11-13T00:00:00.000Z";
const skill = (overrides: Partial<AgentSkill>): AgentSkill => ({
  skillId: "mine",
  name: "mine",
  description: "",
  content: "# Mine",
  revision: 1,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const seededLibrary = (overrides: Parameters<typeof ServerSettingsService.layerTest>[0] = {}) =>
  Effect.gen(function* () {
    yield* DefaultAgentSkills.seed();
    return yield* (yield* ServerSettingsService).getSettings;
  }).pipe(Effect.provide(ServerSettingsService.layerTest(overrides)));

it.effect("seeds the default skills into an empty library", () =>
  Effect.gen(function* () {
    const settings = yield* seededLibrary();
    assert.sameDeepMembers(
      settings.agentSkills.map((item) => [item.skillId, item.name]),
      DEFAULT_AGENT_SKILL_NAMES.map((name) => [`t3-default-${name}`, name]),
    );
    assert.isTrue(settings.agentSkills.every((item) => item.content.length > 0));
    // The stored copy still matches its record, so it reads as an unedited install.
    assert.isTrue(
      settings.agentSkills.every((item) => item.template?.digest === agentSkillDigest(item)),
    );
  }),
);

it.effect("does not re-add a default skill the user deleted", () =>
  Effect.gen(function* () {
    const settings = yield* seededLibrary({ agentSkillDeletedAt: { [defaultIds[0]!]: at } });
    assert.deepStrictEqual(settings.agentSkills, []);
  }),
);

it.effect("does not overwrite a default skill the user edited", () =>
  Effect.gen(function* () {
    const edited = skill({ skillId: defaultIds[0]!, name: DEFAULT_AGENT_SKILL_NAMES[0] });
    const settings = yield* seededLibrary({ agentSkills: [edited] });
    assert.deepStrictEqual(settings.agentSkills, [edited]);
  }),
);

it.effect("seeds nothing into a library that already holds skills", () =>
  Effect.gen(function* () {
    const settings = yield* seededLibrary({ agentSkills: [skill({})] });
    assert.deepStrictEqual(
      settings.agentSkills.map((item) => item.skillId),
      ["mine"],
    );
  }),
);
