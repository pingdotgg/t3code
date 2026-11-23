import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";

it.effect("serves a Git LFS file's object through glab, not the pointer a raw read returns", () => {
  const object = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls: Array<Parameters<GitLabCli.GitLabCli["Service"]["execute"]>[0]> = [];
  return Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    const response = yield* fetchMedia({
      url: "https://git.example.com/group/sub/project/-/raw/0123456789abcdef0123456789abcdef01234567/art/a%20b.png",
      headers: {},
      cwd: "/repo",
    });
    expect(response?.status).toBe(200);
    expect(new Uint8Array(yield* response!.arrayBuffer)).toEqual(object);
    expect(calls.map(({ cwd, callerNamedHost, args }) => ({ cwd, callerNamedHost, args }))).toEqual(
      [
        {
          cwd: "/repo",
          callerNamedHost: "git.example.com",
          args: [
            "api",
            "--hostname",
            "git.example.com",
            "projects/group%2Fsub%2Fproject/repository/files/art%2Fa%20b.png/raw?ref=0123456789abcdef0123456789abcdef01234567&lfs=true",
          ],
        },
      ],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: (input) =>
          Effect.sync(() => {
            calls.push(input);
            input.onStdoutChunk?.(object.subarray(0, 3));
            input.onStdoutChunk?.(object.subarray(3));
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );
});

it.effect("returns nothing when glab output was truncated past the media cap", () => {
  const object = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    const response = yield* fetchMedia({
      url: "https://git.example.com/group/sub/project/-/raw/0123456789abcdef0123456789abcdef01234567/art/a%20b.png",
      headers: {},
      cwd: "/repo",
    });
    expect(response).toBeNull();
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: (input) =>
          Effect.sync(() => {
            input.onStdoutChunk?.(object);
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: true,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );
});
