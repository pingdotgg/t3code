import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getUnsavedProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");
const optimisticFile = projectEnvironment.optimisticFile({
  environmentId,
  cwd: "/repo",
  relativePath: "convex.json",
});

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resumes an unsaved draft after closing the preview and restoring write access", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    const closePreview = appAtomRegistry.mount(optimisticFile);
    let canWrite = true;
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) => {
          confirmProjectFileQueryData(environmentId, "/repo", "convex.json", contents);
        },
      });
    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "unsaved draft");
    initial.change("unsaved draft");
    canWrite = false;
    initial.dispose();
    closePreview();
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    const unsaved = getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json");
    expect(unsaved?.contents).toBe("unsaved draft");

    canWrite = true;
    const reopened = makeCoordinator();
    reopened.change(unsaved!.contents);
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved draft");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
  });

  it("releases a retained unsaved draft when explicitly cleared", async () => {
    vi.useFakeTimers();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft");
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "latest draft");
    await vi.runAllTimersAsync();
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      "latest draft",
    );

    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
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
});
