import { describe, expect, it } from "vite-plus/test";

import { continuumSkillContext, parseContinuumCommand } from "./continuumCommands.ts";

describe("parseContinuumCommand", () => {
  it.each([
    ["/review src/auth", "review", "src/auth"],
    ["  /DEBUG   login fails\nafter refresh ", "debug", "login fails\nafter refresh"],
    ["/forge", "forge", ""],
  ])("parses %j", (text, name, args) => {
    expect(parseContinuumCommand(text)).toMatchObject({ spec: { name }, args });
  });

  it.each(["review this", "/reviewer x", "/model", "please /review", "/side hi"])(
    "ignores %j",
    (text) => {
      expect(parseContinuumCommand(text)).toBeNull();
    },
  );

  it("honors the available set", () => {
    expect(parseContinuumCommand("/review", new Set(["debug"]))).toBeNull();
    expect(parseContinuumCommand("/debug x", new Set(["debug"]))?.spec.name).toBe("debug");
  });
});

describe("continuumSkillContext", () => {
  it("wraps a skill's procedure for the turn", () => {
    const context = continuumSkillContext("/test the cart total");
    expect(context).toContain('<continuum_skill name="test">');
    expect(context).toContain("Write tests for what the user names");
    expect(context?.endsWith("</continuum_skill>")).toBe(true);
  });

  it("returns null for actions and ordinary messages", () => {
    expect(continuumSkillContext("/improve make it faster")).toBeNull();
    expect(continuumSkillContext("fix the build")).toBeNull();
  });
});
