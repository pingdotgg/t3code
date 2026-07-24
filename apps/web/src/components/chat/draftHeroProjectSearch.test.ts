import { describe, expect, it, vi } from "vite-plus/test";

import { filterDraftHeroProjects, isImeCommitKey } from "./draftHeroProjectSearch";

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

  it("uses locale-independent case folding", () => {
    const localeFold = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(() => {
      throw new Error("locale-sensitive folding must not be used");
    });

    try {
      expect(
        filterDraftHeroProjects([{ title: "Internal", workspaceRoot: "/work/internal" }], "i"),
      ).toHaveLength(1);
    } finally {
      localeFold.mockRestore();
    }
  });

  it("matches titles and paths from every grouped project member", () => {
    const groupedProjects = [
      {
        title: "T3 Code",
        workspaceRoot: "/work/t3code",
        searchTerms: ["T3 Code Remote", "/home/remote/t3code", "T3 Code WSL", "/mnt/c/code/t3code"],
      },
    ];

    expect(
      filterDraftHeroProjects(groupedProjects, "remote").map((project) => project.title),
    ).toEqual(["T3 Code"]);
    expect(
      filterDraftHeroProjects(groupedProjects, "/mnt/c").map((project) => project.title),
    ).toEqual(["T3 Code"]);
  });

  it("preserves candidate order for an empty query", () => {
    expect(filterDraftHeroProjects(projects, "   ")).toEqual(projects);
  });
});

describe("isImeCommitKey", () => {
  it("recognizes Enter during composition, including the legacy keyCode signal", () => {
    expect(isImeCommitKey({ key: "Enter", isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeCommitKey({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("does not block ordinary Enter or other composing keys", () => {
    expect(isImeCommitKey({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeCommitKey({ key: "a", isComposing: true, keyCode: 229 })).toBe(false);
  });
});
