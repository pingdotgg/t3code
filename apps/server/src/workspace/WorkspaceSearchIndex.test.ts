import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

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

it.effect.each([false, true])(
  "resumes empty budget pages without losing results (hasMatch: %s)",
  (hasMatch) =>
    Effect.scoped(
      Effect.gen(function* () {
        const clock = vi.spyOn(performance, "now").mockReturnValue(0);
        const cursors = [1, 2].map(
          (offset) =>
            ({
              __brand: "GrepCursor",
              _offset: offset,
            }) as GrepCursor,
        );
        let eventLoopServiced = false;
        let eventLoopTask: NodeJS.Immediate | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (eventLoopTask) clearImmediate(eventLoopTask);
          }),
        );
        const grep = vi.fn((_query: string, options?: GrepOptions) => {
          const page = options?.cursor ? cursors.indexOf(options.cursor) + 1 : 0;
          if (page === 0) {
            clock.mockReturnValue(1_000);
            eventLoopTask = setImmediate(() => {
              eventLoopServiced = true;
            });
          } else {
            expect(eventLoopServiced).toBe(true);
          }
          expect(options?.enforceTimeBudget).toBe(true);
          const value: GrepResult = {
            items:
              page === 2 && hasMatch
                ? [
                    {
                      ...fileItem("src/late.ts"),
                      isBinary: false,
                      lineNumber: 1,
                      col: 0,
                      byteOffset: 0,
                      lineContent: "needle",
                      matchRanges: [[0, 6]],
                    },
                  ]
                : [],
            totalMatched: page === 2 && hasMatch ? 1 : 0,
            totalFilesSearched: 1,
            totalFiles: 3,
            filteredFileCount: 3,
            nextCursor: cursors[page] ?? null,
          };
          return { ok: true as const, value };
        });
        const finder = {
          destroy: vi.fn(),
          waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
          grep,
        } as unknown as FileFinder;
        vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

        const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content");
        const result = yield* searchIndex.searchContents({
          query: "needle",
          limit: 10,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches.map((match) => match.path)).toEqual(hasMatch ? ["src/late.ts"] : []);
        expect(result.truncated).toBe(false);
        expect(grep).toHaveBeenCalledTimes(3);
      }),
    ),
);

it.effect("reruns an enforced page whose path constraint filtered every file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const grep = vi.fn((_query: string, options?: GrepOptions) => {
        const fellBack = options?.enforceTimeBudget === false;
        const value: GrepResult = {
          items: fellBack
            ? [
                {
                  ...fileItem("arch/x86/kernel/head64.c"),
                  isBinary: false,
                  lineNumber: 1,
                  col: 0,
                  byteOffset: 0,
                  lineContent: "asmlinkage __visible void start_kernel(void)",
                  matchRanges: [[0, 44]],
                },
              ]
            : [],
          totalMatched: fellBack ? 1 : 0,
          totalFilesSearched: fellBack ? 3 : 0,
          totalFiles: 3,
          filteredFileCount: fellBack ? 3 : 0,
          nextCursor: null,
        };
        return { ok: true as const, value };
      });
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content");
      const result = yield* searchIndex.searchContents({
        query: "[a-z]{90}[-+*/]{5}|asmlinkage __visible.*start_kernel",
        limit: 10,
        caseSensitive: true,
        wholeWord: false,
        useRegex: true,
      });

      expect(result.matches.map((match) => match.path)).toEqual(["arch/x86/kernel/head64.c"]);
    }),
  ),
);
