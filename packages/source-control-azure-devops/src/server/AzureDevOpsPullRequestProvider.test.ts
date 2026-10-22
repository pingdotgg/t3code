import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
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

it.effect("replies to an existing Azure discussion in its pull request repository", () =>
  Effect.gen(function* () {
    const replies: unknown[] = [];
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          replyToThread: (input) =>
            Effect.sync(() => {
              replies.push(input);
            }),
        }),
      ),
    );
    const target = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
    yield* provider.replyToThread({
      ...target,
      threadId: "7734",
      body: "Réponse\nWith **markdown**.",
    });
    expect(replies).toEqual([
      {
        cwd: "/w",
        location: PULL_REQUEST.location,
        number: 7,
        threadId: "7734",
        body: "Réponse\nWith **markdown**.",
      },
    ]);
    expect(provider.capabilities.review.reply).toBe(true);
    expect((yield* provider.getViewerPermissions(target)).comment).toBe(true);
  }),
);

it.effect("refuses a reply without a valid discussion and repository target", () =>
  Effect.gen(function* () {
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
          getPullRequest: () => Effect.succeed({ ...PULL_REQUEST, location: null }),
        }),
      ),
    );
    const target = {
      cwd: "/w",
      repository: "web",
      host: "dev.azure.com",
      number: 7,
      body: "Reply",
    };
    const invalid = yield* Effect.flip(provider.replyToThread({ ...target, threadId: "7734:1" }));
    expect(invalid.detail).toContain("positive integers");
    const missing = yield* Effect.flip(provider.replyToThread({ ...target, threadId: "7734" }));
    expect(missing.detail).toContain("repository");
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
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
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
              // once is the scheduler's answer rather than an artefact of resolving inline.
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

describe("getChangeRequestSummary", () => {
  it.effect("costs the one pull request read, not the iterations changedFiles needs", () =>
    Effect.gen(function* () {
      let pullRequestReads = 0;

      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
            getPullRequest: () => {
              pullRequestReads += 1;
              return Effect.succeed(PULL_REQUEST);
            },
          }),
        ),
      );

      const readSummary = provider.getChangeRequestSummary;
      if (readSummary === undefined) return yield* Effect.die("summary read was not implemented");
      const summary = yield* readSummary({
        cwd: "/w",
        repository: "acme/web",
        host: "dev.azure.com",
        number: 7,
      });

      expect(pullRequestReads).toBe(1);
      expect(summary.title).toBe(PULL_REQUEST.title);
      expect(summary.changedFiles).toBeUndefined();
    }),
  );
});

describe("getChangeRequest", () => {
  it.effect("keeps draft discussions available and enables voting only after publication", () =>
    Effect.gen(function* () {
      let isDraft = true;
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
            getPullRequest: () => Effect.succeed({ ...PULL_REQUEST, isDraft }),
            listChecks: () => Effect.succeed({ checks: [], allowedMergeStrategies: [] }),
            listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
            listIterations: () => Effect.succeed([]),
          }),
        ),
      );
      const ref = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
      const draft = yield* provider.getChangeRequest(ref);
      expect(draft.isDraft).toBe(true);
      expect(draft.viewerPermissions.verdicts).toEqual(["comment"]);
      expect(draft.viewerPermissions.comment).toBe(true);
      expect(draft.viewerPermissions.actions).toContain("ready");
      isDraft = false;
      const published = yield* provider.getChangeRequest(ref);
      expect(published.isDraft).toBe(false);
      expect(published.viewerPermissions.verdicts).toEqual([
        "comment",
        "approve",
        "request-changes",
      ]);
      isDraft = true;
      expect((yield* provider.getChangeRequest(ref)).viewerPermissions.verdicts).toEqual([
        "comment",
      ]);
    }),
  );
  it.effect(
    "shares the iteration read and verifies it belongs to the PR head before selecting checks",
    () =>
      Effect.gen(function* () {
        for (const headSha of ["head", "new-head", undefined]) {
          let iterationReads = 0;
          const checkIterations: Array<number | null> = [];
          const provider = yield* make.pipe(
            Effect.provide(
              Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
                readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
                getPullRequest: () =>
                  Effect.succeed({ ...PULL_REQUEST, ...(headSha ? { headSha } : {}) }),
                listIterations: () =>
                  Effect.sync(() => {
                    iterationReads++;
                    return [ITERATION];
                  }),
                listIterationChanges: () => Effect.succeed({ changes: [], truncated: false }),
                listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
                listChecks: ({ iterationId }) =>
                  Effect.sync(() => {
                    checkIterations.push(iterationId);
                    return { checks: [], allowedMergeStrategies: [] };
                  }),
              }),
            ),
          );
          yield* provider.getChangeRequest({
            cwd: "/w",
            repository: "web",
            host: "dev.azure.com",
            number: 7,
          });
          expect(iterationReads).toBe(1);
          expect(checkIterations).toEqual([headSha === "head" ? 3 : null]);
        }
      }),
  );
  it.effect("still reports the file count the detail panel needs", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            listChecks: () =>
              Effect.succeed({ checks: [], allowedMergeStrategies: ["noFastForward", "squash"] }),
            listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
            listIterations: () => Effect.succeed([ITERATION]),
            listIterationChanges: () =>
              Effect.succeed({ changes: [change("a.ts"), change("b.ts")], truncated: false }),
          }),
        ),
      );

      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "dev.azure.com",
        number: 7,
      });

      expect(detail.changedFiles).toBe(2);
      expect(detail.headSha).toBe(ITERATION.headCommit);
    }),
  );

  it.effect("offers the merge methods policy allows and survives optional read failures", () =>
    Effect.gen(function* () {
      const refused = new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
        cwd: "/w",
        command: "az",
        operation: "read",
        cause: "refused",
      });
      // getHostDetails is left unimplemented: the detail answers without the host details.
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            readAccess: () => Effect.fail(refused),
            getPullRequest: () =>
              Effect.succeed({ ...PULL_REQUEST, labels: [{ name: "shown", color: null }] }),
            listChecks: () => Effect.succeed({ checks: [], allowedMergeStrategies: ["squash"] }),
            listLabelCandidates: () => Effect.fail(refused),
            listIterations: () => Effect.fail(refused),
          }),
        ),
      );

      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "dev.azure.com",
        number: 7,
      });

      expect(detail.mergeCapabilities).toEqual({ merge: false, squash: true, rebase: false });
      expect(detail.labels).toEqual([{ name: "shown", color: null }]);
      expect(detail.changedFiles).toBe(0);
      expect(detail.viewerPermissions.deniedActions).toEqual({});
    }),
  );

  it.effect("preserves the newest head when file counting fails", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            listChecks: () => Effect.succeed({ checks: [], allowedMergeStrategies: [] }),
            listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
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
              readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
              getPullRequest: () => Effect.succeed(PULL_REQUEST),
              listChecks: () => Effect.succeed({ checks: [], allowedMergeStrategies: [] }),
              listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
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
            readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
            listIterations: () => Effect.succeed([ITERATION]),
            listIterationChanges: () =>
              Effect.succeed({ changes: paths.map((path) => change(path)), truncated: false }),
            readItemContent: () =>
              Effect.gen(function* () {
                inFlight += 1;
                peakInFlight = Math.max(peakInFlight, inFlight);
                // Suspends before answering, as a subprocess would, so what is out at once is the
                // scheduler's answer rather than an artefact of resolving inline.
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
            readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
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

it.effect("targets comment mutations by thread and preserves all Azure resolution states", () =>
  Effect.gen(function* () {
    const edits: unknown[] = [];
    const deletes: unknown[] = [];
    const statuses: string[] = [];
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          updateComment: (input) =>
            Effect.sync(() => {
              edits.push(input);
            }),
          deleteComment: (input) =>
            Effect.sync(() => {
              deletes.push(input);
            }),
          setThreadStatus: (input) =>
            Effect.sync(() => {
              statuses.push(input.status);
            }),
        }),
      ),
    );
    const ref = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
    yield* provider.updateComment!({
      ...ref,
      commentId: "7734:3",
      kind: "review-comment",
      body: "Edited",
    });
    yield* provider.deleteComment!({ ...ref, commentId: "7734:3", kind: "review-comment" });
    expect(edits).toEqual([
      expect.objectContaining({
        threadId: "7734",
        commentId: "3",
        body: "Edited",
        location: PULL_REQUEST.location,
      }),
    ]);
    expect(deletes).toEqual([expect.objectContaining({ threadId: "7734", commentId: "3" })]);
    for (const id of ["3", "7734:0", "-1:3", "7734:3:4"]) {
      expect(
        (yield* provider.deleteComment!({ ...ref, commentId: id, kind: "issue-comment" }).pipe(
          Effect.flip,
        )).detail,
      ).toContain("positive integers");
    }
    expect(deletes).toHaveLength(1);
    yield* provider.setThreadResolution({ ...ref, threadId: "7734", resolved: true });
    yield* provider.setThreadResolution({ ...ref, threadId: "7734", resolved: false });
    yield* provider.setThreadResolution({
      ...ref,
      threadId: "7734",
      resolved: true,
      status: "wontFix",
    });
    yield* provider.setThreadResolution({
      ...ref,
      threadId: "7734",
      resolved: false,
      status: "pending",
    });
    expect(statuses).toEqual(["fixed", "active", "wontFix", "pending"]);
  }),
);

it.effect("only accepts native comment likes and returns discussion links", () =>
  Effect.gen(function* () {
    const liked: boolean[] = [];
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          listIterations: () => Effect.succeed([ITERATION]),
          setCommentLike: (input) =>
            Effect.sync(() => {
              liked.push(input.liked);
            }),
          listCommits: () => Effect.succeed([]),
          readDiscussion: () =>
            Effect.succeed({
              reviewThreads: [],
              comments: [
                {
                  id: "8:1",
                  threadId: "8",
                  kind: "issue-comment",
                  author: null,
                  body: "Test",
                  createdAt: "2026-10-15T10:00:00Z",
                  path: null,
                  url: null,
                  reviewState: null,
                },
              ],
            }),
        }),
      ),
    );
    const ref = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
    yield* provider.setReaction({ ...ref, subjectId: "8:1", content: "thumbs-up", reacted: true });
    yield* provider.setReaction({ ...ref, subjectId: "8:1", content: "thumbs-up", reacted: false });
    expect(liked).toEqual([true, false]);
    yield* provider.setReaction({ ...ref, content: "thumbs-up", reacted: true }).pipe(Effect.flip);
    yield* provider
      .setReaction({ ...ref, subjectId: "8:1", content: "heart", reacted: true })
      .pipe(Effect.flip);
    expect(liked).toHaveLength(2);
    const activity = yield* provider.getChangeRequestActivity(ref);
    expect(activity.comments[0]?.url).toBe(`${PULL_REQUEST.url}?discussionId=8#1792058400`);
    expect(activity.events).toEqual([
      {
        id: "azure-created",
        kind: "opened",
        actor: null,
        createdAt: PULL_REQUEST.createdAt,
        body: "Someone created the pull request",
      },
    ]);
  }),
);

it.effect(
  "blocks known permissions, keeps learned denials until an explicit refresh or a new credential",
  () =>
    Effect.gen(function* () {
      let credentialKey = "restricted";
      let contribute = false;
      let attempts = 0;
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            readAccess: () => Effect.sync(() => ({ credentialKey, permissions: { contribute } })),
            replyToThread: () =>
              Effect.suspend(() => {
                attempts++;
                return credentialKey === "restricted"
                  ? Effect.fail(
                      new AzureDevOpsCli.AzureDevOpsNativeRequestError({
                        cwd: "/w",
                        command: "az",
                        operation: "execute",
                        argumentCount: 3,
                        reason: "permission-denied",
                        cause: "private SDK refusal text",
                      }),
                    )
                  : Effect.void;
              }),
          }),
        ),
      );
      const input = {
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 7,
        threadId: "2",
        body: "Test",
      };
      const permission = yield* Effect.flip(provider.replyToThread(input));
      expect(permission.detail).toContain("account");
      expect(attempts).toBe(0);
      contribute = true;
      yield* provider.invalidate!(input);
      const refused = yield* Effect.flip(provider.replyToThread(input));
      expect(refused.reason).toBe("failed");
      expect(refused.detail).toContain("Your token");
      expect(attempts).toBe(1);
      // Held past the permission read's own lifetime: only a refresh or a new credential clears it.
      yield* TestClock.adjust("1 minute");
      expect((yield* provider.getViewerPermissions(input)).deniedActions?.comment).toContain(
        "Your token",
      );
      yield* Effect.flip(provider.replyToThread(input));
      expect(attempts).toBe(1);
      yield* provider.invalidate!(input);
      expect((yield* provider.getViewerPermissions(input)).deniedActions).toEqual({});
      yield* Effect.flip(provider.replyToThread(input));
      expect(attempts).toBe(2);
      credentialKey = "full-access";
      yield* TestClock.adjust("1 minute");
      yield* provider.replyToThread(input);
      expect(attempts).toBe(3);
      expect((yield* provider.getViewerPermissions(input)).deniedActions).toEqual({});
    }),
);

it.effect("does not remember an authentication failure as a permission denial", () =>
  Effect.gen(function* () {
    let signedIn = false;
    let attempts = 0;
    const authentication = new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
      cwd: "/w",
      command: "az",
      operation: "execute",
      argumentCount: 3,
      cause: "private credential diagnostics",
    });
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          readAccess: () => Effect.succeed({ credentialKey: "same-account", permissions: {} }),
          replyToThread: () =>
            Effect.suspend(() => {
              attempts++;
              return signedIn ? Effect.void : Effect.fail(authentication);
            }),
        }),
      ),
    );
    const input = {
      cwd: "/w",
      repository: "web",
      host: "dev.azure.com",
      number: 7,
      threadId: "2",
      body: "Test",
    };
    const failure = yield* provider.replyToThread(input).pipe(Effect.flip);
    expect(failure.reason).toBe("unauthenticated");
    expect(failure.cause).toBe(authentication);
    expect(failure.message).not.toContain("private credential diagnostics");
    expect((yield* provider.getViewerPermissions(input)).deniedActions).toEqual({});
    signedIn = true;
    yield* provider.replyToThread(input);
    expect(attempts).toBe(2);
  }),
);

it.effect("reads permissions once for the service's check and the write behind it", () =>
  Effect.gen(function* () {
    let reads = 0;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          readAccess: () =>
            Effect.sync(() => {
              reads++;
              return { credentialKey: "test-pat", permissions: { contribute: true } };
            }),
          replyToThread: () => Effect.void,
        }),
      ),
    );
    const input = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
    yield* provider.getViewerPermissions(input);
    yield* provider.replyToThread({ ...input, threadId: "2", body: "Test" });
    expect(reads).toBe(1);
  }),
);

it.effect("lets Azure decide a write when the permission read fails, keeping learned denials", () =>
  Effect.gen(function* () {
    let readable = false;
    let refuse = false;
    let attempts = 0;
    const readError = (cause: string, reason?: "permission-denied") =>
      new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
        cwd: "/w",
        command: "az",
        operation: "permissions",
        reason,
        cause,
      });
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          readAccess: () =>
            Effect.suspend(() =>
              readable
                ? Effect.succeed({ credentialKey: "test-pat", permissions: { contribute: true } })
                : Effect.fail(readError("Azure refused the review-context request (HTTP 500).")),
            ),
          replyToThread: () =>
            Effect.suspend(() => {
              attempts++;
              return refuse
                ? Effect.fail(readError("Access denied: missing permission", "permission-denied"))
                : Effect.void;
            }),
        }),
      ),
    );
    const input = {
      cwd: "/w",
      repository: "web",
      host: "dev.azure.com",
      number: 7,
      threadId: "2",
      body: "Test",
    };
    expect((yield* provider.getViewerPermissions(input)).deniedActions).toEqual({});
    yield* provider.replyToThread(input);
    expect(attempts).toBe(1);
    refuse = true;
    yield* Effect.flip(provider.replyToThread(input));
    expect(attempts).toBe(2);
    expect((yield* provider.getViewerPermissions(input)).deniedActions?.comment).toContain(
      "Your token",
    );
    yield* Effect.flip(provider.replyToThread(input));
    expect(attempts).toBe(2);
    // A denial learned while the read was failing belongs to the credential it recovers with.
    readable = true;
    expect((yield* provider.getViewerPermissions(input)).deniedActions?.comment).toContain(
      "Your token",
    );
  }),
);

it.effect("checks a completion's strategy against policy alone", () =>
  Effect.gen(function* () {
    const actions: unknown[] = [];
    // getHostDetails is left unimplemented, so checking a merge must not reach for it.
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
          listMergeStrategies: () => Effect.succeed(["squash"]),
          runPullRequestAction: (input) =>
            Effect.sync(() => {
              actions.push(input.mergeMethod);
            }),
        }),
      ),
    );
    const input = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
    const refused = yield* Effect.flip(
      provider.runAction({ ...input, action: "merge", mergeMethod: "merge" }),
    );
    expect(refused.detail).toContain("Branch policy");
    yield* provider.runAction({ ...input, action: "merge", mergeMethod: "squash" });
    expect(actions).toEqual(["squash"]);
  }),
);

it.effect("refuses a verdict on a draft before posting any of the review", () =>
  Effect.gen(function* () {
    // createThreads and runHostAction are left unimplemented, so posting anything would die.
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed({ ...PULL_REQUEST, isDraft: true }),
          readAccess: () => Effect.succeed({ credentialKey: "test-pat", permissions: {} }),
        }),
      ),
    );
    const refused = yield* Effect.flip(
      provider.submitReview({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 7,
        verdict: "approve",
        body: "Looks good",
        comments: [
          {
            path: "file.ts",
            position: { kind: "added", newLine: 3 },
            body: "Nit",
          },
        ],
      }),
    );
    expect(refused.detail).toContain("Publish this draft");
  }),
);

it.effect("compares selected pushes and reads the matching before/after contents", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          listIterations: () =>
            Effect.succeed([
              { id: 1, headCommit: "first", mergeBaseCommit: "base" },
              { id: 2, headCommit: "second", mergeBaseCommit: "base" },
            ]),
          listIterationChanges: (input) => {
            expect(input).toMatchObject({ iterationId: 2, compareTo: 1 });
            return Effect.succeed({ changes: [change("file.ts")], truncated: false });
          },
          readItemContent: (input) => {
            reads.push(input.commit);
            return Effect.succeed({ contents: input.commit + "\n", isBinary: false });
          },
        }),
      ),
    );
    const input = {
      cwd: "/w",
      repository: "web",
      host: "dev.azure.com",
      number: 7,
      iterationRange: { from: 1, to: 2 },
    };
    const diff = yield* provider.getDiff(input);
    expect(diff.patch).toContain("-first");
    expect(diff.patch).toContain("+second");
    expect(reads.sort()).toEqual(["first", "second"]);
    const invalid = yield* Effect.flip(
      provider.getDiff({ ...input, iterationRange: { from: 2, to: 8 } }),
    );
    expect(invalid.operation).toBe("invalid update comparison");
  }),
);

it.effect(
  "uses native blob hashes, notices changed files, and reports denied review progress",
  () =>
    Effect.gen(function* () {
      let denied = false;
      const hashes: Record<string, number> = { "1@old00000@/file.ts": 2 };
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
            getPullRequest: () => Effect.succeed(PULL_REQUEST),
            readAccess: () => Effect.succeed({ credentialKey: "test", permissions: {} }),
            listIterations: () => Effect.succeed([ITERATION]),
            listIterationChanges: () =>
              Effect.succeed({
                changes: [{ ...change("file.ts"), objectId: "abcdef0123456789" }],
                truncated: false,
              }),
            readVisit: (input) => {
              for (const hash of input.hashes ?? []) hashes[hash] = input.viewed ? 2 : 1;
              return Effect.succeed({ hashes, denied });
            },
          }),
        ),
      );
      const input = { cwd: "/w", repository: "web", host: "dev.azure.com", number: 7 };
      expect((yield* provider.getFilesViewed!(input)).files[0]?.state).toBe("dismissed");
      yield* provider.setFilesViewed!({ ...input, files: [{ path: "file.ts", viewed: true }] });
      expect(hashes["1@abcdef01@/file.ts"]).toBe(2);
      expect((yield* provider.getFilesViewed!(input)).files[0]?.state).toBe("viewed");
      yield* provider.setFilesViewed!({ ...input, files: [{ path: "file.ts", viewed: false }] });
      expect((yield* provider.getFilesViewed!(input)).files[0]?.state).toBe("unviewed");
      denied = true;
      expect((yield* provider.getFilesViewed!(input)).disabledReason).toContain("Your token");
    }),
);

it.effect("distinguishes unchanged and deleted anchors when Azure returns original positions", () =>
  Effect.gen(function* () {
    let reads = 0;
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({
          getPullRequest: () => Effect.succeed(PULL_REQUEST),
          listIterations: () =>
            Effect.succeed([
              { ...ITERATION, id: 1, headCommit: "before" },
              { ...ITERATION, id: 2, headCommit: "after" },
            ]),
          listCommits: () => Effect.succeed([]),
          readDiscussion: () =>
            Effect.succeed({
              comments: [],
              untrackedThreadIds: ["1", "2"],
              reviewThreads: [1, 2].map((line) => ({
                id: String(line),
                path: "fixture.txt",
                line,
                side: "right" as const,
                isResolved: false,
                isOutdated: false,
                originalUpdate: 1,
                originalLine: line,
                comments: [],
              })),
            }),
          readItemContent: ({ commit }) =>
            Effect.sync(() => {
              reads++;
              return {
                contents:
                  commit === "before"
                    ? "Unchanged line\nDeleted line\n"
                    : "Unchanged line\nOther line\n",
                isBinary: false,
              };
            }),
        }),
      ),
    );
    const result = yield* provider.getChangeRequestActivity({
      cwd: "/w",
      repository: "web",
      host: "dev.azure.com",
      number: 7,
    });
    expect(result.reviewThreads.map(({ isOutdated }) => isOutdated)).toEqual([false, true]);
    expect(reads).toBe(2);
  }),
);
