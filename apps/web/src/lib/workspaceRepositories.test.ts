import { describe, expect, it } from "vite-plus/test";
import {
  selectWorkspaceRepository,
  updateWorkspaceRepositorySelection,
} from "./workspaceRepositories";

const repositories = [
  { path: ".", available: true },
  { path: "projects/api", available: true },
  { path: "projects/web", available: true },
];

describe("workspace repository selection", () => {
  it("starts with a child repository while allowing the wrapper to be selected", () => {
    expect(selectWorkspaceRepository(repositories, null)?.path).toBe("projects/api");
    expect(selectWorkspaceRepository(repositories, ".")?.path).toBe(".");
  });
  it("does not silently redirect actions when the selected repository disappears", () => {
    expect(selectWorkspaceRepository(repositories, "projects/removed")).toBeNull();
    expect(
      selectWorkspaceRepository([{ path: "projects/api", available: false }], "projects/api"),
    ).toBeNull();
  });
  it("keeps single-repository workspaces working", () => {
    expect(selectWorkspaceRepository(repositories.slice(0, 1), null)?.path).toBe(".");
    expect(selectWorkspaceRepository([], null)).toBeNull();
  });
});

it("syncs specific choices while all repositories preserves the Git action target", () => {
  let selection = updateWorkspaceRepositorySelection(null, "projects/web");
  expect(selection).toEqual({ path: "projects/web", diffPath: "projects/web" });
  selection = updateWorkspaceRepositorySelection(selection, null);
  expect(selection).toEqual({ path: "projects/web", diffPath: null });
  selection = updateWorkspaceRepositorySelection(selection, ".");
  expect(selection).toEqual({ path: ".", diffPath: "." });
  expect(updateWorkspaceRepositorySelection(null, null)).toEqual({ path: null, diffPath: null });
});
