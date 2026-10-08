import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as GitCafeCredentials from "../sourceControl/GitCafeCredentials.ts";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = "30 seconds";

class AttachmentDownloadLimitError extends Schema.TaggedError<AttachmentDownloadLimitError>()(
  "AttachmentDownloadLimitError",
  {},
) {}

const collectBounded = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (state, chunk) => {
        if (state.bytes + chunk.byteLength > maxBytes)
          return Effect.fail(new AttachmentDownloadLimitError({}));
        state.chunks.push(chunk);
        state.bytes += chunk.byteLength;
        return Effect.succeed(state);
      },
    ),
    Effect.map(({ chunks, bytes }) => new Uint8Array(Buffer.concat(chunks, bytes))),
  );

/** A private attachment's bytes, fetched with the server's GitCafe credential; null if refused. */
export const downloadGitCafeAttachment = Effect.fn("GitCafeAttachment.download")(
  function* (host: "git.cafe" | "staging.git.cafe", attachmentId: string) {
    const credentials = yield* GitCafeCredentials.GitCafeCredentials;
    const httpClient = yield* HttpClient.HttpClient;
    const { token } = yield* credentials.get(host);
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(
          `https://${host}/api/attachments/${encodeURIComponent(attachmentId)}`,
        ).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeader("user-agent", "t3code"),
        ),
      )
      .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
    if (response.status === 401) yield* credentials.invalidate(host);
    if (response.status < 200 || response.status >= 300) return null;
    return yield* collectBounded(response.stream, MAX_ATTACHMENT_BYTES);
  },
  Effect.timeout(DOWNLOAD_TIMEOUT),
  Effect.orElseSucceed(() => null),
);

export function sniffRasterImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("ascii");
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a"))
    return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
