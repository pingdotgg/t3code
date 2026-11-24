import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(
    Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabMediaFetch", (it) => {
  it.effect("reads an uploaded avatar's bytes through glab, signed in to its host", () =>
    Effect.gen(function* () {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
      mockedRun.mockImplementationOnce((input) =>
        Effect.sync(() => {
          input.onStdoutChunk?.(png);
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: new TextDecoder().decode(png),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
      );
      const url = "https://git.example.test/uploads/-/system/user/avatar/857/avatar.png?v=1";
      const fetchMedia = yield* GitLabMediaFetch.make;
      const response = yield* fetchMedia({ url, headers: {}, cwd: "/repo" });

      assert.deepStrictEqual(mockedRun.mock.calls[0]?.[0].args, [
        "api",
        "--hostname",
        "git.example.test",
        url,
      ]);
      assert.strictEqual(response?.status, 200);
      if (response === null) return;
      assert.deepStrictEqual(new Uint8Array(yield* response.arrayBuffer), png);
    }),
  );
});
