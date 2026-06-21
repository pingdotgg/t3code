import { expect, it } from "@effect/vitest";

import {
  WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndexDestroyFailed,
  WorkspaceSearchIndexRefreshFailed,
  WorkspaceSearchIndexSearchFailed,
} from "./WorkspaceEntries.ts";

it("preserves unexpected workspace search index creation failures", () => {
  const cause = new Error("native initialization failed");
  const error = new WorkspaceSearchIndexCreateFailed({
    cwd: "/workspace/project",
    reason: "FileFinder.create threw unexpectedly.",
    cause,
  });

  expect(error).toMatchObject({
    _tag: "WorkspaceSearchIndexCreateFailed",
    cwd: "/workspace/project",
    reason: "FileFinder.create threw unexpectedly.",
    cause,
  });
  expect(error.message).toBe(
    "Failed to create the workspace search index for '/workspace/project'.",
  );
});

it("preserves workspace search index destroy failures as structured defects", () => {
  const cause = new Error("native destroy failed");
  const error = new WorkspaceSearchIndexDestroyFailed({
    cwd: "/workspace/project",
    cause,
  });

  expect(error).toMatchObject({
    _tag: "WorkspaceSearchIndexDestroyFailed",
    cwd: "/workspace/project",
    cause,
  });
  expect(error.message).toBe(
    "Failed to destroy the workspace search index for '/workspace/project'.",
  );
});

it("keeps returned workspace search index creation diagnostics out of the cause chain", () => {
  const error = new WorkspaceSearchIndexCreateFailed({
    cwd: "/workspace/project",
    reason: "native index rejected the directory",
  });

  expect(error).toMatchObject({
    _tag: "WorkspaceSearchIndexCreateFailed",
    cwd: "/workspace/project",
    reason: "native index rejected the directory",
  });
  expect(error.cause).toBeUndefined();
});

it("preserves search and refresh failures with operation context", () => {
  const searchCause = new Error("native search failed");
  const refreshCause = new Error("native scan failed");
  const query = "authorization: Bearer secret-token";
  const searchError = new WorkspaceSearchIndexSearchFailed({
    cwd: "/workspace/project",
    queryLength: query.length,
    pageSize: 4,
    reason: "FileFinder.mixedSearch threw unexpectedly.",
    cause: searchCause,
  });
  const refreshError = new WorkspaceSearchIndexRefreshFailed({
    cwd: "/workspace/project",
    reason: "FileFinder.scanFiles threw unexpectedly.",
    cause: refreshCause,
  });

  expect(searchError).toMatchObject({
    _tag: "WorkspaceSearchIndexSearchFailed",
    cwd: "/workspace/project",
    queryLength: query.length,
    pageSize: 4,
    reason: "FileFinder.mixedSearch threw unexpectedly.",
    cause: searchCause,
  });
  expect(searchError).not.toHaveProperty("query");
  expect(searchError.message).not.toMatch(/Bearer|secret-token/);
  expect(refreshError).toMatchObject({
    _tag: "WorkspaceSearchIndexRefreshFailed",
    cwd: "/workspace/project",
    reason: "FileFinder.scanFiles threw unexpectedly.",
    cause: refreshCause,
  });
});

it("keeps returned workspace search diagnostics out of the cause chain", () => {
  const query = "authorization: Bearer secret-token";
  const searchError = new WorkspaceSearchIndexSearchFailed({
    cwd: "/workspace/project",
    queryLength: query.length,
    pageSize: 4,
    reason: "native query rejected",
  });
  const refreshError = new WorkspaceSearchIndexRefreshFailed({
    cwd: "/workspace/project",
    reason: "native refresh rejected",
  });

  expect(searchError).toMatchObject({
    _tag: "WorkspaceSearchIndexSearchFailed",
    cwd: "/workspace/project",
    queryLength: query.length,
    pageSize: 4,
    reason: "native query rejected",
  });
  expect(searchError).not.toHaveProperty("query");
  expect(searchError.message).not.toMatch(/Bearer|secret-token/);
  expect(searchError.cause).toBeUndefined();
  expect(refreshError).toMatchObject({
    _tag: "WorkspaceSearchIndexRefreshFailed",
    cwd: "/workspace/project",
    reason: "native refresh rejected",
  });
  expect(refreshError.cause).toBeUndefined();
});
