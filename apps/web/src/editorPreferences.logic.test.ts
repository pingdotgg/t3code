import { describe, expect, it } from "vite-plus/test";
import type { EditorId, EnvironmentId } from "@t3tools/contracts";
import {
  editorProjectKey,
  nextProjectEditorOverrides,
  resolveEditorForProject,
  type EditorPreferences,
} from "./editorPreferences.logic";

const PROJECT_KEY = "env-1:/Users/dev/app";

const preferences = (overrides: Partial<EditorPreferences> = {}): EditorPreferences => ({
  defaultEditor: null,
  projectEditorOverrides: {},
  ...overrides,
});

const AVAILABLE: ReadonlyArray<EditorId> = ["cursor", "vscode", "zed"];

describe("resolveEditorForProject", () => {
  it("prefers the project override over the global default", () => {
    expect(
      resolveEditorForProject({
        preferences: preferences({
          defaultEditor: "vscode",
          projectEditorOverrides: { [PROJECT_KEY]: "zed" },
        }),
        projectKey: PROJECT_KEY,
        availableEditors: AVAILABLE,
      }),
    ).toBe("zed");
  });

  it("ignores an override belonging to another project", () => {
    expect(
      resolveEditorForProject({
        preferences: preferences({
          defaultEditor: "vscode",
          projectEditorOverrides: { "env-1:/Users/dev/other": "zed" },
        }),
        projectKey: PROJECT_KEY,
        availableEditors: AVAILABLE,
      }),
    ).toBe("vscode");
  });

  it("falls back to the global default without a project in scope", () => {
    expect(
      resolveEditorForProject({
        preferences: preferences({
          defaultEditor: "vscode",
          projectEditorOverrides: { [PROJECT_KEY]: "zed" },
        }),
        projectKey: null,
        availableEditors: AVAILABLE,
      }),
    ).toBe("vscode");
  });

  it("falls through an override the environment no longer offers", () => {
    expect(
      resolveEditorForProject({
        preferences: preferences({
          defaultEditor: "vscode",
          projectEditorOverrides: { [PROJECT_KEY]: "rustrover" },
        }),
        projectKey: PROJECT_KEY,
        availableEditors: AVAILABLE,
      }),
    ).toBe("vscode");
  });

  it("falls back to the first available editor when nothing is configured", () => {
    expect(
      resolveEditorForProject({
        preferences: preferences(),
        projectKey: PROJECT_KEY,
        availableEditors: ["zed", "vscode"],
      }),
    ).toBe("vscode");
  });

  it("returns null when the environment reports no editors", () => {
    expect(
      resolveEditorForProject({
        preferences: preferences({ defaultEditor: "vscode" }),
        projectKey: PROJECT_KEY,
        availableEditors: [],
      }),
    ).toBeNull();
  });
});

describe("nextProjectEditorOverrides", () => {
  it("sets an override without touching other projects", () => {
    expect(
      nextProjectEditorOverrides({
        overrides: { "env-1:/Users/dev/other": "cursor" },
        projectKey: PROJECT_KEY,
        editor: "zed",
      }),
    ).toEqual({ "env-1:/Users/dev/other": "cursor", [PROJECT_KEY]: "zed" });
  });

  it("removes the override rather than storing a sentinel", () => {
    expect(
      nextProjectEditorOverrides({
        overrides: { [PROJECT_KEY]: "zed" },
        projectKey: PROJECT_KEY,
        editor: null,
      }),
    ).toEqual({});
  });
});

describe("editorProjectKey", () => {
  it("matches the physical project key used by sidebar overrides", () => {
    expect(
      editorProjectKey({
        environmentId: "env-1" as EnvironmentId,
        workspaceRoot: "/Users/dev/app",
      }),
    ).toBe(PROJECT_KEY);
  });

  it("is null without a project", () => {
    expect(editorProjectKey(null)).toBeNull();
  });
});
