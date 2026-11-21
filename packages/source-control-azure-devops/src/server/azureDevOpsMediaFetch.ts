import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  azureDevOpsPullRequestAttachment,
  type AzureDevOpsPullRequestAttachment,
} from "../shared/azureDevOpsMedia.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const REST_API_VERSION = "7.1";
const MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 60_000;
// Every read starts its own `az` interpreter, so a description full of images must not start
// one per image at once.
const MAX_CONCURRENT_READS = 2;

/**
 * Splits a scratch directory into the parent `cwd` where `az` runs and the relative `--out-file`
 * path it writes to. Keeping `cwd` outside the scratch directory prevents the background
 * telemetry process `az` leaves behind on Windows from locking the directory against removal, and
 * keeping `--out-file` relative lets a Windows `az` launched from WSL write into its inherited
 * `cwd` (`\\wsl.localhost\...`) instead of resolving a leading `/` against a Windows drive root.
 */
export function azureDevOpsMediaScratchPaths(directory: string): {
  readonly cwd: string;
  readonly file: string;
  readonly outFile: string;
} {
  const trimmed = directory.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = trimmed.slice(0, separator);
  const cwd =
    parent === ""
      ? "/"
      : /^[a-z]:$/iu.test(parent)
        ? `${parent}${trimmed[separator]}`
        : parent;
  return {
    cwd,
    file: `${trimmed}/media`,
    outFile: `${trimmed.slice(separator + 1)}/media`,
  };
}

/**
 * Reads an attachment through `az devops invoke`, so it carries whichever credential the extension
 * holds for the organization: an `az login` account or a PAT from `az devops login`.
 */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const reads = yield* Semaphore.make(MAX_CONCURRENT_READS);

  const read = Effect.fnUntraced(function* (
    url: string,
    attachment: AzureDevOpsPullRequestAttachment,
  ) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-azure-media-" });
    // invoke refuses to overwrite its output, so the file gets a name nothing holds yet.
    const { cwd, file, outFile } = azureDevOpsMediaScratchPaths(directory);
    yield* azure.execute({
      cwd,
      timeoutMs: MEDIA_TIMEOUT_MS,
      args: [
        "devops",
        "invoke",
        "--organization",
        attachment.organization,
        "--detect",
        "false",
        "--area",
        "git",
        "--resource",
        "pullRequestAttachments",
        "--api-version",
        REST_API_VERSION,
        "--route-parameters",
        `project=${attachment.project}`,
        `repositoryId=${attachment.repository}`,
        `pullRequestId=${attachment.pullRequestId}`,
        `fileName=${attachment.fileName}`,
        "--accept-media-type",
        "application/octet-stream",
        "--out-file",
        outFile,
        "--only-show-errors",
      ],
    });
    const size = Number((yield* fileSystem.stat(file)).size);
    if (size > MEDIA_MAX_BYTES) return null;
    const bytes = yield* fileSystem.readFile(file);
    const body =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes.slice();
    // `az` keeps no response headers, so the server types the bytes by the attachment's name.
    return HttpClientResponse.fromWeb(
      HttpClientRequest.get(url),
      new Response(body, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  });

  return Effect.fn("AzureDevOpsMediaFetch.fetchMedia")(function* (
    request: SourceControlMediaRequest,
  ) {
    const target = URL.parse(request.url);
    const attachment = target === null ? null : azureDevOpsPullRequestAttachment(target);
    if (attachment === null) return null;
    return yield* reads
      .withPermits(1)(Effect.scoped(read(request.url, attachment)))
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Azure DevOps media read failed.", { cause }).pipe(Effect.as(null)),
        ),
      );
  });
});
