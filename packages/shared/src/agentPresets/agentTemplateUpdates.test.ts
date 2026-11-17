// @effect-diagnostics nodeBuiltinImport:off -- Reads the fixture preset folder the way a bundler sees it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { toAgentSkillStub, agentSkillDigest, type McpGatewayProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addPresetSkills, decodeAgentPresets, withAgentTemplates } from "./agentPresets.ts";
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
const builtIns = (version: string, edit: (files: Record<string, string>) => void = () => {}) => {
  const copy = { ...files };
  edit(copy);
  const presets = decodeAgentPresets(copy);
  return withAgentTemplates(presets, presets, version);
};
const older = builtIns("1.0.0", (copy) => {
  copy["presets/reviewer/system-prompt.md"] = "You review code.";
  copy["skills/review-checklist/SKILL.md"] = "---\nname: review-checklist\n---\n# Old checklist";
});
const current = builtIns("1.1.0");
const now = "2026-11-17T00:00:00.000Z";

/** A library as installing `presets[0]` left it. */
function installed(presets: typeof older) {
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
const statuses = (library: Library, version = "1.1.0") =>
  agentTemplateUpdates(library, current, version).map((update) => [update.kind, update.modified]);

describe("agentTemplateUpdates", () => {
  it("offers an unedited install the current template and stops once it is applied", () => {
    const library = installed(older);
    expect(statuses(library)).toEqual([
      ["agent", false],
      ["skill", false],
    ]);
    let next: Library = library;
    for (const update of agentTemplateUpdates(library, current, "1.1.0")) {
      next = applyAgentTemplateUpdate(next, update, { now, makeId: () => "unused" });
    }
    expect(next.mcpGatewayProfiles[0]).toMatchObject({
      systemPrompt: current[0]!.systemPrompt,
      skillIds: ["skill-1"],
      template: current[0]!.template,
    });
    expect(next.agentSkills).toEqual([
      expect.objectContaining({
        skillId: "skill-1",
        content: current[0]!.skills[0]!.content,
        resources: current[0]!.skills[0]!.resources,
        template: current[0]!.skills[0]!.template,
      }),
    ]);
    expect(statuses(next)).toEqual([]);
  });

  it("reads an edit, including on a metadata stub, and never replaces it", () => {
    const library = installed(older);
    const [skill] = library.agentSkills;
    const edited = {
      agentSkills: [
        toAgentSkillStub({ ...skill!, content: "# Mine" }, agentSkillDigest({ content: "# Mine" })),
      ],
      mcpGatewayProfiles: library.mcpGatewayProfiles.map((profile) => ({
        ...profile,
        systemPrompt: "You review code. Be terse.",
      })),
    };
    expect(statuses(edited)).toEqual([
      ["agent", true],
      ["skill", true],
    ]);
    let merged: Library = edited;
    for (const update of agentTemplateUpdates(edited, current, "1.1.0")) {
      merged = markAgentTemplateMerged(merged, update, now);
    }
    expect(statuses(merged)).toEqual([]);
    expect(merged.mcpGatewayProfiles[0]!.systemPrompt).toBe("You review code. Be terse.");
    expect(merged.agentSkills[0]!.digest).toBe(edited.agentSkills[0]!.digest);
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

  it("treats a copy from before records as edited only when it differs from the template", () => {
    const strip = <T extends { template?: unknown }>({ template: _template, ...item }: T) => item;
    const stale = installed(older);
    const legacy = {
      agentSkills: stale.agentSkills.map(strip),
      mcpGatewayProfiles: stale.mcpGatewayProfiles.map(strip),
    };
    expect(statuses(legacy)).toEqual([
      ["agent", true],
      ["skill", true],
    ]);
    const fresh = installed(current);
    expect(
      statuses({
        agentSkills: fresh.agentSkills.map(strip),
        mcpGatewayProfiles: fresh.mcpGatewayProfiles.map(strip),
      }),
    ).toEqual([]);
    const seeded = { ...legacy.agentSkills[0]!, skillId: "t3-default-review-checklist" };
    expect(statuses({ agentSkills: [seeded], mcpGatewayProfiles: [] })).toEqual([["skill", false]]);
    expect(statuses({ agentSkills: [{ ...seeded, revision: 2 }], mcpGatewayProfiles: [] })).toEqual(
      [["skill", true]],
    );
  });

  it("leaves a copy recorded by a newer app alone", () => {
    expect(
      statuses(
        installed(
          builtIns("2.0.0", (copy) => {
            copy["presets/reviewer/system-prompt.md"] = "Newer.";
          }),
        ),
      ),
    ).toEqual([]);
  });
});
