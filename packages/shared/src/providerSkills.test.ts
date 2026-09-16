import type { ProviderSkillKey, ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveEffectiveSkills, resolveProviderSkillSourceKind } from "./providerSkills.ts";

const skill = (
  name: string,
  overrides: Partial<ServerProviderSkill> = {},
): ServerProviderSkill => ({
  name,
  path: `/home/dev/.claude/skills/${name}/SKILL.md`,
  scope: "user",
  enabled: true,
  ...overrides,
});

const personal = (name: string) => ({ source: "personal" as const, name });

describe("resolveProviderSkillSourceKind", () => {
  it.each([
    ["/home/dev/.codex/plugins/pack/skills/deploy", undefined, "app"],
    ["C:\\Users\\dev\\.agents\\plugins\\pack\\deploy", "user", "app"],
    ["/repo/.claude/skills/deploy", "repository", "repo"],
    ["/repo/.t3/skills/deploy", "workspace", "project"],
    ["/home/dev/.claude/skills/deploy", "personal", "personal"],
    ["/usr/share/skills/deploy", "system", "system"],
    ["/somewhere/deploy", undefined, "other"],
    ["/somewhere/deploy", "  ", "other"],
    ["/somewhere/deploy", "mystery", "other"],
  ])("classifies %s (scope %s) as %s", (path, scope, expected) => {
    expect(resolveProviderSkillSourceKind({ path, ...(scope ? { scope } : {}) })).toBe(expected);
  });
});

describe("resolveEffectiveSkills", () => {
  it("leaves every skill alone with no configuration", () => {
    const skills = [skill("review"), skill("deploy")];
    expect(resolveEffectiveSkills({ skills, disabledSkills: [] })).toEqual(skills);
  });

  it("disables a skill matched by the environment list", () => {
    const [review, deploy] = resolveEffectiveSkills({
      skills: [skill("review"), skill("deploy")],
      disabledSkills: [personal("review")],
    });
    expect(review).toMatchObject({ name: "review", enabled: false, disabledBy: "settings" });
    expect(deploy).toMatchObject({ name: "deploy", enabled: true });
    expect(deploy?.disabledBy).toBeUndefined();
  });

  it.each<[string, ProviderSkillKey]>([
    ["mixed case", { source: "personal", name: "ReVieW" }],
    ["surrounding whitespace", { source: "personal", name: "  review  " }],
  ])("matches a key with %s", (_label, key) => {
    const [review] = resolveEffectiveSkills({
      skills: [skill(" Review ")],
      disabledSkills: [key],
    });
    expect(review).toMatchObject({ enabled: false, disabledBy: "settings" });
  });

  it("keeps a skill whose source kind differs from the key", () => {
    const [review] = resolveEffectiveSkills({
      skills: [skill("review", { scope: "repository" })],
      disabledSkills: [personal("review")],
    });
    expect(review).toMatchObject({ enabled: true });
    expect(review?.disabledBy).toBeUndefined();
  });

  it("disables the same key for every provider that reports it", () => {
    const claude = skill("review");
    const grok = skill("review", { path: "/home/dev/.grok/skills/review/SKILL.md" });
    for (const skills of [[claude], [grok]]) {
      const [folded] = resolveEffectiveSkills({ skills, disabledSkills: [personal("review")] });
      expect(folded).toMatchObject({ enabled: false, disabledBy: "settings" });
    }
  });

  it("keeps a provider's own disable as the reason, even when the user disabled it too", () => {
    const [byProvider, unattributed] = resolveEffectiveSkills({
      skills: [
        skill("review", { enabled: false, disabledBy: "provider" }),
        skill("deploy", { enabled: false }),
      ],
      disabledSkills: [personal("review"), personal("deploy")],
    });
    expect(byProvider).toMatchObject({ enabled: false, disabledBy: "provider" });
    expect(unattributed).toMatchObject({ enabled: false, disabledBy: "provider" });
  });

  it("ignores a stale key without pruning it or touching the list", () => {
    const skills = [skill("review")];
    const disabledSkills = [personal("skill-from-another-worktree")];
    expect(resolveEffectiveSkills({ skills, disabledSkills })).toEqual(skills);
    expect(disabledSkills).toEqual([personal("skill-from-another-worktree")]);
  });
});
