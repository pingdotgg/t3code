import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { azureDevOpsPullRequestAttachment } from "../shared/azureDevOpsMedia.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const REST_API_VERSION = "7.1";
const MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 60_000;
// Every read starts its own `az` interpreter, so a description full of images must not start
// one per image at once.
const MAX_CONCURRENT_READS = 2;

/**
 * Reads an attachment through `az devops invoke`, so it carries whichever credential the extension
 * holds for the organization: an `az login` account or a PAT from `az devops login`.
 */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const reads = yield* Semaphore.make(MAX_CONCURRENT_READS);

  const read = Effect.fnUntraced(function* (request: SourceControlMediaRequest) {
    const target = URL.parse(request.url);
    const attachment = target === null ? null : azureDevOpsPullRequestAttachment(target);
    if (attachment === null) return null;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-azure-media-" });
    // invoke refuses to overwrite its output, so the file gets a name nothing holds yet.
    const file = `${directory}/media`;
    yield* azure.execute({
      // The organization is named explicitly, so no checkout has to say where `az` runs. Not in
      // `directory` itself: on Windows the telemetry process `az` leaves behind holds its working
      // directory for a few seconds, and the scratch directory could not be removed.
      cwd: directory.replace(/[\\/][^\\/]+$/u, ""),
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
        file,
        "--only-show-errors",
      ],
    });
    const size = Number((yield* fileSystem.stat(file)).size);
    if (size > MEDIA_MAX_BYTES) return null;
    const bytes = yield* fileSystem.readFile(file);
    // `az` keeps no response headers, so the server types the bytes by the attachment's name.
    return HttpClientResponse.fromWeb(
      HttpClientRequest.get(request.url),
      // `Response` takes only views over an `ArrayBuffer`; the file system may hand back a shared one.
      new Response(bytes.slice(), {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  });

  return Effect.fn("AzureDevOpsMediaFetch.fetchMedia")(function* (
    request: SourceControlMediaRequest,
  ) {
    return yield* reads
      .withPermits(1)(Effect.scoped(read(request)))
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Azure DevOps media read failed.", { cause }).pipe(Effect.as(null)),
        ),
      );
  });
});
