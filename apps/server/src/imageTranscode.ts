// @effect-diagnostics nodeBuiltinImport:off
/**
 * Transcodes image formats the model providers cannot ingest (HEIC/HEIF) into
 * JPEG, which every provider accepts.
 *
 * iPhones capture HEIC by default, so pasting or attaching a photo straight
 * from an Apple device otherwise fails at the provider boundary even though the
 * attachment itself was stored just fine.
 *
 * Transcoding shells out to a tool that ships with the host rather than pulling
 * in a HEIC decoder dependency: `sips` on macOS (always present) and
 * `heif-convert` from libheif elsewhere (packaged on most desktop Linux). When
 * neither is available the caller surfaces the original "unsupported type"
 * failure, so this is strictly additive.
 *
 * @module imageTranscode
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const TRANSCODABLE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

export const TRANSCODED_IMAGE_MIME_TYPE = "image/jpeg";

/** Whether `mimeType` is one we can convert into a provider-supported format. */
export function isTranscodableImageMimeType(mimeType: string): boolean {
  return TRANSCODABLE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

interface Transcoder {
  readonly command: string;
  readonly args: (input: {
    readonly inputPath: string;
    readonly outputPath: string;
  }) => Array<string>;
}

const SIPS_TRANSCODER: Transcoder = {
  command: "sips",
  args: ({ inputPath, outputPath }) => ["-s", "format", "jpeg", inputPath, "--out", outputPath],
};

const HEIF_CONVERT_TRANSCODER: Transcoder = {
  command: "heif-convert",
  args: ({ inputPath, outputPath }) => [inputPath, outputPath],
};

function transcodersFor(platform: NodeJS.Platform): ReadonlyArray<Transcoder> {
  return platform === "darwin" ? [SIPS_TRANSCODER] : [HEIF_CONVERT_TRANSCODER];
}

function runTranscoder(input: {
  readonly transcoder: Transcoder;
  readonly inputPath: string;
  readonly outputPath: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      input.transcoder.command,
      input.transcoder.args({
        inputPath: input.inputPath,
        outputPath: input.outputPath,
      }),
      // A photo is a bounded workload; the cap only guards against a wedged
      // helper process holding the turn open forever.
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}

/**
 * Converts HEIC/HEIF bytes to JPEG bytes.
 *
 * Rejects when no transcoder is available on the host or the conversion fails,
 * so callers can fall back to reporting the attachment as unsupported.
 */
export async function transcodeImageToJpeg(input: {
  readonly bytes: Uint8Array;
  readonly platform: NodeJS.Platform;
}): Promise<Uint8Array> {
  const workingDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-image-transcode-"));
  const inputPath = NodePath.join(workingDir, "input");
  const outputPath = NodePath.join(workingDir, "output.jpg");

  try {
    await NodeFSP.writeFile(inputPath, input.bytes);

    let lastError: unknown = new Error("No image transcoder is available on this host.");
    for (const transcoder of transcodersFor(input.platform)) {
      try {
        await runTranscoder({ transcoder, inputPath, outputPath });
        const converted = await NodeFSP.readFile(outputPath);
        if (converted.byteLength === 0) {
          // Some builds of `sips` exit 0 after writing nothing when the input
          // is not decodable, so an empty result has to count as a failure.
          throw new Error(`${transcoder.command} produced an empty image.`);
        }
        return new Uint8Array(converted);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  } finally {
    await NodeFSP.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
}
