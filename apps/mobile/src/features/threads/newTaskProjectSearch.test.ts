import { describe, expect, it } from "vite-plus/test";

import { filterNewTaskProjects, type NewTaskProjectItem } from "./newTaskProjectSearch";

const PROJECTS: ReadonlyArray<NewTaskProjectItem> = [
  { key: "a", title: "SergeCode", workspaceRoot: "/Users/dev/Code/SergeCode" },
  { key: "b", title: "relay-infra", workspaceRoot: "/Users/dev/Code/relay-infra" },
  { key: "c", title: "notes", workspaceRoot: "/Users/dev/Documents/serge-notes" },
];

describe("filterNewTaskProjects", () => {
  it("keeps the picker's own ordering when the query is empty", () => {
    expect(filterNewTaskProjects(PROJECTS, "")).toBe(PROJECTS);
    expect(filterNewTaskProjects(PROJECTS, "   ")).toBe(PROJECTS);
  });

  it("matches on title", () => {
    expect(filterNewTaskProjects(PROJECTS, "relay").map((item) => item.key)).toEqual(["b"]);
  });

  it("matches on the workspace path when the title does not match", () => {
    expect(filterNewTaskProjects(PROJECTS, "Documents").map((item) => item.key)).toEqual(["c"]);
  });

  it("ranks a title match ahead of a path-only match", () => {
    // "serge" is the title of `a` and only part of `c`'s path.
    expect(filterNewTaskProjects(PROJECTS, "serge").map((item) => item.key)).toEqual(["a", "c"]);
  });

  it("returns nothing when no project matches", () => {
    expect(filterNewTaskProjects(PROJECTS, "zzzz")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(filterNewTaskProjects(PROJECTS, "SERGECODE").map((item) => item.key)).toEqual(["a"]);
  });
});
