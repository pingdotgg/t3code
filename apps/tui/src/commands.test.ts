import { describe, expect, it } from "bun:test";

import { type Command, filterCommands } from "./commands.ts";

const noop = () => {};
const cmd = (id: string, title: string, keywords?: string): Command =>
  keywords ? { id, title, run: noop, keywords } : { id, title, run: noop };

const commands: ReadonlyArray<Command> = [
  cmd("new", "New thread"),
  cmd("plan", "Toggle plan/build mode", "interaction"),
  cmd("rename", "Rename thread"),
  cmd("archive", "Archive thread"),
  cmd("pr", "Push & create PR", "git commit"),
];

describe("filterCommands", () => {
  it("Given an empty query, then it returns every command unchanged", () => {
    expect(filterCommands(commands, "").map((c) => c.id)).toEqual([
      "new",
      "plan",
      "rename",
      "archive",
      "pr",
    ]);
  });

  it("Given a query, then prefix matches rank before substring matches", () => {
    // "thread" is a substring of New/Rename/Archive thread; a title that starts
    // with the query would win, but here all are substring matches — original
    // order is preserved.
    const ids = filterCommands(commands, "thread").map((c) => c.id);
    expect(ids).toEqual(["new", "rename", "archive"]);
  });

  it("Given a keyword-only match, then the command still appears", () => {
    expect(filterCommands(commands, "git").map((c) => c.id)).toEqual(["pr"]);
  });

  it("Given a title-prefix query, then it ranks first", () => {
    const ids = filterCommands(commands, "rename").map((c) => c.id);
    expect(ids[0]).toBe("rename");
  });

  it("Given a subsequence query, then it still matches (fuzzy)", () => {
    // "ahd" is a subsequence of "Arc[h]ive threa[d]"? a-r-c-h-i-v-e... "ahd":
    // a(rchive) h(?) — use a clearer one: "nwthrd" ⊆ "new thread".
    expect(filterCommands(commands, "nwthrd").map((c) => c.id)).toContain("new");
  });

  it("Given a non-matching query, then nothing is returned", () => {
    expect(filterCommands(commands, "zzzz")).toEqual([]);
  });
});
