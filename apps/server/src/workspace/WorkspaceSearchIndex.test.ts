import { FileFinder, type GrepCursor, type GrepOptions, type GrepResult } from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PROJECT_FAVICON_EXTENSIONS, isProjectFaviconPath } from "@t3tools/shared/projectFavicon";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
  ),
);
