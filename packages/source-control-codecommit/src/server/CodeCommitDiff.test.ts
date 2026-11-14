import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Cli from "./CodeCommitCli.ts";
import * as Diff from "./CodeCommitDiff.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const side = "c".repeat(40);
const older = "d".repeat(40);
const input = {
  cwd: "/repo",
  host: "git-codecommit.us-east-1.amazonaws.com",
  repository: "v1/repos/Repo",
  number: 7,
  snapshot: {
    sourceCommit: head,
    destinationCommit: base,
    mergeBase: base,
    sourceBranch: "feature",
    destinationBranch: "main",
  },
};

it.effect("reads paged differences and excludes base ancestors from merge history", () => {
  const calls: string[][] = [];
  return Effect.gen(function* () {
    const api = yield* Diff.make;
    const cli = yield* Cli.make;
    yield* cli.withConfig(
      Effect.gen(function* () {
        const paths: { oldPath: string; newPath: string }[] = [];
        let pathCursor: string | undefined;
        do {
          const page = yield* api.getDiffFilePaths({ ...input, cursor: pathCursor });
          paths.push(...page.files);
          pathCursor = page.nextCursor ?? undefined;
        } while (pathCursor);
        assert.deepStrictEqual(paths, [
          { oldPath: "old.txt", newPath: "new.txt" },
          { oldPath: "gone", newPath: "gone" },
          { oldPath: "large", newPath: "large" },
          { oldPath: "module", newPath: "module" },
        ]);
        const diff = { patch: "", truncated: false };
        let diffCursor: string | undefined;
        do {
          const page = yield* api.getDiff({ ...input, cursor: diffCursor });
          diff.patch += page.patch;
          diff.truncated ||= page.truncated;
          diffCursor = page.nextCursor ?? undefined;
        } while (diffCursor);
        assert.include(diff.patch, "rename from old.txt");
        assert.include(diff.patch, "-old");
        assert.include(diff.patch, "+new");
        assert.include(diff.patch, "deleted file mode 100755");
        assert.include(diff.patch, "diff --git a/large b/large");
        assert.include(diff.patch, `-Subproject commit ${head}`);
        assert.include(diff.patch, `+Subproject commit ${base}`);
        assert.isTrue(diff.truncated);
        const stats = yield* api.getFileStats(input);
        assert.deepStrictEqual(stats.files, [
          { path: "new.txt", additions: 1, deletions: 1 },
          { path: "gone", additions: 0, deletions: 1 },
          { path: "module", additions: 1, deletions: 1 },
        ]);
        assert.isTrue(stats.truncated);
        const revisions = yield* api.getFileRevisions({ ...input, paths: ["new.txt", "gone"] });
        assert.strictEqual(revisions.revisions.get("new.txt"), "new");
        assert.strictEqual(revisions.revisions.get("gone"), "");
        assert.isTrue(
          Result.isFailure(yield* Effect.result(api.getDiff({ ...input, commit: older }))),
        );
        assert.include((yield* api.getDiff({ ...input, commit: head })).patch, "-old");
        const history = yield* api.getCommits(input);
        assert.deepStrictEqual(
          history.commits.map((c) => c.oid),
          [head, side],
        );
        assert.isFalse(history.truncated);
        assert.isTrue(
          calls.some(
            (args) =>
              args.includes("--before-commit-specifier") &&
              args.includes(base) &&
              args.includes(head),
          ),
        );
      }),
    );
  }).pipe(
    Effect.provide(
      TestSourceControlHost.layer({
        git: {
          execute: ({ args }) =>
            Effect.succeed(
              TestSourceControlHost.processOutput(
                args[0] === "rev-parse"
                  ? "false\n"
                  : `${head}\0${base} ${side}\x002025-02-03T04:05:06+00:00\0head\n${side}\0${older}\x002025-02-03T04:05:06+00:00\0side\n`,
              ),
            ),
        },
        process: {
          run: ({ args }) => {
            calls.push([...args]);
            if (args[1] === "get-blob" && args.includes("large"))
              return Effect.succeed({
                ...TestSourceControlHost.processOutput(""),
                stdoutTruncated: true,
              });
            const result =
              args[1] === "get-differences"
                ? args.includes("--starting-token")
                  ? {
                      differences: [
                        {
                          beforeBlob: { blobId: "old", path: "gone", mode: "100755" },
                          changeType: "D",
                        },
                        {
                          afterBlob: { blobId: "large", path: "large", mode: "100644" },
                          changeType: "A",
                        },
                        {
                          beforeBlob: { blobId: head, path: "module", mode: "160000" },
                          afterBlob: { blobId: base, path: "module", mode: "160000" },
                          changeType: "M",
                        },
                      ],
                    }
                  : {
                      differences: [
                        {
                          beforeBlob: { blobId: "old", path: "old.txt", mode: "100644" },
                          afterBlob: { blobId: "new", path: "new.txt", mode: "100644" },
                          changeType: "M",
                        },
                      ],
                      NextToken: "next",
                    }
                : {
                    content: Buffer.from(args.includes("new") ? "new\n" : "old\n").toString(
                      "base64",
                    ),
                  };
            return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(result)));
          },
        },
      }),
    ),
  );
});

it.effect("uses one head read when local Git objects are missing", () => {
  const calls: string[][] = [];
  return Effect.gen(function* () {
    const api = yield* Diff.make;
    const cli = yield* Cli.make;
    yield* cli.withConfig(
      Effect.gen(function* () {
        const history = yield* api.getCommits(input);
        assert.isTrue(history.truncated);
        assert.deepStrictEqual(
          history.commits.map((item) => item.oid),
          [head],
        );
        assert.isTrue(
          Result.isFailure(yield* Effect.result(api.getDiff({ ...input, commit: older }))),
        );
      }),
    );
    assert.strictEqual(calls.length, 1);
  }).pipe(
    Effect.provide(
      TestSourceControlHost.layer({
        git: {
          execute: ({ operation, cwd }) =>
            Effect.fail(
              new GitCommandError({
                operation,
                cwd,
                command: "git",
                argumentCount: 1,
                detail: "missing object",
              }),
            ),
        },
        process: {
          run: ({ args }) => {
            calls.push([...args]);
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify({
                  commit: {
                    commitId: head,
                    parents: [base],
                    message: "head",
                    committer: { date: "1738540800 +0000" },
                  },
                }),
              ),
            );
          },
        },
      }),
    ),
  );
});

it.effect.each([
  { bytes: Buffer.from("literal \ufffd\n"), binary: false },
  { bytes: Buffer.from([0xff, 0x0a]), binary: true },
  { bytes: Buffer.from([0x00, 0x0a]), binary: true },
])("classifies local blob bytes $bytes as binary=$binary", ({ bytes, binary }) =>
  Effect.gen(function* () {
    const api = yield* Diff.make;
    const cli = yield* Cli.make;
    yield* cli.withConfig(
      Effect.gen(function* () {
        const diff = yield* api.getDiff(input);
        const contents = yield* Effect.result(
          api.getDiffFileContents({
            ...input,
            oldPath: "text.txt",
            newPath: "text.txt",
            changeType: "added",
          }),
        );
        assert.strictEqual(Result.isFailure(contents), binary);
        if (!binary) {
          assert.include(diff.patch, "+literal \ufffd");
          assert.isTrue(Result.isSuccess(contents));
          if (Result.isSuccess(contents))
            assert.strictEqual(contents.success.newContents, "literal \ufffd\n");
        } else assert.include(diff.patch, "Binary files");
      }),
    );
  }).pipe(
    Effect.provide(
      TestSourceControlHost.layer({
        git: {
          execute: () =>
            Effect.succeed(TestSourceControlHost.processOutput(bytes.toString("utf8"))),
        },
        process: {
          run: ({ command, onStdoutChunk }) => {
            if (command === "git") {
              onStdoutChunk?.(bytes.subarray(0, 9));
              onStdoutChunk?.(bytes.subarray(9));
              return Effect.succeed(TestSourceControlHost.processOutput(bytes.toString("utf8")));
            }
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify({
                  differences: [
                    {
                      afterBlob: { blobId: head, path: "text.txt", mode: "100644" },
                      changeType: "A",
                    },
                  ],
                }),
              ),
            );
          },
        },
      }),
    ),
  ),
);

it.effect("pages the full file inventory and reads files beyond the initial thousand", () =>
  Effect.gen(function* () {
    const api = yield* Diff.make;
    const cli = yield* Cli.make;
    yield* cli.withConfig(
      Effect.gen(function* () {
        const files: string[] = [];
        let cursor: string | undefined;
        let lastCursor: string | undefined;
        do {
          lastCursor = cursor;
          const page = yield* api.getDiffFilePaths({ ...input, cursor });
          files.push(...page.files.map((file) => file.newPath));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.strictEqual(files.length, 1001);
        assert.strictEqual(new Set(files).size, 1001);
        assert.strictEqual(files.at(-1), "file-1000.txt");
        const contents = yield* api.getDiffFileContents({
          ...input,
          oldPath: "file-1000.txt",
          newPath: "file-1000.txt",
          changeType: "added",
        });
        assert.strictEqual(contents.newContents, `${"new".repeat(1400)}\n`);
        assert.include(
          (yield* api.getDiff({ ...input, cursor: lastCursor })).patch,
          "b/file-1000.txt",
        );
        const first = yield* api.getDiff(input);
        assert.include(first.patch, "b/file-0.txt");
        assert.notInclude(first.patch, "b/file-99.txt");
        assert.isNotNull(first.nextCursor);
        const next = yield* api.getDiff({ ...input, cursor: first.nextCursor! });
        assert.include(next.patch, "b/file-99.txt");
        assert.notInclude(next.patch, "b/file-0.txt");
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              api.getDiff({
                ...input,
                cursor: first.nextCursor!,
                snapshot: { ...input.snapshot, sourceCommit: side },
              }),
            ),
          ),
        );
      }),
    );
  }).pipe(
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: ({ args }) => {
            if (args[1] === "get-blob")
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify({
                    content: Buffer.from(`${"new".repeat(1400)}\n`).toString("base64"),
                  }),
                ),
              );
            const tokenIndex = args.indexOf("--starting-token");
            const offset = tokenIndex === -1 ? 0 : Number(args[tokenIndex + 1]);
            const end = Math.min(offset + 100, 1001);
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify({
                  differences: Array.from({ length: end - offset }, (_, index) => ({
                    afterBlob: {
                      blobId: "new",
                      path: `file-${offset + index}.txt`,
                      mode: "100644",
                    },
                    changeType: "A",
                  })),
                  ...(end < 1001 ? { NextToken: String(end) } : {}),
                }),
              ),
            );
          },
        },
      }),
    ),
  ),
);
