import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createProjectDraftInitialState,
  reduceCreateProjectDraft,
  validateCreateProjectDraft,
  type CreateProjectDraftAction,
  type CreateProjectDraftState,
} from "./CreateProjectDialog.logic";

const envId = EnvironmentId.make("env-1");

const start = (overrides?: Partial<CreateProjectDraftState>): CreateProjectDraftState => ({
  ...createProjectDraftInitialState({ environmentId: envId }),
  ...overrides,
});

const run = (
  state: CreateProjectDraftState,
  ...actions: ReadonlyArray<CreateProjectDraftAction>
): CreateProjectDraftState => actions.reduce(reduceCreateProjectDraft, state);

const context = (projects: ReadonlyArray<EnvironmentProject> = []) => ({
  projects,
  platform: "macOS",
  currentProjectCwd: null,
  environmentConnected: true,
  environmentLabel: "Local",
});

const makeProject = (path: string): EnvironmentProject =>
  ({
    environmentId: envId,
    id: ProjectId.make("existing"),
    title: "Existing",
    workspaceRoot: path,
    additionalFolders: [],
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as EnvironmentProject;

describe("reduceCreateProjectDraft", () => {
  it("makes the first folder primary automatically", () => {
    const state = run(start(), { _tag: "AddFolder", id: "a", rawPath: "/repo/app" });
    expect(state.primaryFolderId).toBe("a");
  });

  it("derives the name from the primary folder until the user edits it", () => {
    const withFolder = run(start(), { _tag: "AddFolder", id: "a", rawPath: "/repo/app" });
    expect(withFolder.name).toBe("app");

    const renamed = run(withFolder, { _tag: "SetName", name: "Custom" });
    expect(renamed.nameTouched).toBe(true);

    // Adding another folder must not clobber a name the user chose.
    const later = run(renamed, { _tag: "AddFolder", id: "b", rawPath: "/repo/docs" });
    expect(later.name).toBe("Custom");
  });

  it("re-enables auto-derivation when the user types the derived name back", () => {
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "SetName", name: "Custom" },
      { _tag: "SetName", name: "app" },
    );
    expect(state.nameTouched).toBe(false);
  });

  it("follows the primary when it changes", () => {
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "AddFolder", id: "b", rawPath: "/repo/docs" },
      { _tag: "MakePrimary", id: "b" },
    );
    expect(state.primaryFolderId).toBe("b");
    expect(state.name).toBe("docs");
  });

  it("promotes a remaining folder when the primary is removed", () => {
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "AddFolder", id: "b", rawPath: "/repo/docs" },
      { _tag: "RemoveFolder", id: "a" },
    );
    expect(state.primaryFolderId).toBe("b");
  });

  it("clears folders when the environment changes", () => {
    // Paths are environment-scoped; carrying one across is a wrong-path footgun.
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "SetEnvironment", environmentId: EnvironmentId.make("env-2") },
    );
    expect(state.folders).toEqual([]);
    expect(state.primaryFolderId).toBeNull();
  });
});

describe("validateCreateProjectDraft", () => {
  it("accepts a primary plus additional folders", () => {
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "AddFolder", id: "b", rawPath: "/repo/docs" },
    );
    const result = validateCreateProjectDraft(state, context());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toBe("app");
      expect(result.primaryPath).toBe("/repo/app");
      expect(result.additionalPaths).toEqual(["/repo/docs"]);
    }
  });

  it("puts the chosen primary first regardless of row order", () => {
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "AddFolder", id: "b", rawPath: "/repo/docs" },
      { _tag: "MakePrimary", id: "b" },
    );
    const result = validateCreateProjectDraft(state, context());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.primaryPath).toBe("/repo/docs");
      expect(result.additionalPaths).toEqual(["/repo/app"]);
    }
  });

  it("requires a name and at least one folder", () => {
    const empty = validateCreateProjectDraft(start(), context());
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.nameError).toBe("Enter a project name.");
      expect(empty.formError).toBe("Add at least one source folder.");
    }
  });

  it("rejects a duplicate folder", () => {
    const state = run(
      start(),
      { _tag: "AddFolder", id: "a", rawPath: "/repo/app" },
      { _tag: "AddFolder", id: "b", rawPath: "/repo/app/" },
    );
    const result = validateCreateProjectDraft(state, context());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.folderErrors.get("b")).toBe("This folder is already added.");
  });

  it("rejects a primary folder another project already uses", () => {
    const state = run(start(), { _tag: "AddFolder", id: "a", rawPath: "/repo/app" });
    const result = validateCreateProjectDraft(state, context([makeProject("/repo/app")]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.folderErrors.get("a")).toBe("A project already uses this folder.");
      expect(result.existingProjectId).toBe("existing");
    }
  });

  it("reports a disconnected environment instead of failing at dispatch", () => {
    const state = run(start(), { _tag: "AddFolder", id: "a", rawPath: "/repo/app" });
    const result = validateCreateProjectDraft(state, {
      ...context(),
      environmentConnected: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.formError).toBe("Local is not connected.");
  });

  it("surfaces a Windows path used against a non-Windows environment", () => {
    const state = run(start(), { _tag: "AddFolder", id: "a", rawPath: "C:\\repo\\app" });
    const result = validateCreateProjectDraft(state, context());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.folderErrors.get("a")).toMatch(/Windows-style paths/);
  });
});
