import { describe, expect, it } from "vitest";

import { claudeSlashCommandsAsProviderSkills } from "./claudeSlashCommandsAsProviderSkills.ts";

describe("claudeSlashCommandsAsProviderSkills", () => {
  it("maps slash commands to skills with stable synthetic paths", () => {
    const skills = claudeSlashCommandsAsProviderSkills([
      { name: "frontend-design", description: "UI help" },
      { name: "gh-fix-ci", input: { hint: "[pr-url]" } },
    ]);
    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: "frontend-design",
      enabled: true,
      scope: "claude-agent",
      description: "UI help",
      shortDescription: "UI help",
      path: "claude-agent:///slash-command/frontend-design",
    });
    expect(skills[1]).toMatchObject({
      name: "gh-fix-ci",
      enabled: true,
      scope: "claude-agent",
      shortDescription: "[pr-url]",
      path: "claude-agent:///slash-command/gh-fix-ci",
    });
  });

  it("encodes command names in the path", () => {
    const [skill] = claudeSlashCommandsAsProviderSkills([{ name: "a:b" }]);
    expect(skill?.path).toBe("claude-agent:///slash-command/a%3Ab");
    expect(skill?.name).toBe("a:b");
  });
});
