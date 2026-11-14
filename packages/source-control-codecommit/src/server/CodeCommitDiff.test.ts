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
        const paths = yield* api.getDiffFilePaths(input);
        assert.deepStrictEqual(paths.files, [
          { oldPath: "old.txt", newPath: "new.txt" },
          { oldPath: "gone", newPath: "gone" },
          { oldPath: "large", newPath: "large" },
        ]);
        const diff = yield* api.getDiff(input);
        assert.include(diff.patch, "rename from old.txt");
        assert.include(diff.patch, "-old");
        assert.include(diff.patch, "+new");
        assert.include(diff.patch, "deleted file mode 100755");
        assert.include(diff.patch, "diff --git a/large b/large");
        assert.isTrue(diff.truncated);
        const stats = yield* api.getFileStats(input);
        assert.deepStrictEqual(stats.files, [
          { path: "new.txt", additions: 1, deletions: 1 },
          { path: "gone", additions: 0, deletions: 1 },
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
