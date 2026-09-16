import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
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

export const downloadGitCafeAttachment = Effect.fn("GitCafeAttachment.download")(
  function* (host: "git.cafe" | "staging.git.cafe", attachmentId: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "cafe",
        [
          "--host",
          `https://${host}/api`,
          "--no-input",
          "--no-update-check",
          "api",
          `/attachments/${attachmentId}`,
        ],
        { stdin: "ignore" },
      ),
    );
    const [bytes, , exitCode] = yield* Effect.all(
      [
        collectBounded(child.stdout, MAX_ATTACHMENT_BYTES),
        collectBounded(child.stderr, MAX_STDERR_BYTES),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) return null;
    return bytes;
  },
  Effect.scoped,
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
