import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
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
import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

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

describe("getChangeRequestActivity", () => {
  it.effect.each([
    { iterations: "read", trackedTo: ITERATION.id, line: 12 },
    { iterations: "failed", trackedTo: undefined, line: null },
  ] as const)("places file threads on the diff only when the push list is $iterations", (input) =>
    Effect.gen(function* () {
      const remark = {
        id: "4:1",
        author: null,
        body: "Rename this.",
        createdAt: "2026-07-02T00:00:00Z",
        url: null,
      };
      const thread = {
        id: "4",
        path: "src/app.ts",
        line: 12,
        side: "right" as const,
        isResolved: false,
        isOutdated: false,
        comments: [remark],
      };
      const askedFor: Array<number | undefined> = [];
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            listIterations: () =>
              input.iterations === "read"
                ? Effect.succeed([{ ...ITERATION, id: 1 }, { ...ITERATION, id: 2 }, ITERATION])
                : Effect.fail(
                    new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
                      command: "az",
                      cwd: "/w",
                      operation: "listIterations",
                      cause: "unavailable",
                    }),
                  ),
            listThreads: (threads) => {
              askedFor.push(threads.iterationId);
              return Effect.succeed({
                comments: [
                  { ...remark, kind: "review-comment", path: "src/app.ts", reviewState: null },
                ],
                reviewThreads: [thread],
              });
            },
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "dev.azure.com",
        number: 7,
      });

      expect(activity.reviewThreads).toEqual([{ ...thread, line: input.line }]);
      expect(activity.comments.map((comment) => comment.id)).toEqual(["4:1"]);
      expect(activity.commentsTruncated).toBe(false);
      // The Code tab diffs the latest push, so the lines are the ones that push has.
      expect(askedFor).toEqual([input.trackedTo]);
    }),
  );
});

describe("writing a review", () => {
  const ref = { cwd: "/w", repository: "acme/web", host: "dev.azure.com", number: 7 };

  /** A provider whose thread writes are recorded, and fail from the `failAt`th one on. */
  const recordingProvider = (input: { readonly failAt?: number } = {}) =>
    Effect.gen(function* () {
      const posted: Array<{ readonly body: string; readonly anchor: unknown }> = [];
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            createThread: (thread) => {
              if (input.failAt !== undefined && posted.length + 1 >= input.failAt) {
                return Effect.fail(
                  new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
                    command: "az",
                    cwd: "/w",
                    operation: "createThread",
                    cause: "refused",
                  }),
                );
              }
              posted.push({ body: thread.body, anchor: thread.anchor });
              return Effect.void;
            },
          }),
        ),
      );
      return { provider, posted };
    });

  it.effect("posts the line comments in order, then the summary, and no blank summary", () =>
    Effect.gen(function* () {
      const { provider, posted } = yield* recordingProvider();
      const comments = [
        { path: "src/a.ts", position: { kind: "added" as const, newLine: 4 }, body: "First." },
        { path: "src/b.ts", position: { kind: "deleted" as const, oldLine: 9 }, body: "Second." },
      ];

      yield* provider.submitReview({ ...ref, verdict: "comment", body: "Overall.", comments });
      yield* provider.submitReview({ ...ref, verdict: "comment", body: "  \n", comments });

      expect(posted).toEqual([
        { body: "First.", anchor: { path: "src/a.ts", line: 4, side: "right" } },
        { body: "Second.", anchor: { path: "src/b.ts", line: 9, side: "left" } },
        { body: "Overall.", anchor: undefined },
        { body: "First.", anchor: { path: "src/a.ts", line: 4, side: "right" } },
        { body: "Second.", anchor: { path: "src/b.ts", line: 9, side: "left" } },
      ]);
    }),
  );

  it.effect("pins an unchanged line to the copy of it the reviewer picked", () =>
    Effect.gen(function* () {
      const { provider, posted } = yield* recordingProvider();
      const context = (side: "left" | "right") => ({
        path: "src/a.ts",
        position: { kind: "context" as const, oldLine: 10, newLine: 14, side },
        body: side,
      });

      yield* provider.submitReview({
        ...ref,
        verdict: "comment",
        body: "",
        comments: [context("left"), context("right")],
      });

      expect(posted.map((thread) => thread.anchor)).toEqual([
        { path: "src/a.ts", line: 10, side: "left" },
        { path: "src/a.ts", line: 14, side: "right" },
      ]);
    }),
  );

  it.effect("stops at the first thread Azure refuses, and says so", () =>
    Effect.gen(function* () {
      const { provider, posted } = yield* recordingProvider({ failAt: 2 });
      const draft = (body: string) => ({
        path: "src/a.ts",
        position: { kind: "added" as const, newLine: 1 },
        body,
      });

      const error = yield* provider
        .submitReview({
          ...ref,
          verdict: "comment",
          body: "Overall.",
          comments: [draft("First."), draft("Second.")],
        })
        .pipe(Effect.flip);

      expect(error.operation).toBe("submitReview");
      // What went before the failure stays posted; nothing after it is sent.
      expect(posted.map((thread) => thread.body)).toEqual(["First."]);
    }),
  );

  it.effect("refuses to write to a pull request Azure cannot place", () =>
    Effect.gen(function* () {
      let writes = 0;
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed({ ...PULL_REQUEST, location: null }),
            createThread: () => {
              writes += 1;
              return Effect.void;
            },
          }),
        ),
      );

      const error = yield* provider.comment({ ...ref, body: "Hello." }).pipe(Effect.flip);

      expect(error.operation).toBe("comment");
      expect(writes).toBe(0);
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
