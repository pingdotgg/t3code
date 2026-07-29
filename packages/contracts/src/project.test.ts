import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import {
  ProjectActionEnvironment,
  ProjectDetails,
  ProjectDetailsError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
} from "./project.ts";

const decodeProjectDetails = Schema.decodeUnknownSync(ProjectDetails);
const decodeProjectActionEnvironment = Schema.decodeUnknownSync(ProjectActionEnvironment);

const baseProjectDetails = {
  id: "project-1",
  title: "Project",
  workspaceRoot: "/repo/project",
  repositoryIdentity: null,
  settings: {
    remoteOverride: null,
  },
  detected: {
    gitRoot: null,
    branch: null,
    remotes: [],
    primaryRemote: null,
  },
  effective: {
    title: "Project",
    remote: null,
  },
};

describe("project RPC errors", () => {
  it("retains the ProjectDetailsError message with structured failure context", () => {
    const cause = new Error("sensitive settings failure");
    const error = new ProjectDetailsError({
      projectId: ProjectId.make("project-1"),
      operation: "update-settings",
      failure: "operation_failed",
      message: "Failed to update project settings.",
      cause,
    });

    expect(error._tag).toBe("ProjectDetailsError");
    expect(error.message).toBe("Failed to update project settings.");
    expect(error.projectId).toBe("project-1");
    expect(error.operation).toBe("update-settings");
    expect(error.failure).toBe("operation_failed");
    expect(error.cause).toBe(cause);
  });

  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);
    const decodeDetailsError = Schema.decodeUnknownSync(ProjectDetailsError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });
    const detailsError = decodeDetailsError({
      _tag: "ProjectDetailsError",
      message: "Legacy project details failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
    expect(detailsError.message).toBe("Legacy project details failure.");
    expect(detailsError.projectId).toBeUndefined();
    expect(detailsError.operation).toBeUndefined();
    expect(detailsError.failure).toBeUndefined();
  });
});

describe("ProjectDetails", () => {
  it("decodes legacy responses without model selection and scripts", () => {
    const decoded = decodeProjectDetails(baseProjectDetails);

    expect(decoded.defaultModelSelection).toBeNull();
    expect(decoded.scripts).toEqual([]);
    expect(decoded.settings.automaticGitFetchInterval).toBeNull();
    expect(decoded.settings.actionEnvironment).toEqual({});
    expect(decoded.settings.disabledProviderInstanceIds).toEqual([]);
  });

  it("rejects action environment keys reserved for T3Code runtime variables", () => {
    expect(() =>
      decodeProjectActionEnvironment({
        T3CODE_PROJECT_ROOT: "/repo/elsewhere",
      }),
    ).toThrow(/reserved/);

    expect(() =>
      decodeProjectActionEnvironment({
        T3CODE_CUSTOM: "1",
      }),
    ).toThrow(/reserved/);
  });

  it("rejects object prototype keys in action environments", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => decodeProjectActionEnvironment(JSON.parse(`{"${key}":"unsafe"}`))).toThrow(
        /reserved/,
      );
    }
  });
});
