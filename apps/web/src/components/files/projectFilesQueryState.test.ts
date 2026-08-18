import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  hasSettledProjectFileRevalidation,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
  shouldRevalidateProjectFileOnMount,
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

  it("keeps confirmed optimistic data until a later read settles successfully", () => {
    const confirmedAgainst = AsyncResult.success({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    });
    const refreshed = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;

    expect(
      hasSettledProjectFileRevalidation(
        confirmedAgainst,
        AsyncResult.success(refreshed, { waiting: true }),
      ),
    ).toBe(false);
    expect(
      hasSettledProjectFileRevalidation(confirmedAgainst, AsyncResult.success(refreshed)),
    ).toBe(true);
  });

  it("revalidates settled cached file data when the preview mounts", () => {
    const cached = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;

    expect(shouldRevalidateProjectFileOnMount(AsyncResult.initial(false))).toBe(false);
    expect(shouldRevalidateProjectFileOnMount(AsyncResult.success(cached, { waiting: true }))).toBe(
      false,
    );
    expect(shouldRevalidateProjectFileOnMount(AsyncResult.success(cached))).toBe(true);
  });
});
