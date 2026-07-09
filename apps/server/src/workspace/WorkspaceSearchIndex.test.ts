// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { FileFinder } from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeFallbackWorkspace() {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-search-fallback-"));
  await NodeFSP.mkdir(NodePath.join(cwd, "src", "components"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(cwd, "src", "components", "Composer.tsx"), "");
  await NodeFSP.writeFile(NodePath.join(cwd, "README.md"), "");
  return cwd;
}

it.effect("falls back when FileFinder creation throws unexpectedly", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(makeFallbackWorkspace);
    const cause = new Error("native initialization failed");
    const FileFinder = {
      create: vi.fn(() => {
        throw cause;
      }),
    };

    const searchIndex = yield* Effect.scoped(
      WorkspaceSearchIndex.make(cwd, () =>
        Promise.resolve({
          FileFinder: FileFinder as never,
        }),
      ),
    );
    const result = yield* searchIndex.search("composer", 10);

    expect(FileFinder.create).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual(
      expect.arrayContaining([{ path: "src/components/Composer.tsx", kind: "file" }]),
    );
  }),
);

it.effect("falls back when the native module cannot load", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(makeFallbackWorkspace);
    const cause = new Error("ERR_DLOPEN_FAILED: GLIBC_2.27 not found");

    const searchIndex = yield* Effect.scoped(
      WorkspaceSearchIndex.make(cwd, () => Promise.reject(cause)),
    );
    const result = yield* searchIndex.list();

    expect(result.entries).toEqual(
      expect.arrayContaining([{ path: "src/components/Composer.tsx", kind: "file" }]),
    );
  }),
);

it.effect("falls back when FileFinder returns creation diagnostics", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(makeFallbackWorkspace);
    const FileFinder = {
      create: vi.fn(() => ({
        ok: false,
        error: "native index rejected the directory",
      })),
    };

    const searchIndex = yield* Effect.scoped(
      WorkspaceSearchIndex.make(cwd, () =>
        Promise.resolve({
          FileFinder: FileFinder as never,
        }),
      ),
    );
    const result = yield* searchIndex.search("readme", 10);

    expect(result.entries).toEqual(expect.arrayContaining([{ path: "README.md", kind: "file" }]));
  }),
);

it.effect("preserves FileFinder destroy failures as structured defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native destroy failed");
    const finder = {
      destroy: vi.fn(() => {
        throw cause;
      }),
      isScanning: vi.fn(() => false),
    } as unknown as FileFinder;
    const FileFinderModule = {
      FileFinder: {
        create: vi.fn(() => ({ ok: true, value: finder })),
      },
    };

    const exit = yield* Effect.scoped(
      WorkspaceSearchIndex.make("/workspace/project", () =>
        Promise.resolve(FileFinderModule as never),
      ),
    ).pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed);
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexDestroyFailed",
        cwd: "/workspace/project",
        cause,
      });
    }
  }),
);

it.effect("preserves search and refresh failures with operation context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const searchCause = new Error("native search failed");
      const refreshCause = new Error("native scan failed");
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => {
          throw searchCause;
        }),
        scanFiles: vi.fn(() => {
          throw refreshCause;
        }),
      } as unknown as FileFinder;
      const FileFinderModule = {
        FileFinder: {
          create: vi.fn(() => ({ ok: true, value: finder })),
        },
      };

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", () =>
        Promise.resolve(FileFinderModule as never),
      );
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "FileFinder.mixedSearch threw unexpectedly.",
        cause: searchCause,
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "FileFinder.scanFiles threw unexpectedly.",
        cause: refreshCause,
      });
    }),
  ),
);

it.effect("keeps returned search diagnostics out of the cause chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => ({ ok: false, error: "native query rejected" })),
        scanFiles: vi.fn(() => ({ ok: false, error: "native refresh rejected" })),
      } as unknown as FileFinder;
      const FileFinderModule = {
        FileFinder: {
          create: vi.fn(() => ({ ok: true, value: finder })),
        },
      };

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", () =>
        Promise.resolve(FileFinderModule as never),
      );
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "native query rejected",
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(searchError.cause).toBeUndefined();
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "native refresh rejected",
      });
      expect(refreshError.cause).toBeUndefined();
    }),
  ),
);
