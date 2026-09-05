// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - streams downloads with global fetch and Node filesystem, stream, and hashing APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

export const SPEECH_MODEL = {
  name: "Moonshine Streaming Tiny",
  filename: "moonshine-streaming-tiny-Q8_0.gguf",
  size: 50_462_816,
  sha256: "930e4622ad3a24158b91406c30c977fa6a26b34cb32d6ac3e57cfb23383a869e",
  url: "https://huggingface.co/handy-computer/moonshine-streaming-tiny-gguf/resolve/85ddff612fa3a2cf40b2f745abcfa90ef82f293b/moonshine-streaming-tiny-Q8_0.gguf",
} as const;

async function hasExpectedModel(path: string): Promise<boolean> {
  const stat = await NodeFSP.stat(path).catch(() => null);
  if (stat?.size !== SPEECH_MODEL.size) return false;
  const digest = NodeCrypto.createHash("sha256");
  try {
    for await (const chunk of NodeFS.createReadStream(path)) digest.update(chunk);
    return digest.digest("hex") === SPEECH_MODEL.sha256;
  } catch {
    return false;
  }
}

export function speechModelPath(directory: string): string {
  return NodePath.join(directory, SPEECH_MODEL.filename);
}

export function isSpeechModelReady(directory: string): Promise<boolean> {
  return hasExpectedModel(speechModelPath(directory));
}

export async function downloadSpeechModel(
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const finalPath = speechModelPath(directory);
  signal?.throwIfAborted();
  await NodeFSP.mkdir(directory, { recursive: true });
  if (await hasExpectedModel(finalPath)) return finalPath;

  const partialPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
  try {
    const response = await fetch(SPEECH_MODEL.url, signal ? { signal } : undefined);
    if (!response.ok || !response.body) {
      throw new Error(`speech model download failed with status ${response.status}`);
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (
      contentLength !== null &&
      Number.isFinite(contentLength) &&
      contentLength !== SPEECH_MODEL.size
    ) {
      throw new Error(
        `speech model download size mismatch: expected ${SPEECH_MODEL.size}, got ${contentLength}`,
      );
    }

    const digest = NodeCrypto.createHash("sha256");
    let downloaded = 0;
    const verify = new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > SPEECH_MODEL.size) {
          callback(new Error("speech model download exceeded expected size"));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      verify,
      NodeFS.createWriteStream(partialPath, { mode: 0o600 }),
      { signal },
    );
    if (downloaded !== SPEECH_MODEL.size || digest.digest("hex") !== SPEECH_MODEL.sha256) {
      throw new Error("speech model verification failed");
    }
    await NodeFSP.rm(finalPath, { force: true });
    await NodeFSP.rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await NodeFSP.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function removeSpeechModel(directory: string): Promise<void> {
  return NodeFSP.rm(speechModelPath(directory), { force: true });
}
