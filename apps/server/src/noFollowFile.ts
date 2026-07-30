// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import type * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Node does not expose Darwin's all-components no-follow flag.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

function errnoCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
}

async function openLinuxPath(
  absolutePath: string,
  flags: number,
  mode?: number,
): Promise<NodeFSP.FileHandle> {
  const segments = absolutePath.split(NodePath.sep).filter(Boolean);
  const fileName = segments.pop();
  if (!fileName || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Cannot safely open non-canonical path: ${absolutePath}`);
  }

  let directory = await NodeFS.promises.open(
    NodePath.sep,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY,
  );
  try {
    for (const segment of segments) {
      const nextDirectory = await NodeFS.promises.open(
        `/proc/self/fd/${directory.fd}/${segment}`,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = nextDirectory;
    }

    return await NodeFS.promises.open(
      `/proc/self/fd/${directory.fd}/${fileName}`,
      flags | NodeFS.constants.O_NOFOLLOW,
      mode,
    );
  } finally {
    await directory.close();
  }
}

async function verifyFallbackHandle(
  absolutePath: string,
  handle: NodeFSP.FileHandle,
): Promise<NodeFSP.FileHandle> {
  try {
    const handleInfo = await handle.stat();
    const canonicalPath = await NodeFS.promises.realpath(absolutePath);
    const pathInfo = await NodeFS.promises.stat(absolutePath);
    if (
      !canonicalPathsMatch(absolutePath, canonicalPath) ||
      pathInfo.dev !== handleInfo.dev ||
      pathInfo.ino !== handleInfo.ino
    ) {
      throw new Error(`Path changed while it was being opened: ${absolutePath}`);
    }
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

export function canonicalPathsMatch(absolutePath: string, canonicalPath: string): boolean {
  return canonicalPath === absolutePath;
}

async function openPathNoFollow(
  absolutePath: string,
  flags: number,
  platform: NodeJS.Platform,
  mode?: number,
): Promise<NodeFSP.FileHandle> {
  if (!NodePath.isAbsolute(absolutePath) || NodePath.resolve(absolutePath) !== absolutePath) {
    throw new Error(`Cannot safely open non-canonical path: ${absolutePath}`);
  }

  const nonBlockingFlags = flags | NodeFS.constants.O_NONBLOCK;
  if (platform === "darwin") {
    return NodeFS.promises.open(absolutePath, nonBlockingFlags | DARWIN_O_NOFOLLOW_ANY, mode);
  }
  if (platform === "linux") {
    return openLinuxPath(absolutePath, nonBlockingFlags, mode);
  }

  const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0;
  const handle = await NodeFS.promises.open(absolutePath, nonBlockingFlags | noFollow, mode);
  return verifyFallbackHandle(absolutePath, handle);
}

export async function openReadableFileNoFollow(
  absolutePath: string,
  platform: NodeJS.Platform,
): Promise<{
  readonly stream: NodeFS.ReadStream;
  readonly size: number;
}> {
  const handle = await openPathNoFollow(absolutePath, NodeFS.constants.O_RDONLY, platform);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Expected a regular file: ${absolutePath}`);
    }
    return {
      stream: handle.createReadStream({ autoClose: true }),
      size: info.size,
    };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

export async function openWritableFileNoFollow(
  absolutePath: string,
  platform: NodeJS.Platform,
): Promise<NodeFSP.FileHandle> {
  try {
    return await openPathNoFollow(absolutePath, NodeFS.constants.O_WRONLY, platform);
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT") {
      throw cause;
    }
    return openPathNoFollow(
      absolutePath,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
      platform,
      0o666,
    );
  }
}
