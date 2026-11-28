import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeLocalMergeabilityReader } from "./localMergeability.ts";
import type * as SourceControlHost from "./SourceControlHost.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

/** A git that answers each subcommand with an exit code and records the commands it ran. */
function fakeGit(exitCodes: {
  readonly catFile: (args: ReadonlyArray<string>) => number;
  readonly fetch?: number;
  readonly mergeTree?: number;
}) {
  const runs: Array<ReadonlyArray<string>> = [];
  const process: SourceControlHost.SourceControlHost["Service"]["process"] = {
    run: (input) => {
      runs.push(input.args);
      const [command] = input.args;
      const exitCode =
        command === "cat-file"
          ? exitCodes.catFile(input.args)
          : command === "fetch"
            ? (exitCodes.fetch ?? 0)
            : (exitCodes.mergeTree ?? 0);
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(exitCode),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  };
  return { process, runs, commands: () => runs.map((args) => args[0]) };
}

const present = () => 0;

it.effect.each([
  [0, "mergeable"],
  [1, "conflicting"],
  [129, "unknown"],
] as const)("reads merge-tree exit %s as %s", ([mergeTree, expected]) =>
  Effect.gen(function* () {
    const git = fakeGit({ catFile: present, mergeTree });
    const read = makeLocalMergeabilityReader(git.process);
    assert.strictEqual(yield* read({ cwd: "/repo", baseSha: BASE, headSha: HEAD }), expected);
    assert.deepStrictEqual(git.runs.at(-1), [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      BASE,
      HEAD,
    ]);
  }),
);

it.effect("runs no git for a commit that is not a full object name", () =>
  Effect.gen(function* () {
    const git = fakeGit({ catFile: present });
    const read = makeLocalMergeabilityReader(git.process);
    assert.strictEqual(yield* read({ cwd: "/repo", baseSha: "main", headSha: HEAD }), "unknown");
    assert.strictEqual(yield* read({ cwd: "/repo", baseSha: BASE, headSha: "--all" }), "unknown");
    assert.deepStrictEqual(git.runs, []);
  }),
);

it.effect("fetches missing commits from the source before merging", () =>
  Effect.gen(function* () {
    let fetched = false;
    const git = fakeGit({
      catFile: () => (fetched ? 0 : 1),
      mergeTree: 1,
    });
    const run = git.process.run;
    const process: typeof git.process = {
      run: (input) => {
        if (input.args[0] === "fetch") fetched = true;
        return run(input);
      },
    };
    const read = makeLocalMergeabilityReader(process);
    const result = yield* read({
      cwd: "/repo",
      baseSha: BASE,
      headSha: HEAD,
      fetchSource: Effect.succeed({
        url: "https://forge.example/maria/project.git",
        refs: ["refs/pull/7/head", "refs/heads/main", "--upload-pack=evil", "a..b"],
      }),
    });
    assert.strictEqual(result, "conflicting");
    const fetch = git.runs.find((args) => args[0] === "fetch");
    assert.deepStrictEqual(fetch?.slice(-4), [
      "--",
      "https://forge.example/maria/project.git",
      "refs/pull/7/head",
      "refs/heads/main",
    ]);
    assert.isTrue(fetch?.includes("--no-write-fetch-head"));
  }),
);

it.effect("stays unknown without fetching when no source is given or the fetch fails", () =>
  Effect.gen(function* () {
    const missing = fakeGit({ catFile: () => 128 });
    const read = makeLocalMergeabilityReader(missing.process);
    assert.strictEqual(yield* read({ cwd: "/repo", baseSha: BASE, headSha: HEAD }), "unknown");
    assert.deepStrictEqual(missing.commands(), ["cat-file"]);

    const failing = fakeGit({ catFile: () => 1, fetch: 128 });
    const readFailing = makeLocalMergeabilityReader(failing.process);
    const unknown = yield* readFailing({
      cwd: "/repo",
      baseSha: BASE,
      headSha: HEAD,
      fetchSource: Effect.succeed({
        url: "https://forge.example/x/y.git",
        refs: ["refs/heads/main"],
      }),
    });
    assert.strictEqual(unknown, "unknown");
    assert.deepStrictEqual(failing.commands(), ["cat-file", "fetch"]);
  }),
);

it.effect("merges a commit pair once and remembers its answer", () =>
  Effect.gen(function* () {
    const git = fakeGit({ catFile: present, mergeTree: 1 });
    const read = makeLocalMergeabilityReader(git.process);
    const input = { cwd: "/repo", baseSha: BASE, headSha: HEAD };
    assert.strictEqual(yield* read(input), "conflicting");
    assert.strictEqual(yield* read({ ...input, baseSha: BASE.toUpperCase() }), "conflicting");
    assert.deepStrictEqual(git.commands(), ["cat-file", "cat-file", "merge-tree"]);
    yield* read({ ...input, cwd: "/other" });
    assert.strictEqual(git.commands().filter((command) => command === "merge-tree").length, 2);
  }),
);
