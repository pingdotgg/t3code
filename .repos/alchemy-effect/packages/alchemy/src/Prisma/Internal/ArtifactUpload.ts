import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { artifactFileStream, type ArtifactFile } from "./ArtifactFile.ts";
import { PrismaUploadClient } from "./HttpClient.ts";

const ARTIFACT_UPLOAD_TIMEOUT = Duration.minutes(5);
const UPLOAD_ERROR_BODY_BYTES = 64 * 1024;

export const executeArtifactUpload = (
  uploadUrl: string,
  artifact: Uint8Array | ArtifactFile,
  contentType: string,
) =>
  Effect.gen(function* () {
    // Prefer the Prisma-scoped upload client (node transport, provided by
    // live wiring — presigned upload URLs need explicit Content-Length on
    // file-backed bodies); fall back to the ambient client so tests can
    // stub uploads through `HttpClient.HttpClient`.
    const uploadClient = yield* Effect.serviceOption(PrismaUploadClient);
    const http = Option.isSome(uploadClient)
      ? uploadClient.value
      : yield* HttpClient.HttpClient;
    const request = HttpClientRequest.put(uploadUrl).pipe(
      artifact instanceof Uint8Array
        ? HttpClientRequest.bodyUint8Array(artifact, contentType)
        : HttpClientRequest.bodyStream(artifactFileStream(artifact), {
            contentType,
            contentLength: artifact.size,
          }),
    );
    const responseOption = yield* http.execute(request).pipe(
      Effect.mapError(
        () =>
          new Error(
            "Prisma artifact upload transport failed before a response was received.",
          ),
      ),
      Effect.timeoutOption(ARTIFACT_UPLOAD_TIMEOUT),
    );
    if (Option.isNone(responseOption)) {
      return yield* Effect.fail(
        new Error("Prisma artifact upload timed out after 5 minutes."),
      );
    }
    const response = responseOption.value;
    if (response.status < 200 || response.status >= 300) {
      const bodyBytesOption = yield* readResponsePrefixByteCount(
        response,
        UPLOAD_ERROR_BODY_BYTES,
      ).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
        Effect.catch(() => Effect.succeed(Option.none<number>())),
      );
      const diagnostic = Option.match(bodyBytesOption, {
        onNone: () => "diagnostic body unavailable",
        onSome: (bytes) => `diagnostic body prefix: ${bytes} bytes`,
      });
      return yield* Effect.fail(
        new Error(
          `Prisma artifact upload failed (HTTP ${response.status}; ${diagnostic}).`,
        ),
      );
    }
  });

const readResponsePrefixByteCount = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) =>
  Effect.gen(function* () {
    let bytes = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        const remaining = limit - bytes;
        if (remaining <= 0) return false;
        bytes += Math.min(chunk.byteLength, remaining);
        return bytes < limit;
      }),
    );
    return bytes;
  });
