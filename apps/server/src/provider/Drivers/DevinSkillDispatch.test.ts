import { describe, expect, it } from "vite-plus/test";

import { planDevinSkillDispatch } from "./DevinSkillDispatch.ts";

const SKILLS = new Set(["2spec", "deploy", "implement", "review", "re-release-version"]);

describe("planDevinSkillDispatch", () => {
  it("leaves a prompt without a known skill untouched", () => {
    expect(planDevinSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    // Not a discovered skill, so it stays prose rather than becoming an invocation.
    expect(planDevinSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("rewrites a known token into Devin's native mention", () => {
    expect(planDevinSkillDispatch("$deploy", SKILLS)).toEqual({
      prompt: "@skills:deploy",
      skillName: "deploy",
    });
  });

  it("preserves trailing arguments after the token", () => {
    expect(planDevinSkillDispatch("$deploy staging", SKILLS)).toEqual({
      prompt: "@skills:deploy staging",
      skillName: "deploy",
    });
  });

  it("preserves surrounding text around a mid-prompt mention", () => {
    expect(planDevinSkillDispatch("ok, now $deploy all the tickets", SKILLS)).toEqual({
      prompt: "ok, now @skills:deploy all the tickets",
      skillName: "deploy",
    });
  });

  it("preserves a mention that opens the prompt", () => {
    expect(planDevinSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      prompt: "@skills:review\nfocus on auth",
      skillName: "review",
    });
  });

  it("rewrites multiple mentions and keeps the last name for diagnostics", () => {
    expect(planDevinSkillDispatch("$review the diff, then $deploy the fixes", SKILLS)).toEqual({
      prompt: "@skills:review the diff, then @skills:deploy the fixes",
      skillName: "deploy",
    });
  });

  it("preserves unknown tokens and $HOME", () => {
    expect(planDevinSkillDispatch("echo $HOME then $deploy", SKILLS)).toEqual({
      prompt: "echo $HOME then @skills:deploy",
      skillName: "deploy",
    });
    expect(planDevinSkillDispatch("echo $HOME", SKILLS)).toBeUndefined();
    expect(planDevinSkillDispatch("echo $unknown then $deploy", SKILLS)).toEqual({
      prompt: "echo $unknown then @skills:deploy",
      skillName: "deploy",
    });
  });

  it("does not infer a skill from a path-like token", () => {
    // A filesystem path is never a skill mention, even when a segment matches.
    expect(planDevinSkillDispatch("check src/$deploy/config.ts", SKILLS)).toBeUndefined();
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planDevinSkillDispatch("cost is 5$deploy", SKILLS)).toBeUndefined();
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = new Set([...SKILLS, "20", "20k", "100M"]);
    expect(planDevinSkillDispatch("pay $20 tomorrow", skillsWithCurrency)).toBeUndefined();
    expect(planDevinSkillDispatch("budget is $20k tomorrow", skillsWithCurrency)).toBeUndefined();
  });

  it("dispatches a known skill whose name begins with a digit", () => {
    expect(planDevinSkillDispatch("use $2spec for this", SKILLS)).toEqual({
      prompt: "use @skills:2spec for this",
      skillName: "2spec",
    });
  });

  it("dispatches a hyphenated skill name", () => {
    expect(planDevinSkillDispatch("run $re-release-version now", SKILLS)).toEqual({
      prompt: "run @skills:re-release-version now",
      skillName: "re-release-version",
    });
  });
});
