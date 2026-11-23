import { describe, expect, it } from "@effect/vitest";
import type { UserCommand } from "@t3tools/contracts";

import { expandHome, resolveUserCommands, splitCommandArgs } from "./resolveUserCommands.ts";

const command = (name: string, description = name): UserCommand => ({
  name,
  description,
  run: ["echo"],
  output: "markdown",
});

describe("resolveUserCommands", () => {
  it("lets a project command replace a user one of the same name", () => {
    const { commands } = resolveUserCommands({
      user: [command("graph", "user"), command("lint")],
      project: [command("graph", "project")],
    });
    expect(commands.map((entry) => [entry.name, entry.description, entry.source])).toEqual([
      ["graph", "project", "project"],
      ["lint", "lint", "user"],
    ]);
  });

  it("ignores built-in names and reports them", () => {
    const { commands, ignored } = resolveUserCommands({
      user: [command("model"), command("ok")],
      project: [command("clear")],
    });
    expect(commands.map((entry) => entry.name)).toEqual(["ok"]);
    expect(ignored).toEqual([
      { name: "model", source: "user" },
      { name: "clear", source: "project" },
    ]);
  });
});

describe("splitCommandArgs", () => {
  it("splits on whitespace and keeps quoted text together", () => {
    expect(splitCommandArgs(`  all "two words"  'a b' c"d e"f `)).toEqual([
      "all",
      "two words",
      "a b",
      "cd ef",
    ]);
    expect(splitCommandArgs("")).toEqual([]);
    expect(splitCommandArgs('""')).toEqual([""]);
  });
});

describe("expandHome", () => {
  const join = (...parts: ReadonlyArray<string>) => parts.join("/");
  it("expands only a leading tilde", () => {
    expect(expandHome("~", "/home/me", join)).toBe("/home/me");
    expect(expandHome("~/bin/tool", "/home/me", join)).toBe("/home/me/bin/tool");
    expect(expandHome("a~b", "/home/me", join)).toBe("a~b");
    expect(expandHome("~other/x", "/home/me", join)).toBe("~other/x");
  });
});
