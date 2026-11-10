// @effect-diagnostics nodeBuiltinImport:off -- the search process is an external runtime boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import type {
  DirItem,
  DirSearchResult,
  FileItem,
  FileFinder as FileFinderType,
  GrepCursor,
  InitOptions,
  MixedItem,
  MixedSearchResult,
  Result,
  SearchResult,
} from "@ff-labs/fff-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isProjectFaviconPath } from "@t3tools/shared/projectFavicon";

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedError<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedError<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace search index for '${this.cwd}' did not finish scanning within ${this.timeout}`;
  }
}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedError<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace search failed for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedError<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to refresh the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedError<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to destroy the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
      imageOnly?: boolean,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly searchContents: (
      input: Omit<ProjectSearchContentsInput, "cwd">,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceSearchIndexSearchFailed>;
    readonly refresh: () => Effect.Effect<void, WorkspaceSearchIndexRefreshFailed>;
  }
>()("t3/workspace/WorkspaceSearchIndex") {}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

function mapFileSearchResult(
  result: SearchResult,
  limit: number,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item);
    return entry && (!imageOnly || isProjectFaviconPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: DirSearchResult,
  limit: number,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item);
    return entry ? [entry] : [];
  });
  const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function mapMixedSearchResult(
  result: MixedSearchResult,
  limit: number,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= limit) {
      break;
    }
  }

  const rootDirectoryCount = result.items.some(
    (item) => item.type === "directory" && item.item.relativePath.length === 0,
  )
    ? 1
    : 0;
  return {
    entries,
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

function codePointAt(line: string, index: number): string | undefined {
  const codePoint = line.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previousCodeUnit = line.charCodeAt(index - 1);
  const previousIndex =
    previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? index - 2 : index - 1;
  return codePointAt(line, previousIndex);
}

function buildContentSearchQuery(input: Omit<ProjectSearchContentsInput, "cwd">): {
  readonly searchQuery: string;
  readonly regexMode: boolean;
} {
  if (input.caseSensitive) {
    return { searchQuery: input.query, regexMode: input.useRegex };
  }
  return input.useRegex
    ? { searchQuery: `(?i)${input.query}`, regexMode: true }
    : { searchQuery: input.query.toLowerCase(), regexMode: false };
}

function mapContentMatchRanges(
  line: string,
  byteRanges: ReadonlyArray<readonly [number, number]>,
): Array<{ readonly start: number; readonly end: number }> {
  const lineBytes = Buffer.from(line);
  const toStringIndex = (byteOffset: number) => lineBytes.subarray(0, byteOffset).toString().length;
  return byteRanges.map(([startByte, endByte]) => ({
    start: toStringIndex(startByte),
    end: toStringIndex(endByte),
  }));
}

// Post-filter whole words: consuming boundary regexes swallow adjacent separators and widen ranges; \b misses punctuation edges.
function isWholeWordRange(
  line: string,
  range: { readonly start: number; readonly end: number },
): boolean {
  if (range.end <= range.start) return false;
  const isWord = (character: string | undefined) =>
    character !== undefined && WORD_CHARACTER.test(character);
  const leftIsBoundary =
    range.start === 0 ||
    !isWord(codePointBefore(line, range.start)) ||
    !isWord(codePointAt(line, range.start));
  const rightIsBoundary =
    range.end >= line.length ||
    !isWord(codePointAt(line, range.end)) ||
    !isWord(codePointBefore(line, range.end));
  return leftIsBoundary && rightIsBoundary;
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    let parentPath = parentPathOf(entry.path);
    while (parentPath) {
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentPathOf(parentPath);
    }
  }
  return [...entryByPath.values()];
}

type RemoteFinderMethod =
  | "destroy"
  | "directorySearch"
  | "fileSearch"
  | "grep"
  | "isScanning"
  | "mixedSearch"
  | "scanFiles"
  | "waitForIndexReady";

export type RemoteFileFinder = {
  readonly [Method in RemoteFinderMethod]: (
    ...args: Parameters<FileFinderType[Method]>
  ) => Promise<Awaited<ReturnType<FileFinderType[Method]>>>;
} & {
  // False once the process holding the native index has exited.
  readonly alive: boolean;
};

// One process owns every finder. Native calls already ran one at a time on the server thread, so a
// pool would add runtimes and index copies without making any single search faster.
export class WorkspaceSearchWorker extends Context.Service<
  WorkspaceSearchWorker,
  {
    readonly create: (options: InitOptions) => Promise<Result<RemoteFileFinder>>;
  }
>()("t3/workspace/WorkspaceSearchIndex/WorkspaceSearchWorker") {}

const makeWorker = Effect.gen(function* () {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  // In a bundle import.meta.url is a chunk beside bin.mjs; development and tests use this source module.
  const entry = NodeURL.fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  let nextId = 0;
  let current: ReturnType<typeof start> | undefined;

  function start() {
    const child = NodeChildProcess.spawn(
      executable,
      [...(isExecutable ? [] : [entry]), "__workspace-search"],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
        windowsHide: true,
        env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    const pending = new Map<number, PromiseWithResolvers<unknown> & { readonly method: string }>();
    const worker = {
      child,
      finders: 0,
      exited: false,
      request: (finderId: number, method: string, args: ReadonlyArray<unknown>) => {
        if (worker.exited) return Promise.reject(new Error("The workspace search worker exited."));
        const id = ++nextId;
        const request = { ...Promise.withResolvers<unknown>(), method };
        pending.set(id, request);
        child.send({ id, finderId, method, args }, (error) => {
          if (error) child.kill();
        });
        return request.promise;
      },
      release: () => {
        if (--worker.finders > 0 || worker !== current) return;
        // The last index expired; the next search starts a fresh process.
        current = undefined;
        child.disconnect();
      },
    };
    const exit = () => {
      worker.exited = true;
      if (current === worker) current = undefined;
      for (const request of pending.values()) {
        // The native index went with the process, so there is nothing left to destroy.
        if (request.method === "destroy") request.resolve(undefined);
        else request.reject(new Error("The workspace search worker exited."));
      }
      pending.clear();
    };
    child.on("message", (reply: { id: number; value?: unknown; error?: unknown }) => {
      const request = pending.get(reply.id);
      pending.delete(reply.id);
      if ("error" in reply) request?.reject(reply.error);
      else request?.resolve(reply.value);
    });
    child.once("exit", exit);
    child.once("error", exit);
    return worker;
  }

  yield* Effect.addFinalizer(() => Effect.sync(() => current?.child.kill()));

  return WorkspaceSearchWorker.of({
    create: async (options) => {
      const worker = (current ??= start());
      const finderId = ++nextId;
      worker.finders++;
      const created = (await worker
        .request(finderId, "create", [options])
        .catch((error: unknown) => {
          worker.release();
          throw error;
        })) as Result<void>;
      if (!created.ok) {
        worker.release();
        return created;
      }
      const call =
        <Method extends RemoteFinderMethod>(method: Method) =>
        (...args: Parameters<FileFinderType[Method]>) =>
          worker.request(finderId, method, args) as Promise<
            Awaited<ReturnType<FileFinderType[Method]>>
          >;
      return {
        ok: true,
        value: {
          get alive() {
            return !worker.exited;
          },
          destroy: async () => {
            if (worker.exited) return;
            await worker.request(finderId, "destroy", []);
            worker.release();
          },
          directorySearch: call("directorySearch"),
          fileSearch: call("fileSearch"),
          grep: call("grep"),
          isScanning: call("isScanning"),
          mixedSearch: call("mixedSearch"),
          scanFiles: call("scanFiles"),
          waitForIndexReady: call("waitForIndexReady"),
        },
      };
    },
  });
});

export const layerWorker = Layer.effect(WorkspaceSearchWorker, makeWorker);

const createFinder = Effect.fn("WorkspaceSearchIndex.createFinder")(function* (
  worker: WorkspaceSearchWorker["Service"],
  cwd: string,
  variant: WorkspaceSearchIndexVariant,
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      worker.create({
        basePath: cwd,
        disableMmapCache: true,
        // Content indexing costs CPU/memory; path-only consumers use the lightweight index.
        disableContentIndexing: variant !== "content",
        aiMode: false,
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.create threw unexpectedly.",
        cause,
      }),
  });
  if (result.ok) return result.value;
  return yield* new WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  });
});

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: RemoteFileFinder,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
): Effect.fn.Return<void, E | WorkspaceSearchIndexScanTimedOut> {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) =>
      onFailure({
        reason: "FileFinder.waitForIndexReady rejected unexpectedly.",
        cause,
      }),
  });
  if (!result.ok) {
    return yield* Effect.fail(onFailure({ reason: result.error }));
  }
  if (!result.value) {
    return yield* new WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant = "paths",
) {
  const worker = yield* WorkspaceSearchWorker;
  const indexScope = yield* Effect.scope;
  const reopenLock = yield* Semaphore.make(1);
  let initialScanTimedOut = false;
  const open = Effect.fn("WorkspaceSearchIndex.open")(function* () {
    const scope = yield* Scope.fork(indexScope);
    return yield* Effect.gen(function* () {
      const finder = yield* Effect.acquireRelease(createFinder(worker, cwd, variant), (finder) =>
        Effect.tryPromise({
          try: () => finder.destroy(),
          catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
        }).pipe(Effect.orDie),
      );
      initialScanTimedOut = false;
      yield* waitForIndexReady(
        cwd,
        finder,
        ({ reason, cause }) =>
          new WorkspaceSearchIndexCreateFailed({
            cwd,
            reason,
            cause,
          }),
      ).pipe(
        Effect.catchTags({
          WorkspaceSearchIndexScanTimedOut: (error) =>
            variant === "paths"
              ? Effect.sync(() => {
                  initialScanTimedOut = true;
                })
              : Effect.fail(error),
        }),
      );
      return finder;
    }).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
  });
  let finder = yield* open();
  // A search worker that exited took the native index with it; the next use rebuilds it.
  const currentFinder = reopenLock.withPermits(1)(
    Effect.suspend(() =>
      finder.alive
        ? Effect.succeed(finder)
        : open().pipe(Effect.map((opened) => (finder = opened))),
    ),
  );

  // Reopen first, so a rebuilt index whose scan timed out still reports truncated results.
  const hasIncompleteInitialScan = currentFinder.pipe(
    Effect.ignore,
    Effect.andThen(
      Effect.suspend(() =>
        initialScanTimedOut
          ? Effect.promise(() => finder.isScanning().catch(() => true))
          : Effect.succeed(false),
      ),
    ),
  );

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: (finder: RemoteFileFinder) => Promise<Result<A>>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexSearchFailed> {
    const finder = yield* currentFinder.pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceSearchIndexSearchFailed({
            cwd,
            queryLength: query.length,
            pageSize,
            reason: "The workspace search index could not be reopened.",
            cause,
          }),
      ),
    );
    const result = yield* Effect.tryPromise({
      try: () => execute(finder),
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    const finder = yield* currentFinder.pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceSearchIndexRefreshFailed({
            cwd,
            reason: "The workspace search index could not be reopened.",
            cause,
          }),
      ),
    );
    const result = yield* Effect.tryPromise({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFiles threw unexpectedly.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexRefreshFailed({
        cwd,
        reason: result.error,
      });
    }
    // A rescan that outlasts the wait keeps running, and the finder answers
    // from its previous index until it finishes, so the index stays usable.
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason,
          cause,
        }),
    ).pipe(Effect.catchTags({ WorkspaceSearchIndexScanTimedOut: () => Effect.void }));
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const incompleteBeforeQuery = yield* hasIncompleteInitialScan;
      const result = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "mixedSearch", (finder) =>
        finder.mixedSearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const sortedEntries = withDirectoryAncestors(mapped.entries).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
      return {
        entries,
        truncated:
          incompleteBeforeQuery || mapped.truncated || entries.length < sortedEntries.length,
      };
    },
  );

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (query, limit, kind, imageOnly) {
    const pageSize = imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
    const incompleteBeforeQuery = yield* hasIncompleteInitialScan;
    if (kind === "file" || imageOnly) {
      const result = yield* runSearch(query, pageSize, "fileSearch", (finder) =>
        finder.fileSearch(query, { pageSize }),
      );
      const mapped = mapFileSearchResult(result, limit, imageOnly);
      return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
    }
    if (kind === "directory") {
      const result = yield* runSearch(query, pageSize, "directorySearch", (finder) =>
        finder.directorySearch(query, { pageSize }),
      );
      const mapped = mapDirectorySearchResult(result, limit);
      return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
    }
    const result = yield* runSearch(query, pageSize, "mixedSearch", (finder) =>
      finder.mixedSearch(query, { pageSize }),
    );
    const mapped = mapMixedSearchResult(result, limit);
    return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
  });

  const searchContents: WorkspaceSearchIndex["Service"]["searchContents"] = Effect.fn(
    "WorkspaceSearchIndex.searchContents",
  )(function* (input) {
    let { searchQuery, regexMode } = buildContentSearchQuery(input);
    const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
    // Grep cursors advance per file; whole-word filtering needs enough raw candidates before advancing.
    const rawPageSize = input.wholeWord
      ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE)
      : input.limit;
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    let nextCursor: GrepCursor | null = null;
    let regexFallbackError: string | undefined;
    let retryLiterally = false;

    do {
      const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const result = yield* runSearch(input.query, input.limit, "grep", (finder) =>
        finder.grep(searchQuery, {
          mode: regexMode ? "regex" : "plain",
          smartCase: !input.caseSensitive && !regexMode,
          maxMatchesPerFile: Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, rawPageSize),
          pageSize: rawPageSize,
          cursor: nextCursor,
          timeBudgetMs: remainingTimeBudgetMs,
        }),
      );
      // fff searches an invalid pattern as a literal, which would keep the `(?i)` prefix.
      retryLiterally = regexMode && !input.caseSensitive && result.regexFallbackError !== undefined;
      if (retryLiterally) {
        regexFallbackError = result.regexFallbackError;
        ({ searchQuery, regexMode } = buildContentSearchQuery({ ...input, useRegex: false }));
        continue;
      }

      for (const match of result.items) {
        const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter(
          (range) => !input.wholeWord || isWholeWordRange(match.lineContent, range),
        );
        // fff reports hits past its 512-char lineContent cap with no ranges, so whole words can't be verified there.
        if (input.wholeWord && matchRanges.length === 0) continue;
        matches.push({
          path: toPosixPath(match.relativePath),
          lineNumber: match.lineNumber,
          lineContent: match.lineContent,
          matchRanges,
        });
      }
      nextCursor = result.nextCursor;
      regexFallbackError ??= result.regexFallbackError;
    } while (
      retryLiterally ||
      (matches.length < input.limit && nextCursor !== null && performance.now() < deadline)
    );

    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || nextCursor !== null,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  });

  return WorkspaceSearchIndex.of({ list, refresh, search, searchContents });
});

export const WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"] as const;
export type WorkspaceSearchIndexVariant = (typeof WORKSPACE_SEARCH_INDEX_VARIANTS)[number];

export const workspaceSearchIndexKey = (cwd: string, variant: WorkspaceSearchIndexVariant) =>
  `${variant}\n${cwd}`;

function parseWorkspaceSearchIndexKey(key: string): {
  readonly cwd: string;
  readonly variant: WorkspaceSearchIndexVariant;
} {
  const separatorIndex = key.indexOf("\n");
  return {
    variant: key.slice(0, separatorIndex) as WorkspaceSearchIndexVariant,
    cwd: key.slice(separatorIndex + 1),
  };
}

/** @public */
export const layer = (key: string) => {
  const { cwd, variant } = parseWorkspaceSearchIndexKey(key);
  return Layer.effect(WorkspaceSearchIndex, make(cwd, variant));
};

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "t3/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
    dependencies: [layerWorker],
  },
) {}
