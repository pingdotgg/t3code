// @effect-diagnostics nodeBuiltinImport:off -- Stands in for az writing its output file.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsMediaFetch from "./azureDevOpsMediaFetch.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  Layer.mergeAll(
    Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute: mockedExecute }),
    NodeServices.layer,
  ),
);

const empty = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

const url =
  "https://dev.azure.com/acme/My%20Project/_apis/git/repositories/web/pullRequests/7/attachments/image%20(1)%23.png";

afterEach(() => {
  mockedExecute.mockReset();
});

layer("AzureDevOpsMediaFetch", (it) => {
  it.effect("reads an attachment with the organization's az credential", () =>
    Effect.gen(function* () {
      const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
      let outFile = "";
      mockedExecute.mockImplementationOnce((input) =>
        Effect.sync(() => {
          outFile = input.args[input.args.indexOf("--out-file") + 1] ?? "";
          NodeFS.writeFileSync(`${input.cwd}/${outFile}`, png);
          return empty;
        }),
      );
      const fetchMedia = yield* AzureDevOpsMediaFetch.make;

      const response = yield* Effect.scoped(fetchMedia({ url, headers: { range: "bytes=0-1" } }));

      expect(response?.status).toBe(200);
      expect(response?.headers["content-length"]).toBe("4");
      expect(new Uint8Array(yield* response!.arrayBuffer)).toEqual(png);
      const [input] = mockedExecute.mock.calls[0]!;
      expect(input.args).toEqual([
        "devops",
        "invoke",
        "--organization",
        "https://dev.azure.com/acme",
        "--detect",
        "false",
        "--area",
        "git",
        "--resource",
        "pullRequestAttachments",
        "--api-version",
        "7.1",
        "--route-parameters",
        "project=My%20Project",
        "repositoryId=web",
        "pullRequestId=7",
        // az leaves `#` bare in the request path, so the name arrives escaped already.
        "fileName=image%20(1)%23.png",
        "--accept-media-type",
        "application/octet-stream",
        "--out-file",
        outFile,
        "--only-show-errors",
      ]);
      // Relative to `cwd`, so a Windows `az` under WSL resolves it inside `cwd` (`\\wsl.localhost\...`).
      expect(outFile).toMatch(/^t3-azure-media-[^/\\]+\/media$/u);
      // No checkout scopes the read, and its scratch directory is gone once the bytes are read.
      const scratch = `${input.cwd}/${outFile.slice(0, outFile.lastIndexOf("/"))}`;
      expect(NodeFS.existsSync(scratch)).toBe(false);
      // `az` runs beside the scratch directory, never in it: what it leaves running would lock it.
      expect(input.cwd).not.toBe(scratch);
      expect(NodeFS.existsSync(input.cwd)).toBe(true);
    }),
  );

  it("preserves root separators when splitting scratch paths across POSIX and Windows roots", () => {
    expect(
      AzureDevOpsMediaFetch.azureDevOpsMediaScratchPaths("/tmp/t3-azure-media-123"),
    ).toEqual({
      cwd: "/tmp",
      file: "/tmp/t3-azure-media-123/media",
      outFile: "t3-azure-media-123/media",
    });
    expect(AzureDevOpsMediaFetch.azureDevOpsMediaScratchPaths("/t3-azure-media-123")).toEqual({
      cwd: "/",
      file: "/t3-azure-media-123/media",
      outFile: "t3-azure-media-123/media",
    });
    expect(
      AzureDevOpsMediaFetch.azureDevOpsMediaScratchPaths("C:\\t3-azure-media-123\\"),
    ).toEqual({
      cwd: "C:\\",
      file: "C:\\t3-azure-media-123/media",
      outFile: "t3-azure-media-123/media",
    });
  });

  it.effect("answers null when az cannot read the attachment, and runs az only for one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new AzureDevOpsCli.AzureDevOpsCommandFailedError({
            operation: "execute",
            command: "az",
            cwd: "/w",
            argumentCount: 1,
            cause:
              "The requested pull request comment attachment 'image (1)#.png' cannot be found.",
          }),
        ),
      );
      const fetchMedia = yield* AzureDevOpsMediaFetch.make;

      expect(yield* Effect.scoped(fetchMedia({ url, headers: {} }))).toBeNull();
      expect(
        yield* Effect.scoped(fetchMedia({ url: "https://example.com/a.png", headers: {} })),
      ).toBeNull();
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );
});
