// @effect-diagnostics nodeBuiltinImport:off -- observes the real search process.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { FileItem, GrepCursor, GrepOptions, GrepResult } from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

vi.mock("node:child_process", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(NodeChildProcess.spawn).mockClear();
});

const withFinder = (finder: Partial<WorkspaceSearchIndex.RemoteFileFinder>) =>
  Effect.provideService(WorkspaceSearchIndex.WorkspaceSearchWorker, {
    create: async () => ({
      ok: true,
      value: {
        alive: true,
        destroy: vi.fn(async () => {}),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        ...finder,
      } as WorkspaceSearchIndex.RemoteFileFinder,
    }),
  });

const spawnedWorkers = () =>
  vi
    .mocked(NodeChildProcess.spawn)
    .mock.results.map((result) => result.value as NodeChildProcess.ChildProcess);

const searchNeedle = (searchIndex: WorkspaceSearchIndex.WorkspaceSearchIndex["Service"]) =>
  searchIndex.searchContents({
    query: "needle",
    limit: 10,
    caseSensitive: true,
    wholeWord: false,
    useRegex: false,
  });

const makeNeedleWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-search-worker-" });
  yield* fileSystem.writeFileString(`${cwd}/notes.ts`, "const needle = 1;\n");
  return cwd;
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(async () => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project").pipe(
        withFinder({ fileSearch }),
      );
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn(async (_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content").pipe(
        withFinder({ grep }),
      );
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ),
);

it.effect("reads an incomplete scan from the finder that answers the search", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let firstExited = false;
      const timedOutScan = vi.fn(async () => ({ ok: true as const, value: false }));
      const fileSearch = vi.fn(async () => ({
        ok: true as const,
        value: { items: [fileItem("src/a.ts")], scores: [], totalMatched: 1, totalFiles: 1 },
      }));
      const first = {
        get alive() {
          return !firstExited;
        },
        destroy: vi.fn(async () => {}),
        waitForIndexReady: timedOutScan,
        // The scan finished, then the process exited right after replying.
        isScanning: vi.fn(async () => {
          firstExited = true;
          return false;
        }),
        fileSearch: vi.fn(async () => {
          throw new Error("The workspace search worker exited.");
        }),
      } as unknown as WorkspaceSearchIndex.RemoteFileFinder;
      const rebuilt = {
        alive: true,
        destroy: vi.fn(async () => {}),
        waitForIndexReady: timedOutScan,
        isScanning: vi.fn(async () => true),
        fileSearch,
      } as unknown as WorkspaceSearchIndex.RemoteFileFinder;
      const finders = [first, rebuilt];
      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project").pipe(
        Effect.provideService(WorkspaceSearchIndex.WorkspaceSearchWorker, {
          create: async () => ({ ok: true, value: finders.shift()! }),
        }),
      );

      const duringExit = yield* searchIndex.search("", 10, "file").pipe(
        Effect.map(({ truncated }) => truncated),
        Effect.catchTags({
          WorkspaceSearchIndexSearchFailed: (error) => Effect.succeed(error._tag),
        }),
      );
      const afterRebuild = yield* searchIndex.search("", 10, "file");

      expect(duringExit).toBe("WorkspaceSearchIndexSearchFailed");
      expect(afterRebuild).toEqual({
        entries: [{ kind: "file", path: "src/a.ts" }],
        truncated: true,
      });
    }),
  ),
);

it.live("rebuilds the index in a new search process after the worker exits", () =>
  Effect.gen(function* () {
    const cwd = yield* makeNeedleWorkspace;
    const searchIndex = yield* WorkspaceSearchIndex.make(cwd, "content");
    const before = yield* searchNeedle(searchIndex);
    const [crashed] = spawnedWorkers();
    yield* Effect.promise(() => {
      const exited = NodeEvents.EventEmitter.once(crashed!, "exit");
      crashed!.kill();
      return exited;
    });

    expect(yield* searchNeedle(searchIndex)).toEqual(before);
    expect(before.matches.map((match) => match.path)).toEqual(["notes.ts"]);
    expect(spawnedWorkers()).toHaveLength(2);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(WorkspaceSearchIndex.layerWorker, NodeServices.layer)),
  ),
);

it.live("ends the search process once its last index closes", () =>
  Effect.gen(function* () {
    const cwd = yield* makeNeedleWorkspace;
    yield* Effect.scoped(Effect.flatMap(WorkspaceSearchIndex.make(cwd, "content"), searchNeedle));
    const [worker] = spawnedWorkers();

    const code =
      worker!.exitCode ??
      (yield* Effect.promise(() => NodeEvents.EventEmitter.once(worker!, "exit")))[0];
    expect(code).toBe(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(WorkspaceSearchIndex.layerWorker, NodeServices.layer)),
  ),
);

// fff reads HOME on Linux and macOS but the user profile on Windows, so a temp HOME cannot stand in there.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "refuses to index a workspace rooted at the home directory",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-home-" }),
        );
        yield* fs.makeDirectory(path.join(home, "OneDrive", "Remix"), { recursive: true });
        yield* fs.writeFileString(path.join(home, "OneDrive", "Remix", "part.stl"), "solid part\n");
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("HOME", home)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        const result = yield* WorkspaceSearchIndex.make(home).pipe(
          Effect.flatMap((searchIndex) => searchIndex.search("stl", 50, undefined, false)),
          Effect.map(({ entries }) => entries),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: (error) => Effect.succeed(error._tag),
          }),
        );

        expect(result).toBe("WorkspaceSearchIndexCreateFailed");
      }),
    ).pipe(Effect.provide(Layer.merge(WorkspaceSearchIndex.layerWorker, NodeServices.layer))),
);
