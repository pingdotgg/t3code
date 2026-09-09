import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import { make } from "./AzureDevOpsPullRequestProvider.ts";
import { MAX_DIFF_SLICE_BYTES, MAX_FILE_DIFF_EDITS } from "./azureDevOpsDiff.ts";
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

/**
 * A file whose two sides share no line, so its patch is `lines` removals and `lines` additions of
 * `width` characters each: the diff work and the patch bytes one file costs are both dialled from
 * here, and they are what a slice is bounded by. Each line carries its own number and a prefix
 * as well, so `width` is a floor on how long a line is rather than its byte count.
 */
function side(prefix: string, lines: number, width: number): string {
  const pad = "z".repeat(width);
  return `${Array.from({ length: lines }, (_, line) => `${prefix} ${line} ${pad}`).join("\n")}\n`;
}

const readSlice = (input: {
  readonly paths: ReadonlyArray<string>;
  readonly lines: number;
  readonly width: number;
  /** Paths the host refuses, which is one file's problem rather than the read's. */
  readonly refused?: ReadonlyArray<string>;
  /** Paths the change creates, so the host has nothing to hand back for their old side. */
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
              // Every read suspends before it answers, as a subprocess would, so what runs at
              // once is the scheduler's answer rather than an artefact of resolving inline. The
              // later a file is listed the sooner it answers, to leave the assembled patch
              // nothing but the change list to take its order from.
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

/** Which files the patch carries a section for, in the order it carries them. */
function patchedPaths(patch: string): ReadonlyArray<string> {
  return [...patch.matchAll(/^diff --git a\/(?<path>\S+) b\//gmu)].map(
    (match) => match.groups?.path ?? "",
  );
}

describe("getDiff reads", () => {
  it.effect("asks for both sides of several files at once rather than one side at a time", () =>
    Effect.gen(function* () {
      // Each file is two `az` invocations, each paying a Python interpreter's start-up, so a
      // slice read one side after another is most of what the Code tab waits for.
      const read = yield* readSlice({
        paths: ["a.ts", "b.ts", "c.ts", "d.ts"],
        lines: 2,
        width: 4,
      });

      expect(read.peakInFlight).toBeGreaterThan(2);
    }),
  );

  it.effect("holds the number of files it reads at once down", () =>
    Effect.gen(function* () {
      // The host throttles, and `az` is a process on the same machine the reader runs agents on,
      // so a long change is read in batches rather than all at once.
      const paths = Array.from({ length: 24 }, (_, file) => `file-${file}.ts`);
      const read = yield* readSlice({ paths, lines: 2, width: 4 });

      expect(read.reads).toHaveLength(paths.length * 2);
      expect(read.peakInFlight).toBeLessThanOrEqual(8);
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
      // Its section ends at its header, and the files around it still carry their hunks.
      expect(read.slice.patch).toContain("+++ b/b.ts\ndiff --git a/c.ts");
      expect(read.slice.patch.match(/^@@ /gmu)).toHaveLength(2);
    }),
  );
});

describe("what one diff slice spends", () => {
  it.effect("stops on the byte ceiling without carrying what it read past it", () =>
    Effect.gen(function* () {
      // Two of these fill the slice, and the batch they were read in reached two files further.
      // Those two belong to the next slice: carrying them would put the request past a ceiling
      // that is there to bound what one answer weighs.
      const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
      const read = yield* readSlice({ paths, lines: 100, width: 900 });

      expect(read.slice.patch.length).toBeGreaterThan(MAX_DIFF_SLICE_BYTES);
      expect(patchedPaths(read.slice.patch)).toEqual(["a.ts", "b.ts"]);
      expect(read.slice.nextCursor).toBe(`${ITERATION.id}:2`);
      expect(new Set(read.reads)).toEqual(new Set(["a.ts", "b.ts", "c.ts", "d.ts"]));
    }),
  );

  it.effect("narrows what it reads at once as the slice fills", () =>
    Effect.gen(function* () {
      // Four files fit inside the budget and the fifth is past half of what is left of it, so
      // reading four more would throw most of them away and read them again next slice. Every
      // file is two `az` invocations, so the batch is judged against what the files before it
      // weighed rather than left at its full width to the last file.
      const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];
      const read = yield* readSlice({ paths, lines: 50, width: 450 });

      expect(read.slice.nextCursor).not.toBeNull();
      expect(new Set(read.reads)).toEqual(new Set(patchedPaths(read.slice.patch)));
    }),
  );

  it.effect("stops once the diff work one request may do is spent", () =>
    Effect.gen(function* () {
      // Short lines are cheap on the wire and dear to diff, so the byte ceiling alone would let
      // one request hold the thread through a dozen of them. Each of these is half of what one
      // file is allowed, and the slice ends while there is still room for another.
      const paths = Array.from({ length: 12 }, (_, file) => `file-${file}.ts`);
      const read = yield* readSlice({ paths, lines: MAX_FILE_DIFF_EDITS / 4, width: 1 });

      expect(read.slice.patch.length).toBeLessThan(MAX_DIFF_SLICE_BYTES);
      expect(patchedPaths(read.slice.patch)).toEqual(paths.slice(0, 5));
      expect(read.slice.nextCursor).toBe(`${ITERATION.id}:5`);
    }),
  );

  it.effect("carries a whole new file and stops the slice on what it weighed", () =>
    Effect.gen(function* () {
      // A creation has no edit distance to search out, so no edit bound applies to it and its
      // section is the whole file. What keeps a run of them from filling one answer is the bytes
      // they weighed, which the slice has to be charged for.
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
});
