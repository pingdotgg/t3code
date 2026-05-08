import { type EnvironmentApi, EnvironmentId, type ProjectEntry } from "@forma/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { __resetProjectFileReadCacheForTests } from "./projectFileReadCache";
import {
  PREFETCH_CONCURRENCY,
  SMALL_DIRECTORY_PREFETCH_FILE_CAP,
  VISIBLE_SLICE_PREFETCH_FILE_CAP,
  prefetchWorkspaceDirectoryEntries,
  selectWorkspaceDirectoryPrefetchPaths,
} from "./workspaceFilePrefetch";

const environmentId = EnvironmentId.make("environment-local");
const version = "a".repeat(64);

function fileEntry(path: string): ProjectEntry {
  return {
    path,
    kind: "file",
    parentPath: undefined,
  };
}

function directoryEntry(path: string): ProjectEntry {
  return {
    path,
    kind: "directory",
    parentPath: undefined,
  };
}

describe("workspaceFilePrefetch", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    __resetProjectFileReadCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefetches every file in a small directory and excludes directories", () => {
    const entries = [
      directoryEntry("src"),
      fileEntry("README.md"),
      fileEntry("LICENSE"),
      fileEntry("package.json"),
    ];

    expect(selectWorkspaceDirectoryPrefetchPaths(entries)).toEqual([
      "README.md",
      "LICENSE",
      "package.json",
    ]);
  });

  it("prefetches only the bounded visible slice in a large directory", () => {
    const entries = [
      directoryEntry("src/nested"),
      ...Array.from({ length: SMALL_DIRECTORY_PREFETCH_FILE_CAP + 3 }, (_, index) =>
        fileEntry(`src/file-${index + 1}.ts`),
      ),
    ];

    expect(selectWorkspaceDirectoryPrefetchPaths(entries)).toEqual(
      Array.from(
        { length: VISIBLE_SLICE_PREFETCH_FILE_CAP },
        (_, index) => `src/file-${index + 1}.ts`,
      ),
    );
  });

  it("respects the configured concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await prefetchWorkspaceDirectoryEntries({
      environmentId,
      cwd: "/repo",
      entries: Array.from({ length: 6 }, (_, index) => fileEntry(`src/file-${index + 1}.ts`)),
      concurrency: 2,
      prefetchFile: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
      },
    });

    expect(maxInFlight).toBe(2);
  });

  it("dedupes repeated directory prefetches through the project file read cache", async () => {
    vi.stubGlobal("window", {});

    const readFile = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        relativePath,
        contents: `// ${relativePath}\n`,
        version,
      };
    });

    __setEnvironmentApiOverrideForTests(environmentId, {
      projects: {
        listEntries: vi.fn(),
        createDirectory: vi.fn(),
        renameEntry: vi.fn(),
        deleteEntry: vi.fn(),
        readFile,
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
    } as unknown as EnvironmentApi);

    const entries = [
      fileEntry("src/example.ts"),
      fileEntry("src/other.ts"),
      fileEntry("src/third.ts"),
    ];

    await Promise.all([
      prefetchWorkspaceDirectoryEntries({
        environmentId,
        cwd: "/repo",
        entries,
        concurrency: PREFETCH_CONCURRENCY,
      }),
      prefetchWorkspaceDirectoryEntries({
        environmentId,
        cwd: "/repo",
        entries,
        concurrency: PREFETCH_CONCURRENCY,
      }),
    ]);

    expect(readFile).toHaveBeenCalledTimes(entries.length);
  });
});
