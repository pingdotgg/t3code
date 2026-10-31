import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
  type WatchEvent,
} from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

afterEach(() => {
  vi.restoreAllMocks();
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
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        isScanning: () => false,
        watch: () => ({ ok: true as const, value: () => undefined }),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ).pipe(Effect.provide(testLayer)),
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
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        isScanning: () => false,
        watch: () => ({ ok: true as const, value: () => undefined }),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content");
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
  ).pipe(Effect.provide(testLayer)),
);

function fakeSymlinkFinder(
  directories: ReadonlyArray<string>,
  options: {
    readonly indexed?: ReadonlyArray<{
      readonly path: string;
      readonly kind: "file" | "directory";
    }>;
    readonly watchFailures?: number;
  } = {},
) {
  const watchers: Array<(events: ReadonlyArray<WatchEvent>) => void> = [];
  let watchFailures = options.watchFailures ?? 0;
  // fff's pageIndex is an offset into the results, not a page number.
  const directorySearch = vi.fn(
    (_query: string, searchOptions?: { pageIndex?: number; pageSize?: number }) => {
      const offset = searchOptions?.pageIndex ?? 0;
      const items = directories.slice(offset, offset + (searchOptions?.pageSize ?? 100));
      return {
        ok: true as const,
        value: {
          items: items.map((relativePath) => ({ relativePath })),
          totalMatched: directories.length,
        },
      };
    },
  );
  const indexedItems = (options.indexed ?? []).map((entry) => ({
    type: entry.kind,
    item: { relativePath: entry.path, fileName: entry.path.split("/").at(-1) },
  }));
  const finder = {
    destroy: vi.fn(),
    waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    isScanning: () => false,
    watch: (callback: (events: ReadonlyArray<WatchEvent>) => void) => {
      if (watchFailures > 0) {
        watchFailures -= 1;
        throw new Error("File system watcher is not ready");
      }
      watchers.push(callback);
      return { ok: true as const, value: () => undefined };
    },
    directorySearch,
    fileSearch: () => {
      const items = indexedItems.flatMap((entry) => (entry.type === "file" ? [entry.item] : []));
      return { ok: true as const, value: { items, scores: [], totalMatched: items.length } };
    },
    mixedSearch: () => ({
      ok: true as const,
      value: { items: indexedItems, totalMatched: indexedItems.length },
    }),
  } as unknown as FileFinder;
  vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
  return {
    directorySearch,
    notifyWatchers: (events: ReadonlyArray<WatchEvent>) =>
      watchers.forEach((watcher) => watcher(events)),
  };
}

const listedPaths = (searchIndex: WorkspaceSearchIndex.WorkspaceSearchIndex["Service"]) =>
  searchIndex.list().pipe(Effect.map((result) => result.entries.map((entry) => entry.path)));

it.effect("reads symlinks again after the watcher reports a change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-watch-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "old-link.ts"));
      const { directorySearch, notifyWatchers } = fakeSymlinkFinder([]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const concurrent = yield* Effect.all(
        Array.from({ length: 8 }, () => listedPaths(searchIndex)),
        { concurrency: "unbounded" },
      );
      yield* fileSystem.remove(path.join(cwd, "old-link.ts"));
      yield* fileSystem.symlink("a.ts", path.join(cwd, "new-link.ts"));
      const beforeNotice = yield* listedPaths(searchIndex);
      // Editing a file cannot move a link, so it does not cost a rescan.
      notifyWatchers([{ kind: "modified", path: path.join(cwd, "a.ts") }]);
      const afterEdit = yield* listedPaths(searchIndex);
      notifyWatchers([{ kind: "created", path: path.join(cwd, "new-link.ts") }]);
      const afterNotice = yield* listedPaths(searchIndex);

      expect(concurrent).toEqual(Array.from({ length: 8 }, () => ["old-link.ts"]));
      expect(beforeNotice).toEqual(["old-link.ts"]);
      expect(afterEdit).toEqual(["old-link.ts"]);
      expect(afterNotice).toEqual(["new-link.ts"]);
      expect(directorySearch).toHaveBeenCalledTimes(2);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps symlinks once the watcher subscribes after starting late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-watch-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "link.ts"));
      const { directorySearch } = fakeSymlinkFinder([], { watchFailures: 2 });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      for (let read = 0; read < 5; read += 1) {
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
      }

      // The first scans are not kept while no watcher could report changes; the third is.
      expect(directorySearch).toHaveBeenCalledTimes(3);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("lists a symlink the watcher already indexed once, with the link's kind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-dupe-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "src"));
      yield* fileSystem.symlink("src", path.join(cwd, "src-link"));
      fakeSymlinkFinder([], { indexed: [{ path: "src-link", kind: "file" }] });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const searched = yield* searchIndex.search("link", 10);
      const files = yield* searchIndex.search("link", 10, "file");
      const listed = yield* searchIndex.list();

      expect(searched.entries).toEqual([{ path: "src-link", kind: "directory" }]);
      expect(files.entries).toEqual([]);
      expect(listed.entries).toEqual([{ path: "src-link", kind: "directory" }]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("finds symlinks in folders past the first page of the index", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-pages-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "late"));
      yield* fileSystem.writeFileString(path.join(cwd, "late/a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "late/link.ts"));
      // Folders fff lists but that are gone by the time they are read are skipped.
      const firstPage = Array.from({ length: 25_002 }, (_, index) => `missing-${index}`);
      const { directorySearch } = fakeSymlinkFinder([...firstPage, "late"]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);

      expect(yield* listedPaths(searchIndex)).toEqual(["late", "late/link.ts"]);
      expect(directorySearch.mock.calls.map(([, options]) => options?.pageIndex)).toEqual([
        0, 25_002,
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);
