import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
  FILES_DIFF_PAGE_SIZE,
  LOCATION_CACHE_CAPACITY,
  make,
  MAX_DIFF_SPAWNS,
} from "./AzureDevOpsPullRequestProvider.ts";
import {
  byteLength,
  MAX_DIFF_SLICE_BYTES,
  MAX_DIFF_SLICE_FILES,
  MAX_FILE_DIFF_EDITS,
  parseAzureDevOpsDiffCursor,
} from "./azureDevOpsDiff.ts";
import type { AzureDevOpsChangeEntry, AzureDevOpsFileDiff } from "./azureDevOpsPullRequestJson.ts";

const ITERATION = { id: 3, headCommit: "head", mergeBaseCommit: "base" };

const PULL_REQUEST = {
  number: 7,
  title: "Pull request 7",
  url: "https://dev.azure.com/acme/web/_git/web/pullrequest/7",
  author: null,
  headBranch: "feat/page",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  closedAt: null,
  body: "",
  reviewRequestLogins: [],
  reviewers: [],
  location: { project: "acme", repository: "web" },
  autoMergeEnabled: false,
};

/** Azure could not give a files diff, so a walk reads the iteration changes as it always did. */
const filesDiffUnavailable = Effect.fail(
  new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
    command: "az",
    cwd: "/w",
    operation: "listFilesDiff",
    cause: "unavailable",
  }),
);

function change(
  path: string,
  changeKind: AzureDevOpsChangeEntry["changeKind"] = "change",
): AzureDevOpsChangeEntry {
  return { path, oldPath: path, changeKind, objectId: "8f80", originalObjectId: "0ca4" };
}

function side(prefix: string, lines: number, width: number): string {
  const pad = "z".repeat(width);
  return `${Array.from({ length: lines }, (_, line) => `${prefix} ${line} ${pad}`).join("\n")}\n`;
}

const readSlice = (input: {
  readonly paths: ReadonlyArray<string>;
  readonly lines: number;
  readonly width: number;
  readonly refused?: ReadonlyArray<string>;
  readonly created?: ReadonlyArray<string>;
  readonly cursor?: string;
}) =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const refused = new Set(input.refused ?? []);
    const created = new Set(input.created ?? []);
    let inFlight = 0;
    let peakInFlight = 0;

    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          listIterations: () => Effect.succeed([ITERATION]),
          listFilesDiff: () => filesDiffUnavailable,
          listIterationChanges: () =>
            Effect.succeed({
              changes: input.paths.map((path) =>
                change(path, created.has(path) ? "new" : "change"),
              ),
              truncated: false,
            }),
          readItemContent: (item) =>
            Effect.gen(function* () {
              reads.push(item.path);
              inFlight += 1;
              peakInFlight = Math.max(peakInFlight, inFlight);
              // Yield like a subprocess to exercise concurrency.
              const answersAfter = input.paths.length - input.paths.indexOf(item.path);
              for (let turn = 0; turn < answersAfter; turn += 1) yield* Effect.yieldNow;
              inFlight -= 1;
              if (refused.has(item.path)) {
                return yield* new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
                  command: "az",
                  cwd: "/w",
                  operation: "readItemContent",
                  cause: "refused",
                });
              }
              const isOldSide = item.commit !== ITERATION.headCommit;
              if (isOldSide && created.has(item.path)) return { contents: "", isBinary: false };
              return {
                contents: side(isOldSide ? "old" : "new", input.lines, input.width),
                isBinary: false,
              };
            }),
        }),
      ),
    );

    const slice = yield* provider.getDiff({
      cwd: "/w",
      repository: "acme/web",
      host: "dev.azure.com",
      number: 7,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return { slice, reads, peakInFlight };
  });

function patchedPaths(patch: string): ReadonlyArray<string> {
  return [...patch.matchAll(/^diff --git a\/(?<path>\S+) b\//gmu)].map(
    (match) => match.groups?.path ?? "",
  );
}

describe("getChangeRequest", () => {
  it.effect("preserves the newest head when file counting fails", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            listIterations: () =>
              Effect.succeed([ITERATION, { ...ITERATION, id: 4, headCommit: "new-head" }]),
            listIterationChanges: () =>
              Effect.fail(
                new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
                  command: "az",
                  cwd: "/w",
                  operation: "listIterationChanges",
                  cause: "unavailable",
                }),
              ),
          }),
        ),
      );

      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "dev.azure.com",
        number: 7,
      });
      expect(detail.headSha).toBe("new-head");
      expect(detail.changedFiles).toBe(0);
    }),
  );

  it.effect.each(["missing", "failed"] as const)(
    "leaves the head unavailable when the iteration read is %s",
    (state) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
              getPullRequest: () => Effect.succeed(PULL_REQUEST),
              listIterations: () =>
                state === "missing"
                  ? Effect.succeed([])
                  : Effect.fail(
                      new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
                        command: "az",
                        cwd: "/w",
                        operation: "listIterations",
                        cause: "unavailable",
                      }),
                    ),
            }),
          ),
        );
        const detail = yield* provider.getChangeRequest({
          cwd: "/w",
          repository: "acme/web",
          host: "dev.azure.com",
          number: 7,
        });
        expect(detail.headSha).toBeUndefined();
        expect(detail.changedFiles).toBe(0);
      }),
  );
});

describe("getDiff reads", () => {
  it.effect("holds every reader together to one request's worth of processes", () =>
    Effect.gen(function* () {
      const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
      let inFlight = 0;
      let peakInFlight = 0;

      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            listIterations: () => Effect.succeed([ITERATION]),
            listFilesDiff: () => filesDiffUnavailable,
            listIterationChanges: () =>
              Effect.succeed({ changes: paths.map((path) => change(path)), truncated: false }),
            readItemContent: () =>
              Effect.gen(function* () {
                inFlight += 1;
                peakInFlight = Math.max(peakInFlight, inFlight);
                // Yield like a subprocess to exercise concurrency.
                yield* Effect.yieldNow;
                yield* Effect.yieldNow;
                inFlight -= 1;
                return { contents: side("new", 2, 4), isBinary: false };
              }),
          }),
        ),
      );

      const readDiff = (number: number) =>
        provider.getDiff({ cwd: "/w", repository: "acme/web", host: "dev.azure.com", number });

      yield* Effect.all([readDiff(7), readDiff(8)], { concurrency: 2 });

      expect(peakInFlight).toBeLessThanOrEqual(MAX_DIFF_SPAWNS);
    }),
  );

  it.effect("leaves a run of files it could not diff at all for the next slice", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: MAX_DIFF_SLICE_FILES + 20 }, (_, at) => `gen/a${at}.bin`);
      const read = yield* readSlice({ paths, lines: 2, width: 4, refused: paths });

      expect(patchedPaths(read.slice.patch)).toHaveLength(MAX_DIFF_SLICE_FILES);
      expect(byteLength(read.slice.patch)).toBeLessThan(MAX_DIFF_SLICE_BYTES);
      expect(parseAzureDevOpsDiffCursor(read.slice.nextCursor)?.fileIndex).toBe(
        MAX_DIFF_SLICE_FILES,
      );
    }),
  );

  it.effect("keeps the patch in the order the change was listed, whoever answered first", () =>
    Effect.gen(function* () {
      const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
      const read = yield* readSlice({ paths, lines: 2, width: 4 });

      expect(patchedPaths(read.slice.patch)).toEqual(paths);
      expect(read.slice.nextCursor).toBeNull();
    }),
  );

  it.effect("leaves a file the host refused listed without its hunks, in its place", () =>
    Effect.gen(function* () {
      const paths = ["a.ts", "b.ts", "c.ts"];
      const read = yield* readSlice({ paths, lines: 2, width: 4, refused: ["b.ts"] });

      expect(patchedPaths(read.slice.patch)).toEqual(paths);
      expect(read.slice.truncated).toBe(true);
      expect(read.slice.patch).toContain("+++ b/b.ts\ndiff --git a/c.ts");
      expect(read.slice.patch.match(/^@@ /gmu)).toHaveLength(2);
    }),
  );
});

describe("what one diff slice spends", () => {
  it.effect("stops on the byte ceiling without carrying what it read past it", () =>
    Effect.gen(function* () {
      const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
      const read = yield* readSlice({ paths, lines: 100, width: 900 });

      expect(read.slice.patch.length).toBeGreaterThan(MAX_DIFF_SLICE_BYTES);
      expect(patchedPaths(read.slice.patch)).toEqual(["a.ts", "b.ts"]);
      expect(read.slice.nextCursor).toBe(`${ITERATION.id}:2`);
      expect(new Set(read.reads)).toEqual(new Set(["a.ts", "b.ts", "c.ts", "d.ts"]));
    }),
  );

  it.effect("stops once the diff work one request may do is spent", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: 12 }, (_, file) => `file-${file}.ts`);
      const read = yield* readSlice({ paths, lines: MAX_FILE_DIFF_EDITS / 4, width: 1 });

      expect(read.slice.patch.length).toBeLessThan(MAX_DIFF_SLICE_BYTES);
      expect(patchedPaths(read.slice.patch)).toEqual(paths.slice(0, 5));
      expect(read.slice.nextCursor).toBe(`${ITERATION.id}:5`);
    }),
  );

  it.effect("carries a whole new file and stops the slice on what it weighed", () =>
    Effect.gen(function* () {
      const paths = ["new.ts", "b.ts", "c.ts", "d.ts"];
      const read = yield* readSlice({ paths, lines: 8_000, width: 30, created: ["new.ts"] });

      expect(patchedPaths(read.slice.patch)).toEqual(["new.ts"]);
      expect(read.slice.patch).toContain("--- /dev/null");
      expect(read.slice.patch).toContain("@@ -0,0 +1,8000 @@");
      expect(read.slice.patch.length).toBeGreaterThan(MAX_DIFF_SLICE_BYTES);
      expect(read.slice.nextCursor).toBe(`${ITERATION.id}:1`);
    }),
  );

  it.effect("carries on from where the last slice stopped", () =>
    Effect.gen(function* () {
      const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
      const read = yield* readSlice({
        paths,
        lines: 100,
        width: 900,
        cursor: `${ITERATION.id}:2`,
      });

      expect(patchedPaths(read.slice.patch)).toEqual(["c.ts", "d.ts"]);
      expect(read.slice.nextCursor).toBe(`${ITERATION.id}:4`);
    }),
  );
  it.effect("keeps the pull request being read, not the one looked up first", () =>
    Effect.gen(function* () {
      const HOT = 7;
      const readsOf = new Map<number, number>();

      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: (input) =>
              Effect.sync(() => {
                readsOf.set(input.number, (readsOf.get(input.number) ?? 0) + 1);
                return { ...PULL_REQUEST, number: input.number };
              }),
            listIterations: () => Effect.succeed([ITERATION]),
            listFilesDiff: () => filesDiffUnavailable,
            listIterationChanges: () =>
              Effect.succeed({ changes: [change("a.ts")], truncated: false }),
            readItemContent: () => Effect.succeed({ contents: side("new", 2, 4), isBinary: false }),
          }),
        ),
      );

      const readDiff = (number: number) =>
        provider.getDiff({ cwd: "/w", repository: "acme/web", host: "dev.azure.com", number });

      yield* readDiff(HOT);
      for (let filled = 0; filled < LOCATION_CACHE_CAPACITY; filled += 1) {
        yield* readDiff(HOT + 1 + filled);
        yield* readDiff(HOT);
      }

      expect(readsOf.get(HOT)).toBe(1);
    }),
  );
});

/** A file Azure lists as new, with the blocks it gives for text that ends in a newline. */
function newFile(path: string, lines: ReadonlyArray<string>): AzureDevOpsFileDiff {
  return {
    change: { path, oldPath: path, changeKind: "new", objectId: null, originalObjectId: null },
    blocks: [
      {
        kind: "add",
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: lines.length + 1,
        oldLines: [],
        newLines: [...lines, ""],
      },
    ],
  };
}

/** Azure lists the files of each page by path, whatever order the change holds them in. */
const orderedByPath = (files: ReadonlyArray<AzureDevOpsFileDiff>) =>
  files.toSorted((left, right) => (left.change.path < right.change.path ? -1 : 1));

const lightFiles = (count: number) =>
  Array.from({ length: count }, (_, at) =>
    newFile(`src/file-${String(at).padStart(4, "0")}.ts`, ["x", "y"]),
  );

/** A provider whose files diff answers from `files`, a page at a time, as Azure does. */
const filesDiffProvider = (input: {
  readonly files: ReadonlyArray<AzureDevOpsFileDiff>;
  readonly failure?: Effect.Effect<never, AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError>;
  readonly iterations?: ReadonlyArray<typeof ITERATION>;
  readonly beforeRead?: (path: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const asks: number[] = [];
    const reads: string[] = [];
    const counts = { iterationChanges: 0 };
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          listIterations: () => Effect.succeed(input.iterations ?? [ITERATION]),
          listFilesDiff: ({ skip, top }) => {
            asks.push(skip);
            if (input.failure !== undefined) return input.failure;
            return Effect.succeed(orderedByPath(input.files.slice(skip, skip + top)));
          },
          listIterationChanges: () => {
            counts.iterationChanges += 1;
            return Effect.succeed({
              changes: input.files.map((file) => file.change),
              truncated: false,
            });
          },
          readItemContent: (item) => {
            reads.push(item.path);
            const isOldSide = item.commit !== ITERATION.headCommit;
            return (input.beforeRead?.(item.path) ?? Effect.void).pipe(
              Effect.as({ contents: side(isOldSide ? "old" : "new", 2, 4), isBinary: false }),
            );
          },
        }),
      ),
    );
    const diff = (cursor?: string, number = 7) =>
      provider.getDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "dev.azure.com",
        number,
        ...(cursor === undefined ? {} : { cursor }),
      });
    return { diff, asks, reads, counts };
  });

describe("getDiff from the files diff", () => {
  it.effect("reads a page of files with one call and no file reads", () =>
    Effect.gen(function* () {
      const files = lightFiles(3);
      const read = yield* filesDiffProvider({ files });

      const slice = yield* read.diff();

      expect(patchedPaths(slice.patch)).toEqual(files.map((file) => file.change.path));
      expect(slice.patch).toContain("@@ -0,0 +1,2 @@\n+x\n+y\n");
      expect(slice.truncated).toBe(false);
      expect(slice.nextCursor).toBeNull();
      expect(read.asks).toEqual([0]);
      expect(read.reads).toEqual([]);
      expect(read.counts.iterationChanges).toBe(0);
    }),
  );

  it.effect.each([{ count: 2 * FILES_DIFF_PAGE_SIZE }, { count: 2 * FILES_DIFF_PAGE_SIZE + 1 }])(
    "walks a list of $count files a page to a slice, ending without calling it truncated",
    ({ count }) =>
      Effect.gen(function* () {
        const files = lightFiles(count);
        const read = yield* filesDiffProvider({ files });

        const paths: string[] = [];
        let cursor: string | undefined;
        do {
          const slice = yield* read.diff(cursor);
          paths.push(...patchedPaths(slice.patch));
          expect(slice.truncated).toBe(false);
          cursor = slice.nextCursor ?? undefined;
        } while (cursor !== undefined);

        expect(paths).toEqual(files.map((file) => file.change.path));
        expect(read.asks).toEqual([0, FILES_DIFF_PAGE_SIZE, 2 * FILES_DIFF_PAGE_SIZE]);
        expect(read.reads).toEqual([]);
      }),
  );

  it.effect("reads a page once for the slices that stop inside it", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 100 }, (_, line) => `${line} ${"z".repeat(1_300)}`);
      const files = Array.from({ length: 60 }, (_, at) =>
        newFile(`src/file-${String(at).padStart(4, "0")}.ts`, lines),
      );
      const read = yield* filesDiffProvider({ files });

      const paths: string[] = [];
      let slices = 0;
      let cursor: string | undefined;
      do {
        const slice = yield* read.diff(cursor);
        paths.push(...patchedPaths(slice.patch));
        cursor = slice.nextCursor ?? undefined;
        slices += 1;
      } while (cursor !== undefined);

      expect(paths).toEqual(files.map((file) => file.change.path));
      expect(slices).toBeGreaterThan(2);
      expect(read.asks).toEqual([0, FILES_DIFF_PAGE_SIZE]);
    }),
  );

  it.effect("keeps the page another walk holds when a walk finishes its own", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 100 }, (_, line) => `${line} ${"z".repeat(1_300)}`);
      const heavy = Array.from({ length: FILES_DIFF_PAGE_SIZE - 1 }, (_, at) =>
        newFile(`src/file-${String(at).padStart(4, "0")}.ts`, lines),
      );
      const slow = { ...newFile("src/zz-slow.ts", ["x"]), blocks: null };
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const read = yield* filesDiffProvider({
        files: [...heavy, slow],
        beforeRead: (path) =>
          path === slow.change.path
            ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      });

      // Pull request 7 reads the last file of its page and is held up reading it.
      const finishing = yield* Effect.forkChild(
        read.diff(`${ITERATION.id}:${FILES_DIFF_PAGE_SIZE - 1}:d`, 7),
      );
      yield* Deferred.await(reached);
      // Pull request 9 stops inside its first page, so its next slice needs it held.
      const first = yield* read.diff(undefined, 9);
      expect(first.nextCursor).not.toBeNull();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(finishing);

      yield* read.diff(first.nextCursor ?? undefined, 9);

      expect(read.asks).toEqual([0, 0]);
    }),
  );

  it.effect("resumes inside a page from the page's start, where Azure's order for it holds", () =>
    Effect.gen(function* () {
      const files = lightFiles(2 * FILES_DIFF_PAGE_SIZE).toReversed();
      const read = yield* filesDiffProvider({ files });
      const page = orderedByPath(files.slice(0, FILES_DIFF_PAGE_SIZE));

      const slice = yield* read.diff(`${ITERATION.id}:17:d`);

      expect(patchedPaths(slice.patch)).toEqual(page.slice(17).map((file) => file.change.path));
      expect(slice.nextCursor).toBe(`${ITERATION.id}:${FILES_DIFF_PAGE_SIZE}:d`);
      expect(read.asks).toEqual([0]);
    }),
  );

  it.effect("carries nothing of a walk whose pull request took another push", () =>
    Effect.gen(function* () {
      const read = yield* filesDiffProvider({
        files: lightFiles(3),
        iterations: [{ ...ITERATION, id: ITERATION.id + 1 }],
      });

      const slice = yield* read.diff(`${ITERATION.id}:2:d`);

      expect(slice).toEqual({ patch: "", truncated: true, nextCursor: null });
    }),
  );

  it.effect("reads the long way a file whose blocks it cannot trust", () =>
    Effect.gen(function* () {
      const files = [
        newFile("a.ts", ["x"]),
        { ...newFile("b.ts", ["x"]), blocks: null },
        newFile("c.ts", ["x"]),
      ];
      const read = yield* filesDiffProvider({ files });

      const slice = yield* read.diff();

      expect(patchedPaths(slice.patch)).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(new Set(read.reads)).toEqual(new Set(["b.ts"]));
      expect(slice.patch.match(/^@@ /gmu)).toHaveLength(3);
    }),
  );

  it.effect.each([
    { name: "Azure lists no files", files: [] as ReadonlyArray<AzureDevOpsFileDiff> },
    {
      name: "Azure cannot give the files diff",
      files: lightFiles(2),
      failure: filesDiffUnavailable,
    },
  ])("reads the iteration changes when $name", ({ name: _name, ...input }) =>
    Effect.gen(function* () {
      const read = yield* filesDiffProvider(input);

      const slice = yield* read.diff();

      expect(read.counts.iterationChanges).toBe(1);
      expect(read.asks).toEqual([0]);
      expect(slice.nextCursor).toBeNull();
    }),
  );

  it.effect("takes a cursor from before the files diff for the iteration changes", () =>
    Effect.gen(function* () {
      const read = yield* filesDiffProvider({ files: lightFiles(3) });

      const slice = yield* read.diff(`${ITERATION.id}:1`);

      expect(patchedPaths(slice.patch)).toEqual(["src/file-0001.ts", "src/file-0002.ts"]);
      expect(read.asks).toEqual([]);
      expect(read.counts.iterationChanges).toBe(1);
    }),
  );

  it.effect("skips a page of a walk under way that cannot be read, and says so", () =>
    Effect.gen(function* () {
      const read = yield* filesDiffProvider({
        files: lightFiles(3 * FILES_DIFF_PAGE_SIZE),
        failure: filesDiffUnavailable,
      });

      const slice = yield* read.diff(`${ITERATION.id}:${FILES_DIFF_PAGE_SIZE}:d`);

      expect(slice).toEqual({
        patch: "",
        truncated: true,
        nextCursor: `${ITERATION.id}:${2 * FILES_DIFF_PAGE_SIZE}:d`,
      });
      expect(read.counts.iterationChanges).toBe(0);
    }),
  );

  it.effect("fails a walk under way when its next page cannot be asked for", () =>
    Effect.gen(function* () {
      const read = yield* filesDiffProvider({
        files: lightFiles(3 * FILES_DIFF_PAGE_SIZE),
        failure: Effect.fail(
          new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
            operation: "execute",
            command: "az",
            cwd: "/w",
            argumentCount: 0,
            cause: "slow down",
          }),
        ),
      });

      const error = yield* Effect.flip(read.diff(`${ITERATION.id}:${FILES_DIFF_PAGE_SIZE}:d`));

      expect(error.cause).toMatchObject({ _tag: "AzureDevOpsCliRateLimitError" });
    }),
  );

  it.effect("ends a walk as truncated when the page it was part-way through has shrunk", () =>
    Effect.gen(function* () {
      const read = yield* filesDiffProvider({ files: lightFiles(20) });

      const slice = yield* read.diff(`${ITERATION.id}:30:d`);

      expect(slice).toEqual({ patch: "", truncated: true, nextCursor: null });
    }),
  );
});
