import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Stream from "effect/Stream";
import { HttpClientRequest, HttpClientResponse, Mime } from "effect/http";

import { azureDevOpsAttachment } from "../shared/azureDevOpsMedia.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const MEDIA_CONTENT_TYPE = /^(?:image|video|audio)\//iu;

/** The bytes of one `bytes=` range of a `size`-byte file; null serves the whole file. */
function byteRange(header: string | undefined, size: number) {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0 || (first !== null && first >= size) || (first === null && last === 0)) {
    return "unsatisfiable" as const;
  }
  const start = first ?? Math.max(0, size - last!);
  const end = first === null || last === null || last >= size ? size - 1 : last;
  return { start, end };
}

/**
 * Azure serves attachments only through `az devops invoke`, which holds the credential and writes
 * the whole file. Range requests for one video share that download until it is a minute idle.
 */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fileSystem = yield* FileSystem.FileSystem;

  const downloads = yield* RcMap.make({
    idleTimeToLive: "1 minute",
    lookup: Effect.fn("AzureDevOpsMediaFetch.download")(function* (fetchUrl: string) {
      const attachment = azureDevOpsAttachment(new URL(fetchUrl))!;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-azure-media-" });
      const file = `${directory}/attachment`;
      yield* azure.execute({
        cwd: directory,
        args: [
          "devops",
          "invoke",
          "--organization",
          attachment.organizationUrl,
          "--area",
          "git",
          "--resource",
          "pullRequestAttachments",
          "--api-version",
          "7.1",
          "--route-parameters",
          `project=${attachment.project}`,
          `repositoryId=${attachment.repositoryId}`,
          `pullRequestId=${attachment.pullRequestId}`,
          `fileName=${attachment.fileName}`,
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
      return file;
    }),
  });

  return Effect.fn("AzureDevOpsMediaFetch.fetchMedia")(
    function* (request: SourceControlMediaRequest) {
      const url = URL.parse(request.url);
      const attachment = url === null ? null : azureDevOpsAttachment(url);
      const contentType =
        attachment === null ? null : Option.getOrNull(Mime.getType(attachment.fileName));
      if (attachment === null || contentType === null || !MEDIA_CONTENT_TYPE.test(contentType)) {
        return null;
      }
      const file = yield* RcMap.get(downloads, attachment.fetchUrl).pipe(
        Effect.tapError(() => RcMap.invalidate(downloads, attachment.fetchUrl)),
      );
      const size = Number((yield* fileSystem.stat(file)).size);
      const headers: Record<string, string> = {
        "content-type": contentType,
        "accept-ranges": "bytes",
      };
      // Without a validator, an `if-range` cannot be honoured, so it gets the whole file.
      const range =
        request.headers["if-range"] === undefined ? byteRange(request.headers.range, size) : null;
      const source = HttpClientRequest.get(request.url);
      if (range === "unsatisfiable") {
        return HttpClientResponse.fromWeb(
          source,
          new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } }),
        );
      }
      const start = range?.start ?? 0;
      const length = range === null ? size : range.end - range.start + 1;
      headers["content-length"] = String(length);
      if (range !== null) headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
      const body = Stream.toReadableStream(
        fileSystem.stream(file, { offset: start, bytesToRead: length }),
      );
      return HttpClientResponse.fromWeb(
        source,
        new Response(length === 0 ? null : body, { status: range === null ? 200 : 206, headers }),
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Failed to download an Azure DevOps attachment.", cause).pipe(
        Effect.as(null),
      ),
    ),
  );
});
