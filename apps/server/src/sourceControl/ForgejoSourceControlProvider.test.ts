import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const pull = (number: number, branch: string) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://forgejo.example/owner/repo/pulls/${number}`,
  state: "open",
  merged: false,
  base: { ref: "main", sha: "base", repo: null },
  head: { ref: branch, sha: "head", repo: null },
});

it.effect("stops searching for a branch's pull request after the most recent pages", () =>
  Effect.gen(function* () {
    const paths: Array<string> = [];
    const provider = yield* ForgejoSourceControlProvider.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ForgejoCli.ForgejoCli)({
            resolveRepository: () =>
              Effect.succeed({
                login: "forgejo",
                repository: "owner/repo",
                baseUrl: "https://forgejo.example",
              }),
            api: (input) => {
              paths.push(input.path);
              const page = Number(new URL(input.path, "https://x").searchParams.get("page"));
              const items = Array.from({ length: page <= 5 ? 50 : 0 }, (_, index) =>
                pull(page * 50 + index, "other"),
              );
              return Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: JSON.stringify(items),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          }),
          FileSystem.layerNoop({}),
          Layer.mock(VcsProcess.VcsProcess)({}),
        ),
      ),
    );

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/no-pr",
      state: "all",
    });

    assert.deepStrictEqual(changeRequests, []);
    assert.strictEqual(paths.length, 2);
  }),
);
