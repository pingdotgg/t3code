import { describe, expect, it } from "vite-plus/test";

import { planClaudeSkillDispatch, type ClaudeSkillTarget } from "./ClaudeSkillDispatch.ts";

const skillPath = (name: string) => `/home/me/.claude/skills/${name}/SKILL.md`;

const INTERROGATE_NOTE = `[The user invoked this skill. Follow the instructions at: ${skillPath("interrogate")}]`;

const skillMap = (names: Iterable<string>, userInvocationOnly: ReadonlyArray<string> = []) =>
  new Map<string, ClaudeSkillTarget>(
    [...names].map((name): [string, ClaudeSkillTarget] => [
      name,
      {
        path: skillPath(name),
        ...(userInvocationOnly.includes(name) ? { userInvocationOnly: true } : {}),
      },
    ]),
  );

const SKILLS = skillMap(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
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
    const skillsWithCurrency = skillMap([...SKILLS.keys(), "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });

  describe("earlier skills the model may not start itself", () => {
    const skills = skillMap(
      ["interrogate", "poteto-mode", "review"],
      ["interrogate", "poteto-mode"],
    );

    it("tells the model the user invoked an earlier user-only skill and where it lives", () => {
      expect(planClaudeSkillDispatch("$interrogate and $poteto-mode pleas", skills)).toEqual({
        leadingText: `/interrogate ${INTERROGATE_NOTE} and`,
        commandText: "/poteto-mode pleas",
        skillName: "poteto-mode",
      });
    });

    it("leaves an earlier skill the model may start as a bare slash name", () => {
      expect(planClaudeSkillDispatch("$review then $interrogate", skills)).toEqual({
        leadingText: "/review then",
        commandText: "/interrogate",
        skillName: "interrogate",
      });
    });

    it("does not annotate the dispatched skill when it is named twice", () => {
      expect(planClaudeSkillDispatch("$interrogate again $interrogate", skills)).toEqual({
        leadingText: "/interrogate again",
        commandText: "/interrogate",
        skillName: "interrogate",
      });
    });

    it("annotates a repeated earlier user-only skill only once", () => {
      expect(
        planClaudeSkillDispatch("$interrogate then $interrogate then $review", skills),
      ).toEqual({
        leadingText: `/interrogate ${INTERROGATE_NOTE} then /interrogate then`,
        commandText: "/review",
        skillName: "review",
      });
    });
  });
});
