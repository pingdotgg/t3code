import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildReviewFilePatchScope } from "./useReviewFilePatches";

const environmentId = EnvironmentId.make("env_test");

describe("buildReviewFilePatchScope", () => {
  it("stays stable across content-only refreshes of the same comparison", () => {
    const first = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: "main",
      ignoreWhitespace: false,
      source: { kind: "working-tree", id: "working-tree" },
    });
    const second = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: "main",
      ignoreWhitespace: false,
      source: { kind: "working-tree", id: "working-tree" },
    });
    expect(second).toBe(first);
  });

  it("changes when the comparison identity changes", () => {
    const workingTree = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: null,
      ignoreWhitespace: false,
      source: { kind: "working-tree", id: "working-tree" },
    });
    const otherCommit = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: null,
      ignoreWhitespace: false,
      source: { kind: "commit", id: "abc123" },
    });
    const sameCommitNewBase = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: "origin/main",
      ignoreWhitespace: false,
      source: { kind: "commit", id: "abc123" },
    });
    expect(otherCommit).not.toBe(workingTree);
    expect(sameCommitNewBase).not.toBe(otherCommit);
  });
});
