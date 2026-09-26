import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as FileSystem from "effect/FileSystem";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const output = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const pull = (number: number, headRef: string) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://forge.test/owner/repo/pulls/${number}`,
  state: "open",
  merged: false,
  base: { ref: "main", sha: "base", repo: { full_name: "owner/repo", owner: { login: "owner" } } },
  head: { ref: headRef, sha: "head", repo: { full_name: "owner/repo", owner: { login: "owner" } } },
});

function makeProvider(cli: Partial<ForgejoCli.ForgejoCli["Service"]>) {
  return ForgejoSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              login: "forge",
              repository: "owner/repo",
              baseUrl: "https://forge.test",
            }),
          ...cli,
        }),
        Layer.mock(VcsProcess.VcsProcess)({}),
        FileSystem.layerNoop({}),
      ),
    ),
  );
}

it.effect("narrows the pull request listing to the head branch server-side", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* makeProvider({
      api: (input) => {
        paths.push(input.path);
        return Effect.succeed(
          output(JSON.stringify(paths.length === 1 ? [pull(7, "feature/branch")] : [])),
        );
      },
    });

    const results = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/branch",
      state: "all",
      limit: 20,
    });

    assert.deepStrictEqual(
      results.map((result) => result.number),
      [7],
    );
    // The scan stops once the server answers an empty page, which only stays cheap
    // while the server does the branch filtering.
    assert.strictEqual(paths.length, 2);
    for (const path of paths) {
      assert.include(path, "head=feature%2Fbranch");
    }
  }),
);
