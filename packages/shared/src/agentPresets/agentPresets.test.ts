// @effect-diagnostics nodeBuiltinImport:off -- Reads the fixture and bundled preset folders the way a bundler sees them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  agentSkillDigest,
  toAgentSkillStub,
  type AgentSkill,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addPresetSkills,
  agentPresetFilesFromArchive,
  decodeAgentPresets,
  exportAgentPresets,
  presetSkillConflicts,
  type AgentPresetSkill,
} from "./agentPresets.ts";

function readTree(root: string, directory: string): Record<string, string> {
  const base = NodePath.join(root, directory);
  if (!NodeFS.existsSync(base)) return {};
  return Object.fromEntries(
    NodeFS.readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        const path = NodePath.relative(root, file).split(NodePath.sep).join("/");
        return [path, NodeFS.readFileSync(file, "utf8")];
      }),
  );
}

const fixtureRoot = NodePath.join(import.meta.dirname, "fixtures");
const fixtures = { ...readTree(fixtureRoot, "presets"), ...readTree(fixtureRoot, "skills") };
const manifest = (overrides: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(fixtures["presets/reviewer/preset.json"]!), ...overrides });

describe("decodeAgentPresets", () => {
  it("decodes a preset folder into profile fields, prompt and skill bundles", () => {
    const [preset] = decodeAgentPresets(fixtures);
    expect(preset).toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      icon: "shield",
      model: { provider: "codex", model: "gpt-5.5", reasoningEffort: "high" },
      runtimeMode: "read-only",
      systemPrompt: "You review code changes. Report correctness bugs first, then missing tests.",
      setupNotes: ["Needs the GitHub CLI (gh) signed in to read pull requests."],
    });
    expect(preset!.skills).toHaveLength(1);
    const skill = preset!.skills[0]!;
    expect(skill.name).toBe("review-checklist");
    expect(skill.description).toBe("Checklist for reviewing a diff: correctness, tests, naming.");
    expect(skill.content).toBe(fixtures["skills/review-checklist/SKILL.md"]!.trim());
    expect(skill.resources).toEqual([
      {
        path: "scripts/count.sh",
        contentBase64: Buffer.from(fixtures["skills/review-checklist/scripts/count.sh"]!).toString(
          "base64",
        ),
        executable: true,
      },
    ]);
  });

  it.each([
    [
      "a folder that disagrees with its id",
      { "presets/reviewer/preset.json": manifest({ id: "other" }) },
      /does not match/,
    ],
    [
      "a missing system prompt",
      { "presets/reviewer/system-prompt.md": undefined },
      /system-prompt\.md/,
    ],
    [
      "a skill missing from the pool",
      { "skills/review-checklist/SKILL.md": undefined },
      /"review-checklist" is not in the skills pool/,
    ],
    ["an unknown icon", { "presets/reviewer/preset.json": manifest({ icon: "rocket" }) }, /icon/],
  ])("names the preset when it has %s", (_label, overrides, message) => {
    const files: Record<string, string> = { ...fixtures };
    for (const [path, value] of Object.entries(overrides)) {
      if (value === undefined) delete files[path];
      else files[path] = value;
    }
    expect(() => decodeAgentPresets(files)).toThrow(/Agent preset "reviewer" is invalid/);
    expect(() => decodeAgentPresets(files)).toThrow(message);
  });

  it("decodes every bundled preset and keeps the pool UTF-8 text", () => {
    const root = import.meta.dirname;
    const bundled = { ...readTree(root, "presets"), ...readTree(root, "skills") };
    const presets = decodeAgentPresets(bundled);
    expect(presets.map((preset) => preset.id)).toEqual(
      Object.keys(bundled)
        .filter((path) => /^presets\/[^/]+\/preset\.json$/.test(path))
        .map((path) => path.split("/")[1])
        .sort(),
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const path of Object.keys(bundled)) {
      expect(
        () => decoder.decode(NodeFS.readFileSync(NodePath.join(root, path))),
        path,
      ).not.toThrow();
    }
  });
});

describe("addPresetSkills", () => {
  const options = { now: "2026-10-29T00:00:00.000Z", makeId: () => "new-skill" };
  const presetSkill = decodeAgentPresets(fixtures)[0]!.skills[0]!;
  const librarySkill = (overrides: Partial<AgentSkill>): AgentSkill => ({
    skillId: "existing",
    name: "My checklist",
    description: "",
    content: presetSkill.content,
    resources: presetSkill.resources,
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("reuses a library skill with identical content and files, whatever its name", () => {
    const library = [librarySkill({})];
    expect(addPresetSkills(library, [presetSkill], options)).toEqual({
      agentSkills: library,
      skillIds: ["existing"],
    });
  });

  it.each([
    ["content", { content: "# Different" }],
    ["files", { resources: [] }],
  ])("adds a new skill when the %s differ", (_label, overrides) => {
    const library = [librarySkill(overrides)];
    const result = addPresetSkills(library, [presetSkill], options);
    expect(result.skillIds).toEqual(["new-skill"]);
    expect(result.agentSkills).toEqual([
      ...library,
      {
        skillId: "new-skill",
        name: "review-checklist",
        description: presetSkill.description,
        content: presetSkill.content,
        resources: presetSkill.resources,
        revision: 1,
        createdAt: options.now,
        updatedAt: options.now,
      },
    ]);
  });

  it.each([
    ["no choice reuses the newest same-named copy", undefined, ["newer"], 2],
    ["reuse keeps the chosen copy", { kind: "reuse", skillId: "older" } as const, ["older"], 2],
    ["new adds a copy beside them", { kind: "new" } as const, ["new-skill"], 3],
  ])("when names match but text differs, %s", (_label, choice, skillIds, count) => {
    const library = [
      librarySkill({ skillId: "older", name: "review-checklist", content: "# Old" }),
      librarySkill({
        skillId: "newer",
        name: "Review-Checklist",
        content: "# Newer",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    ];
    const result = addPresetSkills(
      library,
      [{ ...presetSkill, ...(choice && { choice }) }],
      options,
    );
    expect(result.skillIds).toEqual(skillIds);
    expect(result.agentSkills).toHaveLength(count);
    expect(result.agentSkills.slice(0, 2)).toEqual(library);
  });

  it("updates the chosen skill in place at its own revision, keeping its id so agents keep pointing at it", () => {
    const library = [
      librarySkill({ skillId: "older", name: "review-checklist", content: "# Old", resources: [] }),
      librarySkill({ skillId: "other", name: "other", content: "# Other" }),
    ];
    const result = addPresetSkills(
      library,
      [{ ...presetSkill, choice: { kind: "update", skillId: "older" } }],
      options,
    );
    expect(result.skillIds).toEqual(["older"]);
    expect(result.agentSkills).toEqual([
      {
        ...library[0],
        description: presetSkill.description,
        content: presetSkill.content,
        resources: presetSkill.resources,
        // The base revision the edit was made against; the server bumps it.
        revision: 3,
        updatedAt: options.now,
      },
      library[1],
    ]);
  });

  it("updates a metadata stub into a full skill", () => {
    const stub = toAgentSkillStub(
      librarySkill({ name: "review-checklist", content: "# Old" }),
      "digest",
    );
    const result = addPresetSkills(
      [stub],
      [{ ...presetSkill, choice: { kind: "update", skillId: "existing" } }],
      options,
    );
    expect(result.agentSkills[0]).not.toHaveProperty("contentOmitted");
    expect(result.agentSkills[0]).not.toHaveProperty("digest");
    expect(result.agentSkills[0]!.content).toBe(presetSkill.content);
  });

  it("adds one skill when a preset lists the same bundle twice", () => {
    let id = 0;
    const twin: AgentPresetSkill = { ...presetSkill, name: "twin" };
    const result = addPresetSkills([], [presetSkill, twin], {
      ...options,
      makeId: () => `s${++id}`,
    });
    expect(result.skillIds).toEqual(["s1"]);
    expect(result.agentSkills).toHaveLength(1);
  });
});

describe("presetSkillConflicts", () => {
  const [presetSkill] = decodeAgentPresets(fixtures)[0]!.skills;
  const skill = (overrides: Partial<AgentSkill>): AgentSkill => ({
    skillId: "a",
    name: "review-checklist",
    description: "",
    content: "# Mine",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("lists same-named copies newest first and defaults to reusing the newest", () => {
    const library = [
      skill({ skillId: "a" }),
      skill({ skillId: "b", updatedAt: "2026-03-01T00:00:00.000Z" }),
      skill({ skillId: "c", name: "unrelated" }),
    ];
    expect(presetSkillConflicts(library, [presetSkill!])).toEqual([
      {
        index: 0,
        name: "review-checklist",
        candidates: [library[1], library[0]],
        defaultChoice: { kind: "reuse", skillId: "b" },
      },
    ]);
  });

  it.each([
    [
      "an identical copy exists under any name",
      [skill({ name: "x", content: presetSkill!.content, resources: presetSkill!.resources })],
    ],
    ["no library skill shares the name", [skill({ name: "other" })]],
    [
      "a metadata stub carries the same body",
      [
        toAgentSkillStub(
          skill({ content: presetSkill!.content, resources: presetSkill!.resources }),
          agentSkillDigest(presetSkill!),
        ),
      ],
    ],
  ])("reports nothing when %s", (_label, library) => {
    expect(presetSkillConflicts(library, [presetSkill!])).toEqual([]);
  });
});

describe("exportAgentPresets", () => {
  const [presetSkill] = decodeAgentPresets(fixtures)[0]!.skills;
  const library: ReadonlyArray<AgentSkill> = [
    {
      skillId: "s1",
      name: "review-checklist",
      description: presetSkill!.description,
      content: presetSkill!.content,
      resources: presetSkill!.resources,
      revision: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      skillId: "s2",
      name: "Plain notes",
      description: "",
      content: "# Notes without frontmatter",
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const profile: McpGatewayProfile = {
    profileId: "p1",
    name: "My Reviewer",
    description: "Reviews diffs",
    color: "#2f80ed",
    icon: "shield",
    iconId: "bug",
    tags: ["Dev", "security"],
    systemPrompt: "Review carefully.",
    skillIds: ["s1", "s2"],
    providerLabel: "Codex",
    modelLabel: "gpt-5.5",
    reasoningEffort: "high",
    runtimeMode: "read-only",
    interactionMode: "default",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("round-trips a profile and its skills through the preset folder format", () => {
    const files = exportAgentPresets([profile, { ...profile, profileId: "p2" }], library);
    expect(Object.keys(files).sort()).toEqual([
      "presets/my-reviewer-2/preset.json",
      "presets/my-reviewer-2/system-prompt.md",
      "presets/my-reviewer/preset.json",
      "presets/my-reviewer/system-prompt.md",
      "skills/Plain-notes/SKILL.md",
      "skills/review-checklist/SKILL.md",
      "skills/review-checklist/scripts/count.sh",
    ]);
    const [preset] = decodeAgentPresets(files);
    expect(preset).toMatchObject({
      id: "my-reviewer",
      name: "My Reviewer",
      description: "Reviews diffs",
      icon: "shield",
      iconId: "bug",
      tags: ["Dev", "security"],
      model: { provider: "Codex", model: "gpt-5.5", reasoningEffort: "high" },
      runtimeMode: "read-only",
      systemPrompt: "Review carefully.",
    });
    expect(preset!.skills.map(({ name, content }) => [name, content])).toEqual([
      ["review-checklist", presetSkill!.content],
      ["Plain-notes", "# Notes without frontmatter"],
    ]);
    const added = addPresetSkills(library, preset!.skills, { now: "now", makeId: () => "x" });
    expect(added).toEqual({ agentSkills: library, skillIds: ["s1", "s2"] });
  });

  it("writes the legacy icon beside an iconId saved without one", () => {
    const { icon: _icon, ...withoutIcon } = profile;
    const [preset] = decodeAgentPresets(exportAgentPresets([withoutIcon], library));
    expect(preset).toMatchObject({ icon: "shield", iconId: "bug" });
  });

  it("refuses to drop an assigned skill it could not load, naming it and its agents", () => {
    const stub = toAgentSkillStub(library[1]!, "digest");
    expect(() =>
      exportAgentPresets(
        [profile, { ...profile, profileId: "p2", name: "Other", skillIds: ["gone"] }],
        [library[0]!, stub],
      ),
    ).toThrow('Could not load skills: "Plain notes" (My Reviewer), gone (Other).');
  });

  it("refuses a skill file that is not UTF-8 text", () => {
    const binary = { ...library[1]!, resources: [{ path: "img.bin", contentBase64: "/w==" }] };
    expect(() => exportAgentPresets([profile], [library[0]!, binary])).toThrow(/img\.bin/);
  });

  it("reads an archive that wraps the tree in one folder", () => {
    const files = exportAgentPresets([profile], library);
    const encoder = new TextEncoder();
    const entries = Object.entries(files).map(
      ([path, text]) => [`export/${path}`, encoder.encode(text)] as const,
    );
    expect(agentPresetFilesFromArchive([["export/", new Uint8Array()], ...entries])).toEqual(files);
  });
});
