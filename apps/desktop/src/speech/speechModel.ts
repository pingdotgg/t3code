// @effect-diagnostics nodeBuiltinImport:off globalDate:off - low-level streaming download boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

export const SPEECH_MODEL = {
  id: "moonshine-streaming-tiny",
  name: "Moonshine Streaming Tiny",
  filename: "moonshine-streaming-tiny-Q8_0.gguf",
  size: 50_462_816,
  sha256: "930e4622ad3a24158b91406c30c977fa6a26b34cb32d6ac3e57cfb23383a869e",
  revision: "85ddff612fa3a2cf40b2f745abcfa90ef82f293b",
  url: "https://huggingface.co/handy-computer/moonshine-streaming-tiny-gguf/resolve/85ddff612fa3a2cf40b2f745abcfa90ef82f293b/moonshine-streaming-tiny-Q8_0.gguf",
} as const;

type DownloadInput = {
  directory: string;
  filename: string;
  url: string;
  size: number;
  sha256: string;
  request: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{
    status: number;
    headers: Readonly<Record<string, string | undefined>>;
    body: AsyncIterable<Uint8Array>;
  }>;
  signal?: AbortSignal;
  onProgress?: (downloaded: number, total: number) => void;
};

async function hasExpectedSize(path: string, size: number): Promise<boolean> {
  return NodeFSP.stat(path).then(
    (value) => value.size === size,
    () => false,
  );
}

async function hasExpectedDigest(path: string, size: number, sha256: string): Promise<boolean> {
  if (!(await hasExpectedSize(path, size))) return false;
  const digest = NodeCrypto.createHash("sha256");
  try {
    for await (const chunk of NodeFS.createReadStream(path)) digest.update(chunk);
    return digest.digest("hex") === sha256;
  } catch {
    return false;
  }
}

export async function downloadVerifiedModel(input: DownloadInput): Promise<string> {
  const { directory, filename, url, size, sha256, request, signal, onProgress } = input;
  const finalPath = NodePath.join(directory, filename);
  signal?.throwIfAborted();
  await NodeFSP.mkdir(directory, { recursive: true });
  if (await hasExpectedDigest(finalPath, size, sha256)) {
    onProgress?.(size, size);
    return finalPath;
  }

  const partialPath = `${finalPath}.${process.pid}.${NodeCrypto.randomUUID()}.part`;
  const response = await request(url, signal);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`speech model download failed with status ${response.status}`);
  }
  const contentLengthHeader = response.headers["content-length"];
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength !== size) {
    throw new Error(`speech model download size mismatch: expected ${size}, got ${contentLength}`);
  }

  const digest = NodeCrypto.createHash("sha256");
  let downloaded = 0;
  let lastReport = 0;
  const progress = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      if (downloaded > size) {
        callback(new Error("speech model download exceeded expected size"));
        return;
      }
      digest.update(chunk);
      const now = Date.now();
      if (now - lastReport >= 100 || downloaded === size) {
        lastReport = now;
        onProgress?.(downloaded, size);
      }
      callback(null, chunk);
    },
  });

  onProgress?.(0, size);
  try {
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.from(response.body),
      progress,
      NodeFS.createWriteStream(partialPath, { mode: 0o600 }),
      { signal },
    );
    signal?.throwIfAborted();
    const partialSize = (await NodeFSP.stat(partialPath)).size;
    const actualSha256 = digest.digest("hex");
    if (partialSize !== size || actualSha256 !== sha256) {
      throw new Error("speech model verification failed; partial bytes were removed");
    }
    await NodeFSP.rm(finalPath, { force: true });
    await NodeFSP.rename(partialPath, finalPath);
    onProgress?.(size, size);
    return finalPath;
  } catch (error) {
    await NodeFSP.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeSpeechModel(directory: string): Promise<void> {
  await NodeFSP.rm(NodePath.join(directory, SPEECH_MODEL.filename), { force: true });
}

export function speechModelPath(directory: string): string {
  return NodePath.join(directory, SPEECH_MODEL.filename);
}

export async function isSpeechModelReady(directory: string): Promise<boolean> {
  return hasExpectedDigest(speechModelPath(directory), SPEECH_MODEL.size, SPEECH_MODEL.sha256);
}
