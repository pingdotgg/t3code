import { describe, expect, it } from "vite-plus/test";

import { filterDraftHeroProjects } from "./draftHeroProjectSearch";

const projects = [
  { title: "T3 Code", workspaceRoot: "/work/t3code" },
  { title: "Mobile App", workspaceRoot: "/work/products/mobile" },
  { title: "Marketing Site", workspaceRoot: "/work/products/marketing" },
];

describe("filterDraftHeroProjects", () => {
  it("narrows candidates as the title query becomes more specific", () => {
    expect(filterDraftHeroProjects(projects, "m").map((project) => project.title)).toEqual([
      "Mobile App",
      "Marketing Site",
    ]);
    expect(filterDraftHeroProjects(projects, "mob").map((project) => project.title)).toEqual([
      "Mobile App",
    ]);
  });

  it("matches project paths and multiple query tokens", () => {
    expect(
      filterDraftHeroProjects(projects, "products market").map((project) => project.title),
    ).toEqual(["Marketing Site"]);
  });

  it("preserves candidate order for an empty query", () => {
    expect(filterDraftHeroProjects(projects, "   ")).toEqual(projects);
  });
});
