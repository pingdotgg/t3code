import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PROJECT_FAVICON_EXTENSIONS, isProjectFaviconPath } from "@t3tools/shared/projectFavicon";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

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

it.live("bounds native image results without losing matches, ranking, or query constraints", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-search-" });
    yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
    yield* fileSystem.makeDirectory(path.join(cwd, "other"));
    yield* fileSystem.makeDirectory(path.join(cwd, "assetss"));
    yield* fileSystem.makeDirectory(path.join(cwd, "assets/images"));
    const imagePaths = PROJECT_FAVICON_EXTENSIONS.flatMap((extension) => [
      `assets/logo${extension}`,
      `other/logo${extension.toUpperCase()}`,
    ]);
    for (const relativePath of [
      ...Array.from({ length: 220 }, (_, index) => `assets/source-${index}.ts`),
      "assets/logo.ts",
      "assets/logotype.png",
      "assetss/logotype.png",
      "assets/images/logo.PNG",
      ...imagePaths,
    ]) {
      yield* fileSystem.writeFileString(path.join(cwd, relativePath), "");
      yield* fileSystem.utimes(path.join(cwd, relativePath), 0, 0);
    }

    const createFinder = vi.spyOn(FileFinder, "create");
    const fileSearch = vi.spyOn(FileFinder.prototype, "fileSearch");
    const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
    const limited = yield* searchIndex.search("", 200, undefined, true);
    expect(limited.entries).toHaveLength(imagePaths.length + 3);
    expect(limited.truncated).toBe(false);
    const nativeResult = fileSearch.mock.results[0]?.value;
    expect(nativeResult.ok).toBe(true);
    expect(nativeResult.value.items.length).toBeLessThanOrEqual(201);
    const allImages = yield* searchIndex.search("", 1000, "file", true);
    expect(allImages.entries.map((entry) => entry.path).toSorted()).toEqual(
      [
        ...imagePaths,
        "assets/logotype.png",
        "assetss/logotype.png",
        "assets/images/logo.PNG",
      ].toSorted(),
    );
    expect(allImages.truncated).toBe(false);

    for (const query of [
      "",
      "logo",
      "lgo",
      "logo.png",
      "*.png",
      "*.ts",
      "!*.png",
      "assets/**",
      "**/",
      "!assets/",
      "assets*/",
      "/assets",
      "assets/",
      "logo:12",
      "/assets/logotype.png:12",
      "/assets/logotype.png",
      "/assets/images",
      "assets/images/",
      "logo *.svg !other",
    ]) {
      const ordinary = yield* searchIndex.search(query, 1000, "file");
      const expected = ordinary.entries.filter((entry) => isProjectFaviconPath(entry.path));
      for (const limit of [1, expected.length || 1, 200]) {
        const images = yield* searchIndex.search(query, limit, "directory", true);
        expect(images, `query=${query} limit=${limit}`).toEqual({
          entries: expected.slice(0, limit),
          truncated: expected.length > limit,
        });
      }
    }
    yield* fileSystem.makeDirectory(path.join(cwd, "public"));
    const tiedImagePaths = Array.from({ length: 220 }, (_, index) => `public/icon-${index}.png`);
    for (const relativePath of [
      ...tiedImagePaths,
      ...Array.from({ length: 220 }, (_, index) => `public/source-${index}.ts`),
    ]) {
      yield* fileSystem.writeFileString(path.join(cwd, relativePath), "");
      yield* fileSystem.utimes(path.join(cwd, relativePath), 0, 0);
    }
    yield* searchIndex.refresh();
    const tiedMatches = yield* searchIndex.search("public/", 1000, "file");
    const expectedTiedImages = tiedMatches.entries.filter((entry) =>
      isProjectFaviconPath(entry.path),
    );
    expect(expectedTiedImages.map((entry) => entry.path).toSorted()).toEqual(
      tiedImagePaths.toSorted(),
    );
    for (const limit of [200, 220]) {
      const images = yield* searchIndex.search("public/", limit, "file", true);
      expect(images).toEqual({
        entries: expectedTiedImages.slice(0, limit),
        truncated: limit < tiedImagePaths.length,
      });
      expect(new Set(images.entries.map((entry) => entry.path)).size).toBe(images.entries.length);
    }
    const largeCwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-rank-" });
    yield* fileSystem.makeDirectory(path.join(largeCwd, "x/logo"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(largeCwd, "a"));
    yield* fileSystem.makeDirectory(path.join(largeCwd, "b"));
    for (let index = 0; index < 14_998; index += 1) {
      yield* fileSystem.writeFileString(path.join(largeCwd, `b/logo-${index}.png`), "");
    }
    yield* fileSystem.writeFileString(path.join(largeCwd, "x/logo/source.ts"), "");
    const pairPaths = ["a/xxlogo.png", "x/logo/logo.png"];
    for (const relativePath of pairPaths) {
      yield* fileSystem.writeFileString(path.join(largeCwd, relativePath), "");
    }
    const largeIndex = yield* WorkspaceSearchIndex.make(largeCwd);
    const created: ReturnType<typeof FileFinder.create> | undefined =
      createFinder.mock.results.at(-1)?.value;
    if (!created?.ok) return yield* Effect.die("Missing native finder");
    const indexed = yield* Deferred.make<void>();
    const newImagePath = path.join(largeCwd, "b/watched-logo.png");
    const subscription = created.value.watch("b/watched-logo.png", (events) => {
      if (events.some((event) => event.path === newImagePath)) {
        Deferred.doneUnsafe(indexed, Effect.void);
      }
    });
    if (!subscription.ok) return yield* Effect.die(subscription.error);
    yield* Effect.addFinalizer(() => Effect.sync(subscription.value));
    for (const watched of [false, true]) {
      if (watched) {
        yield* fileSystem.writeFileString(newImagePath, "");
        yield* Deferred.await(indexed);
      }
      const ordinary = yield* largeIndex.search("logo", 20_000, "file");
      const images = yield* largeIndex.search("logo", 20_000, "file", true);
      expect(images.entries).toHaveLength(watched ? 15_001 : 15_000);
      expect(images.truncated).toBe(false);
      expect(images.entries.filter((entry) => pairPaths.includes(entry.path))).toEqual(
        ordinary.entries.filter((entry) => pairPaths.includes(entry.path)),
      );
    }
    expect((yield* searchIndex.search("", 1, "directory")).entries[0]?.kind).toBe("directory");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("fetches past a first page of Git-ignored results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-ignored-" });
      const vcsProcess = yield* VcsProcess.VcsProcess;
      yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
      yield* fs.writeFileString(path.join(cwd, ".git", "info", "exclude"), "hidden/\n");
      yield* fs.makeDirectory(path.join(cwd, "hidden"));
      yield* fs.writeFileString(path.join(cwd, "hidden", "a.ts"), "");

      const items = [
        fileItem("hidden/a.ts"),
        fileItem("hidden/b.ts"),
        fileItem("hidden/c.ts"),
        fileItem("src/a.ts"),
      ];
      const fileSearch = vi.fn((_query: string, options?: { pageSize?: number }) => ({
        ok: true as const,
        value: {
          items: items.slice(0, options?.pageSize),
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.search("a", 1, "file", false);

      expect(result).toEqual({ entries: [{ kind: "file", path: "src/a.ts" }], truncated: false });
    }),
  ).pipe(Effect.provide(testLayer)),
);

// A backslash is a file name character on Linux and macOS, so only Windows may treat it as a separator.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "keeps a backslash in a POSIX folder name as part of the search result path",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const items = [fileItem("dir\\one/report.txt")];
        const finder = {
          destroy: vi.fn(),
          waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
          fileSearch: vi.fn(() => ({
            ok: true as const,
            value: { items, scores: [], totalMatched: 1, totalFiles: 1 },
          })),
        } as unknown as FileFinder;
        vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

        const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
        const result = yield* searchIndex.search("report", 50, "file");

        expect(result.entries).toEqual([{ kind: "file", path: "dir\\one/report.txt" }]);
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
    ).pipe(Effect.provide(testLayer)),
);
