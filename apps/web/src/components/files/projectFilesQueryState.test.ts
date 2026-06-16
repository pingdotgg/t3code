import type {
  EnvironmentApi,
  ProjectListEntriesResult,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import {
  __resetProjectFileQueryDataForTests,
  confirmProjectFileQueryData,
  getProjectEntriesQueryAtom,
  getProjectFileQueryAtom,
  getOptimisticProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("project files queries", () => {
  afterEach(() => {
    __resetProjectFileQueryDataForTests();
    __resetEnvironmentApiOverridesForTests();
    vi.unstubAllGlobals();
  });

  it("retains cached entries while explicitly revalidating", async () => {
    vi.stubGlobal("window", {});
    const first = {
      entries: [{ path: "README.md", kind: "file" }],
      truncated: false,
    } satisfies ProjectListEntriesResult;
    const second = {
      entries: [
        { path: "README.md", kind: "file" },
        { path: "src", kind: "directory" },
      ],
      truncated: false,
    } satisfies ProjectListEntriesResult;
    const revalidation = deferred<ProjectListEntriesResult>();
    const listEntries = vi
      .fn<EnvironmentApi["projects"]["listEntries"]>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(revalidation.promise);
    __setEnvironmentApiOverrideForTests(environmentId, {
      projects: { listEntries },
    } as unknown as EnvironmentApi);
    const registry = AtomRegistry.make();
    const atom = getProjectEntriesQueryAtom(environmentId, "/repo");

    registry.get(atom);
    await vi.waitFor(() => {
      expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual(first);
    });

    registry.refresh(atom);
    await vi.waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
    const refreshing = registry.get(atom);
    expect(refreshing.waiting).toBe(true);
    expect(Option.getOrNull(AsyncResult.value(refreshing))).toEqual(first);

    revalidation.resolve(second);
    await vi.waitFor(() => {
      expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual(second);
    });
    registry.dispose();
  });

  it("keeps the latest optimistic draft when an older write finishes", async () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    const readFile = vi.fn<EnvironmentApi["projects"]["readFile"]>().mockResolvedValue(initial);
    __setEnvironmentApiOverrideForTests(environmentId, {
      projects: { readFile },
    } as unknown as EnvironmentApi);
    const atom = getProjectFileQueryAtom(environmentId, "/repo", "convex.json");

    appAtomRegistry.get(atom);
    await vi.waitFor(() => {
      expect(Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom)))).toEqual(initial);
    });

    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(
      resolveProjectFileQueryData(
        environmentId,
        "/repo",
        "convex.json",
        Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom))),
      ),
    ).toEqual({
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
