import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { AgentSkill, agentSkillDigest, toAgentSkillStub } from "./agentSkills.ts";
import { agentSkillTieKey, mergeAgentLibraries, type McpGatewayProfile } from "./settings.ts";
const decodeSkill = Schema.decodeUnknownSync(AgentSkill);
const profile = (id: string, updatedAt: string, name = id): McpGatewayProfile => ({
  profileId: id,
  name,
  updatedAt,
  createdAt: "2026-01-01",
  revision: 1,
  runtimeMode: "auto",
  interactionMode: "default",
});
describe("agent library convergence", () => {
  it("merges independent edits and converges regardless of environment order", () => {
    const a = {
      mcpGatewayProfiles: [profile("one", "2026-01-03", "New name"), profile("two", "2026-01-01")],
    };
    const b = {
      mcpGatewayProfiles: [
        profile("one", "2026-01-01"),
        { ...profile("two", "2026-01-04"), color: "#123456", icon: "code" as const },
      ],
    };
    const merged = mergeAgentLibraries([a, b]);
    expect(mergeAgentLibraries([b, a])).toEqual(merged);
    expect(merged.mcpGatewayProfiles).toMatchObject([
      { name: "New name" },
      { color: "#123456", icon: "code" },
    ]);
    expect(mergeAgentLibraries([merged, a, b])).toEqual(merged);
  });
  it("does not resurrect a deleted agent when an old device reconnects", () => {
    const stale = { mcpGatewayProfiles: [profile("one", "2026-01-01")] };
    const deleted = { mcpGatewayProfiles: [], mcpGatewayProfileDeletedAt: { one: "2026-01-02" } };
    expect(mergeAgentLibraries([stale, deleted]).mcpGatewayProfiles).toEqual([]);
    expect(mergeAgentLibraries([deleted, stale])).toEqual(mergeAgentLibraries([stale, deleted]));
  });
  it("allows a newer explicit edit while retaining independent agents", () => {
    const merged = mergeAgentLibraries([
      {
        mcpGatewayProfiles: [profile("one", "2026-01-03"), profile("two", "2026-01-01")],
        mcpGatewayProfileDeletedAt: { one: "2026-01-02" },
      },
    ]);
    expect(merged.mcpGatewayProfiles).toHaveLength(2);
  });
});

it("propagates reusable skill edits and deletions without changing agent assignments", () => {
  const skill = {
    skillId: "review",
    name: "Review",
    description: "Review code",
    content: "Old rules",
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const original = {
    mcpGatewayProfiles: [{ ...profile("randy", "2026-01-01"), skillIds: ["review"] }],
    agentSkills: [skill],
  };
  const edited = {
    mcpGatewayProfiles: [],
    agentSkills: [{ ...skill, revision: 2, content: "New rules", updatedAt: "2026-01-02" }],
  };
  const merged = mergeAgentLibraries([original, edited]);
  expect(merged.agentSkills[0]?.content).toBe("New rules");
  expect(merged.mcpGatewayProfiles[0]?.skillIds).toEqual(["review"]);
  expect(mergeAgentLibraries([edited, original])).toEqual(merged);
  const deleted = { mcpGatewayProfiles: [], agentSkillDeletedAt: { review: "2026-01-03" } };
  expect(mergeAgentLibraries([merged, deleted, original]).agentSkills).toEqual([]);
  expect(mergeAgentLibraries([deleted, merged, original]).agentSkills).toEqual([]);
});

it("keeps assignments when an older server echoes the same revision without skill support", () => {
  const assigned = { ...profile("randy", "2026-01-01"), skillIds: ["review"] };
  const library = mergeAgentLibraries([{ mcpGatewayProfiles: [assigned] }]);
  const { skillIds: _skillIds, ...stripped } = library.mcpGatewayProfiles[0]!;
  const legacy = { mcpGatewayProfiles: [stripped] };
  expect(mergeAgentLibraries([legacy, library]).mcpGatewayProfiles[0]?.skillIds).toEqual([
    "review",
  ]);
  expect(mergeAgentLibraries([library, legacy]).mcpGatewayProfiles[0]?.skillIds).toEqual([
    "review",
  ]);
});

describe("agent name clashes", () => {
  it("keeps both agents and renames the later one the same way on every machine", () => {
    const first = { ...profile("a", "2026-01-05", "Doug"), createdAt: "2026-01-01" };
    const second = { ...profile("b", "2026-01-02", "doug"), createdAt: "2026-01-02" };
    const third = { ...profile("c", "2026-01-03", "Doug"), createdAt: "2026-01-03" };
    const taken = profile("d", "2026-01-01", "doug (2)");
    const merged = mergeAgentLibraries([
      { mcpGatewayProfiles: [first, taken] },
      { mcpGatewayProfiles: [second, third] },
    ]);
    expect(merged.mcpGatewayProfiles.map((p) => [p.profileId, p.name])).toEqual([
      ["a", "Doug"],
      ["d", "doug (2)"],
      ["b", "doug (3)"],
      ["c", "Doug (4)"],
    ]);
    expect(
      mergeAgentLibraries([
        { mcpGatewayProfiles: [third, second] },
        { mcpGatewayProfiles: [taken, first] },
      ]),
    ).toEqual(merged);
    expect(mergeAgentLibraries([merged, { mcpGatewayProfiles: [second] }])).toEqual(merged);
  });
});

it("prefers the copy carrying icon and tags over an older server's stripped echo", () => {
  const tagged = { ...profile("randy", "2026-01-01"), iconId: "rocket", tags: ["Dev"] };
  const { iconId: _iconId, tags: _tags, ...stripped } = tagged;
  for (const libraries of [
    [{ mcpGatewayProfiles: [tagged] }, { mcpGatewayProfiles: [stripped] }],
    [{ mcpGatewayProfiles: [stripped] }, { mcpGatewayProfiles: [tagged] }],
  ])
    expect(mergeAgentLibraries(libraries).mcpGatewayProfiles[0]).toMatchObject({
      iconId: "rocket",
      tags: ["Dev"],
    });
});

describe("skill stubs", () => {
  const full: AgentSkill = {
    skillId: "review",
    name: "Review",
    description: "Review code",
    content: "Rules",
    resources: [{ path: "scripts/check.sh", contentBase64: "b2s=", executable: true }],
    revision: 2,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
  };
  const stub = toAgentSkillStub(full, agentSkillDigest(full));

  it("stays decodable without its body and names the same version as the full skill", () => {
    expect(decodeSkill(stub)).toEqual(stub);
    expect(stub).not.toHaveProperty("resources");
    expect(stub).toMatchObject({ contentOmitted: true, resourceCount: 1 });
    expect(agentSkillTieKey(stub)).toBe(agentSkillTieKey(full));
    expect(agentSkillDigest({ ...full, content: "Other" })).not.toBe(stub.digest);
  });

  it("merges a stub and its full skill to the full skill in either order", () => {
    expect(
      mergeAgentLibraries([
        { mcpGatewayProfiles: [], agentSkills: [stub] },
        { mcpGatewayProfiles: [], agentSkills: [full] },
      ]).agentSkills,
    ).toEqual([full]);
    expect(
      mergeAgentLibraries([
        { mcpGatewayProfiles: [], agentSkills: [full] },
        { mcpGatewayProfiles: [], agentSkills: [stub] },
      ]).agentSkills,
    ).toEqual([full]);
  });

  it("breaks a same-timestamp tie by body digest, so stubs and full skills agree", () => {
    const other = { ...full, content: "Other rules" };
    const otherStub = toAgentSkillStub(other, agentSkillDigest(other));
    const fromFull = mergeAgentLibraries([
      { mcpGatewayProfiles: [], agentSkills: [full] },
      { mcpGatewayProfiles: [], agentSkills: [other] },
    ]).agentSkills[0];
    const fromStubs = mergeAgentLibraries([
      { mcpGatewayProfiles: [], agentSkills: [otherStub] },
      { mcpGatewayProfiles: [], agentSkills: [stub] },
    ]).agentSkills[0];
    expect(agentSkillTieKey(fromStubs!)).toBe(agentSkillTieKey(fromFull!));
  });
});
