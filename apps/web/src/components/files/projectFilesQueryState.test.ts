import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId, ProjectFileVersion } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");
const version20 = ProjectFileVersion.make("2".repeat(64));
const version220 = ProjectFileVersion.make("3".repeat(64));
const version22 = ProjectFileVersion.make("4".repeat(64));

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
      version: version20,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(
      environmentId,
      "/repo",
      "convex.json",
      '{"nodeVersion":"220"}',
      version20,
    );
    setProjectFileQueryData(
      environmentId,
      "/repo",
      "convex.json",
      '{"nodeVersion":"22"}',
      version20,
    );

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/repo",
        "convex.json",
        '{"nodeVersion":"220"}',
        version220,
      ),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
      version: version20,
    });

    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/repo",
        "convex.json",
        '{"nodeVersion":"22"}',
        version22,
      ),
    ).toBe(true);
  });
});
