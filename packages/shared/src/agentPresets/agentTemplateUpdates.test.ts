// @effect-diagnostics nodeBuiltinImport:off -- Reads the fixture preset folder the way a bundler sees it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { toAgentSkillStub, agentSkillDigest, type McpGatewayProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addPresetSkills, decodeAgentPresets, withAgentTemplates } from "./agentPresets.ts";
import { AGENT_TEMPLATES_SHIPPED_AT } from "./agentTemplateDates.ts";
import {
  agentTemplateUpdates,
  applyAgentTemplateUpdate,
  markAgentTemplateMerged,
} from "./agentTemplateUpdates.ts";

const root = NodePath.join(import.meta.dirname, "fixtures");
const files = Object.fromEntries(
  NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = NodePath.join(entry.parentPath, entry.name);
      return [
        NodePath.relative(root, file).split(NodePath.sep).join("/"),
        NodeFS.readFileSync(file, "utf8"),
      ];
    }),
);
const builtIns = (updatedAt: string, edit: (files: Record<string, string>) => void = () => {}) => {
  const copy = { ...files };
  edit(copy);
  const presets = decodeAgentPresets(copy);
  return withAgentTemplates(presets, presets, {
    presets: { reviewer: updatedAt },
    skills: { "review-checklist": updatedAt },
  });
};
const LATER = "2026-12-01T00:00:00.000Z";
const AFTER_LATER = "2026-12-05T00:00:00.000Z";
const older = builtIns(AGENT_TEMPLATES_SHIPPED_AT, (copy) => {
  copy["presets/reviewer/system-prompt.md"] = "You review code.";
  copy["skills/review-checklist/SKILL.md"] = "---\nname: review-checklist\n---\n# Old checklist";
});
const current = builtIns(LATER);

/** A library as installing `presets[0]` at `now` left it. */
function installed(presets: typeof older, now = AGENT_TEMPLATES_SHIPPED_AT) {
  const preset = presets[0]!;
  const added = addPresetSkills([], preset.skills, { now, makeId: () => "skill-1" });
  const profile: McpGatewayProfile = {
    profileId: "agent-1",
    name: preset.name,
    systemPrompt: preset.systemPrompt,
    skillIds: added.skillIds,
    template: preset.template!,
    revision: 1,
    runtimeMode: preset.runtimeMode,
    interactionMode: preset.interactionMode,
    createdAt: now,
    updatedAt: now,
  };
  return { agentSkills: added.agentSkills, mcpGatewayProfiles: [profile] };
}
type Library = Parameters<typeof agentTemplateUpdates>[0];
const statuses = (library: Library, presets = current) =>
  agentTemplateUpdates(library, presets).map((update) => [update.kind, update.modified]);
/** The library after its user saved edits; the server stamps the save time. */
const saved = (library: Library, updatedAt: string, content = "# Mine"): Library => ({
  agentSkills: library.agentSkills.map((skill) =>
    toAgentSkillStub({ ...skill, content, updatedAt }, agentSkillDigest({ content })),
  ),
  mcpGatewayProfiles: library.mcpGatewayProfiles.map((profile) => ({
    ...profile,
    systemPrompt: `${profile.systemPrompt} Be terse.`,
    updatedAt,
  })),
});

const strip = <T extends { template?: unknown }>({ template: _template, ...item }: T) => item;

describe("agentTemplateUpdates", () => {
  it("offers an install the repo template changed after, and stops on every app once applied", () => {
    const library = installed(older);
    expect(statuses(library)).toEqual([
      ["agent", false],
      ["skill", false],
    ]);
    let next: Library = library;
    for (const update of agentTemplateUpdates(library, current)) {
      next = applyAgentTemplateUpdate(next, update, { now: AFTER_LATER, makeId: () => "unused" });
    }
    expect(next.mcpGatewayProfiles[0]).toMatchObject({
      systemPrompt: current[0]!.systemPrompt,
      skillIds: ["skill-1"],
      template: { id: "reviewer", digest: current[0]!.template!.digest, syncedAt: LATER },
    });
    expect(next.agentSkills).toEqual([
      expect.objectContaining({
        skillId: "skill-1",
        content: current[0]!.skills[0]!.content,
        resources: current[0]!.skills[0]!.resources,
        template: expect.objectContaining({ syncedAt: LATER }),
      }),
    ]);
    expect(statuses(next)).toEqual([]);
    expect(statuses(next, older)).toEqual([]);
  });

  it("still offers a later repo update to a copy its user edited after syncing", () => {
    expect(statuses(saved(installed(older), AFTER_LATER))).toEqual([
      ["agent", true],
      ["skill", true],
    ]);
  });

  it("keeps a merge listed until its chat saves, then clears it on every app", () => {
    const edited = saved(installed(older), AFTER_LATER);
    let merged: Library = edited;
    for (const update of agentTemplateUpdates(edited, current)) {
      merged = markAgentTemplateMerged(merged, update, AFTER_LATER);
    }
    expect(statuses(merged)).toEqual([
      ["agent", true],
      ["skill", true],
    ]);
    const done = saved(merged, AFTER_LATER, "# Merged");
    expect(done.mcpGatewayProfiles[0]!.template).toMatchObject({ syncedAt: LATER });
    expect(statuses(done)).toEqual([]);
    expect(statuses(done, older)).toEqual([]);
  });

  it("counts a skill added to an agent as an edit", () => {
    const library = installed(older);
    const profile = library.mcpGatewayProfiles[0]!;
    expect(
      statuses({
        ...library,
        mcpGatewayProfiles: [{ ...profile, skillIds: [...profile.skillIds!, "extra"] }],
      }),
    ).toContainEqual(["agent", true]);
  });

  it("gives a copy from before records the shipping date, so only a later repo change shows", () => {
    const stale = installed(older);
    const legacy = {
      agentSkills: stale.agentSkills.map(strip),
      mcpGatewayProfiles: stale.mcpGatewayProfiles.map(strip),
    };
    const shipped = builtIns(AGENT_TEMPLATES_SHIPPED_AT);
    expect(statuses(legacy, shipped)).toEqual([]);
    expect(statuses(saved(legacy, AFTER_LATER), shipped)).toEqual([]);
    expect(statuses(legacy)).toEqual([
      ["agent", true],
      ["skill", true],
    ]);
    const seeded = {
      ...legacy.agentSkills[0]!,
      skillId: "t3-default-review-checklist",
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
    expect(statuses({ agentSkills: [seeded], mcpGatewayProfiles: [] })).toEqual([["skill", false]]);
    expect(statuses({ agentSkills: [{ ...seeded, revision: 2 }], mcpGatewayProfiles: [] })).toEqual(
      [["skill", true]],
    );
  });
});
