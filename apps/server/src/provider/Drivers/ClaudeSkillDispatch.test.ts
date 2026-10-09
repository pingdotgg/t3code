import { describe, expect, it } from "vite-plus/test";

import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const SKILLS = new Set(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  it.each([
    ["Review\tUI", '$"Review\tUI"'],
    ["Review\u00a0UI", '$"Review\u00a0UI"'],
    ["Review\nUI", '$"Review\\nUI"'],
    ["Review\rUI", '$"Review\\rUI"'],
    ["Review\r\nUI", '$"Review\\r\\nUI"'],
  ])("leaves the whitespace-containing catalog name %j as literal text", (name, source) => {
    expect(planClaudeSkillDispatch(`Use ${source} next`, new Set([name]))).toBeUndefined();
  });

  it("does not invoke a multiword skill's first word as a different command", () => {
    expect(
      planClaudeSkillDispatch('use $"Poteto Mode" for this', new Set(["Poteto Mode", "Poteto"])),
    ).toBeUndefined();
  });

  it("preserves multiword references around a dispatchable skill", () => {
    const names = new Set([...SKILLS, "Poteto Mode", "Poteto"]);
    expect(planClaudeSkillDispatch('$"Poteto Mode" then $review this', names)).toEqual({
      leadingText: '$"Poteto Mode" then',
      commandText: "/review this",
      skillName: "review",
    });
    expect(planClaudeSkillDispatch('$review then $"Poteto Mode"', names)).toEqual({
      leadingText: undefined,
      commandText: '/review then $"Poteto Mode"',
      skillName: "review",
    });
    expect(planClaudeSkillDispatch('$review then $"Poteto Mode" and $implement', names)).toEqual({
      leadingText: '/review then $"Poteto Mode" and',
      commandText: "/implement",
      skillName: "implement",
    });
  });

  it("dispatches a quoted single-word skill", () => {
    expect(planClaudeSkillDispatch('$"review" this', SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review this",
      skillName: "review",
    });
  });

  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    // Not a discovered skill, so it stays prose rather than becoming a command.
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("moves a mid-prompt mention into a trailing slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
  });

  it("dispatches a known skill whose name begins with a digit", () => {
    expect(planClaudeSkillDispatch("use $2spec for this", SKILLS)).toEqual({
      leadingText: "use",
      commandText: "/2spec for this",
      skillName: "2spec",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("dispatches currency-prefixed mentions and preserves their source boundaries", () => {
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `${symbol}review the diff, then ${symbol}implement the fixes`,
          SKILLS,
        ),
      ).toEqual({
        leadingText: "/review the diff, then",
        commandText: "/implement the fixes",
        skillName: "implement",
      });
      expect(planClaudeSkillDispatch(`${symbol}2spec for this`, SKILLS)).toEqual({
        leadingText: undefined,
        commandText: "/2spec for this",
        skillName: "2spec",
      });
      expect(planClaudeSkillDispatch(`5${symbol}review ${symbol}unknown`, SKILLS)).toBeUndefined();
    }
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = new Set([...SKILLS, "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });
});
