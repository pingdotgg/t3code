import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  retainProjectEntriesWhilePending,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.unstubAllGlobals();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });

  it("keeps the settled file tree visible only while a replacement query is pending", () => {
    const settled = {
      entries: [{ path: "src/index.ts", kind: "file" as const }],
      truncated: false,
    };
    const replacement = {
      entries: [...settled.entries, { path: "cache/data.json", kind: "file" as const }],
      truncated: false,
    };

    const normalSnapshot = { data: settled, includeIgnored: false };
    const ignoredSnapshot = { data: replacement, includeIgnored: true };

    expect(retainProjectEntriesWhilePending(null, normalSnapshot, true, true)).toBe(settled);
    expect(retainProjectEntriesWhilePending(replacement, normalSnapshot, true, true)).toBe(
      replacement,
    );
    expect(retainProjectEntriesWhilePending(null, ignoredSnapshot, true, false)).toBeNull();
    expect(retainProjectEntriesWhilePending(null, normalSnapshot, false, true)).toBeNull();
  });
});
