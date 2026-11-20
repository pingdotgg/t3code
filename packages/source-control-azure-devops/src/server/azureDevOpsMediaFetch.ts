import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { azureDevOpsWorkItemAttachment } from "../shared/azureDevOpsMedia.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

/**
 * `az` holds the environment's credential and writes an attachment only to a file, so the whole
 * file is read and served; a range request gets all of it.
 */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fileSystem = yield* FileSystem.FileSystem;

  const download = Effect.fn("AzureDevOpsMediaFetch.download")(function* (
    organizationUrl: string,
    id: string,
  ) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-azure-media-" });
    const file = `${directory}/attachment`;
    yield* azure.execute({
      cwd: directory,
      args: [
        "devops",
        "invoke",
        "--detect",
        "false",
        "--organization",
        organizationUrl,
        "--area",
        "wit",
        "--resource",
        "attachments",
        "--route-parameters",
        `id=${id}`,
        "--api-version",
        "7.1",
        "--accept-media-type",
        "application/octet-stream",
        "--out-file",
        file,
        "--only-show-errors",
        "--output",
        "none",
      ],
      timeoutMs: 120_000,
    });
    return yield* fileSystem.readFile(file);
  }, Effect.scoped);

  return Effect.fn("AzureDevOpsMediaFetch.fetchMedia")(
    function* (request: SourceControlMediaRequest) {
      const url = URL.parse(request.url);
      const attachment = url === null ? null : azureDevOpsWorkItemAttachment(url);
      if (attachment === null) return null;
      const bytes = yield* download(attachment.organizationUrl, attachment.id);
      return HttpClientResponse.fromWeb(
        HttpClientRequest.get(attachment.fetchUrl),
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        }),
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Failed to download an Azure DevOps attachment.", cause).pipe(
        Effect.as(null),
      ),
    ),
  );
});
