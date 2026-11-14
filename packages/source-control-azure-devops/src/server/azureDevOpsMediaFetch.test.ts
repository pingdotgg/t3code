// @effect-diagnostics nodeBuiltinImport:off -- Stands in for az writing the attachment.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsMediaFetch from "./azureDevOpsMediaFetch.ts";

const url =
  "https://dev.azure.com/org/My%20Project/_apis/git/repositories/repo/pullRequests/42/attachments/demo.mp4";

it.effect("serves byte ranges of one attachment from a single az download", () => {
  const execute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>((input) => {
    NodeFS.writeFileSync(input.args[input.args.indexOf("--out-file") + 1]!, "0123456789");
    return Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });
  return Effect.gen(function* () {
    const fetchMedia = yield* AzureDevOpsMediaFetch.make;
    const read = (headers: Record<string, string>) =>
      Effect.gen(function* () {
        const response = (yield* fetchMedia({ url, headers }))!;
        return {
          status: response.status,
          range: response.headers["content-range"],
          type: response.headers["content-type"],
          body: yield* response.text,
        };
      });
    expect(yield* read({ range: "bytes=2-4" })).toEqual({
      status: 206,
      range: "bytes 2-4/10",
      type: "video/mp4",
      body: "234",
    });
    expect(yield* read({ range: "bytes=-3" })).toMatchObject({ status: 206, body: "789" });
    expect(yield* read({ range: "bytes=0-", "if-range": '"stale"' })).toMatchObject({
      status: 200,
      body: "0123456789",
    });
    expect((yield* fetchMedia({ url, headers: { range: "bytes=10-" } }))?.status).toBe(416);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0].args).toEqual(
      expect.arrayContaining([
        "--organization",
        "https://dev.azure.com/org",
        "project=My Project",
        "fileName=demo.mp4",
      ]),
    );
    expect(
      yield* fetchMedia({ url: url.replace("demo.mp4", "notes.txt"), headers: {} }),
    ).toBeNull();
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute }), NodeServices.layer),
    ),
  );
});
