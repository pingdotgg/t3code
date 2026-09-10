import { describe, expect, it, vi } from "vite-plus/test";

import { openDiffFilePrimaryAction, resolveConfiguredRepositoryRoot } from "../diffFileActions";

import {
  resolveNestedDiffRepositoryPath,
  resolveUnresolvableRepositoryMessage,
  shouldRetryDiffPreviewAtEnvironmentCwd,
} from "./DiffPanel.logic";

describe("diff repository scope", () => {
  it.each([
    { isTurnSelected: true, expected: "/project/src/root.ts" },
    { isTurnSelected: false, expected: "/project/frontend/src/root.ts" },
  ])(
    "opens files in the correct tree with turn selection $isTurnSelected",
    ({ isTurnSelected, expected }) => {
      const nestedPath = resolveNestedDiffRepositoryPath({
        isTurnSelected,
        repositoryPath: "frontend",
      });
      const openInEditor = vi.fn();
      openDiffFilePrimaryAction({
        threadRef: null,
        filePath: "src/root.ts",
        activeCwd: "/project",
        repositoryRoot: {
          path: nestedPath ? resolveConfiguredRepositoryRoot(nestedPath, "/project")! : "/project",
          kind: nestedPath ? "configured" : "detected",
        },
        openInEditor,
      });
      expect(openInEditor).toHaveBeenCalledWith(expected);
    },
  );
});

const WORKSPACE_ROOT_ERROR =
  "Review diff preview cwd must stay within the configured workspace root.";

const retryInput = (
  overrides: Partial<Parameters<typeof shouldRetryDiffPreviewAtEnvironmentCwd>[0]> = {},
) => ({
  isTurnSelected: false,
  nestedRepositoryPath: null,
  previewError: WORKSPACE_ROOT_ERROR,
  environmentCwd: "/srv/workspace",
  activeGitCwd: "/home/dev/project",
  ...overrides,
});

describe("shouldRetryDiffPreviewAtEnvironmentCwd", () => {
  it("retries a workspace root rejection at the environment cwd", () => {
    expect(shouldRetryDiffPreviewAtEnvironmentCwd(retryInput())).toBe(true);
  });

  it("never retries for a selected nested repository", () => {
    // Every other condition holds; the retry would read the environment's own
    // repository and show its diff under the selected repository's label.
    expect(
      shouldRetryDiffPreviewAtEnvironmentCwd(
        retryInput({ nestedRepositoryPath: "services/api", activeGitCwd: "/home/dev/project/api" }),
      ),
    ).toBe(false);
  });

  it("does not retry without a workspace root rejection", () => {
    expect(shouldRetryDiffPreviewAtEnvironmentCwd(retryInput({ previewError: null }))).toBe(false);
    expect(
      shouldRetryDiffPreviewAtEnvironmentCwd(
        retryInput({ previewError: "fatal: not a git repository" }),
      ),
    ).toBe(false);
  });

  it("does not retry the directory that already failed", () => {
    expect(
      shouldRetryDiffPreviewAtEnvironmentCwd(
        retryInput({ environmentCwd: "/home/dev/project", activeGitCwd: "/home/dev/project" }),
      ),
    ).toBe(false);
    expect(shouldRetryDiffPreviewAtEnvironmentCwd(retryInput({ environmentCwd: undefined }))).toBe(
      false,
    );
  });

  it("does not retry while a turn diff is selected", () => {
    expect(shouldRetryDiffPreviewAtEnvironmentCwd(retryInput({ isTurnSelected: true }))).toBe(
      false,
    );
  });
});

describe("resolveUnresolvableRepositoryMessage", () => {
  it("names the repository that could not be located", () => {
    const message = resolveUnresolvableRepositoryMessage({
      isTurnSelected: false,
      repositoryPath: "services/api",
      hasUnresolvableRepository: true,
    });

    expect(message).toContain("services/api");
    expect(message).toContain("t3.json");
  });

  it("stays silent while the repository resolves", () => {
    expect(
      resolveUnresolvableRepositoryMessage({
        isTurnSelected: false,
        repositoryPath: "services/api",
        hasUnresolvableRepository: false,
      }),
    ).toBe(null);
    expect(
      resolveUnresolvableRepositoryMessage({
        isTurnSelected: false,
        repositoryPath: null,
        hasUnresolvableRepository: false,
      }),
    ).toBe(null);
  });

  it("stays silent for a turn diff, which does not depend on the repository", () => {
    expect(
      resolveUnresolvableRepositoryMessage({
        isTurnSelected: true,
        repositoryPath: "services/api",
        hasUnresolvableRepository: true,
      }),
    ).toBe(null);
  });
});
