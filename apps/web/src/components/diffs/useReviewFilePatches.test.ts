import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildReviewFilePatchScope } from "./useReviewFilePatches";

const environmentId = EnvironmentId.make("env_test");

describe("buildReviewFilePatchScope", () => {
  it("stays stable across content-only refreshes of the same comparison", () => {
    const source = {
      kind: "working-tree",
      id: "working-tree",
      baseRef: "HEAD",
      headRef: null,
      diffHash: "before",
    } as const;
    const refreshed = { ...source, diffHash: "after" };
    const first = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: "main",
      ignoreWhitespace: false,
      source,
    });
    const second = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: "main",
      ignoreWhitespace: false,
      source: refreshed,
    });
    expect(second).toBe(first);
  });

  it("changes when the comparison identity changes", () => {
    const workingTree = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: null,
      ignoreWhitespace: false,
      source: { kind: "working-tree", id: "working-tree", baseRef: "HEAD", headRef: null },
    });
    const otherCommit = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: null,
      ignoreWhitespace: false,
      source: { kind: "commit", id: "abc123", baseRef: "abc123^", headRef: "abc123" },
    });
    const sameCommitNewBase = buildReviewFilePatchScope({
      environmentId,
      cwd: "/repo",
      baseRef: "origin/main",
      ignoreWhitespace: false,
      source: { kind: "commit", id: "abc123", baseRef: "abc123^", headRef: "abc123" },
    });
    expect(otherCommit).not.toBe(workingTree);
    expect(sameCommitNewBase).not.toBe(otherCommit);
  });
});
