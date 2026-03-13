import { runProcess } from "./processRunner";

const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];
  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }
  return parts.filter((value) => value.length > 0);
}

export async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const insideWorkTree = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowNonZeroExit: true,
    timeoutMs: 5_000,
    maxBufferBytes: 4_096,
  }).catch(() => null);

  return Boolean(
    insideWorkTree && insideWorkTree.code === 0 && insideWorkTree.stdout.trim() === "true",
  );
}

export async function filterGitIgnoredPaths(
  cwd: string,
  relativePaths: readonly string[],
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return [...relativePaths];
  }

  const ignoredPaths = new Set<string>();
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async (): Promise<boolean> => {
    if (chunk.length === 0) {
      return true;
    }

    const checkIgnore = await runProcess("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
      stdin: `${chunk.join("\0")}\0`,
    }).catch(() => null);
    chunk = [];
    chunkBytes = 0;

    if (!checkIgnore) {
      return false;
    }

    // git-check-ignore exits with 1 when no paths match.
    if (checkIgnore.code !== 0 && checkIgnore.code !== 1) {
      return false;
    }

    const matchedIgnoredPaths = splitNullSeparatedPaths(
      checkIgnore.stdout,
      Boolean(checkIgnore.stdoutTruncated),
    );
    for (const ignoredPath of matchedIgnoredPaths) {
      ignoredPaths.add(ignoredPath);
    }
    return true;
  };

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (
      chunk.length > 0 &&
      chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES &&
      !(await flushChunk())
    ) {
      return [...relativePaths];
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES && !(await flushChunk())) {
      return [...relativePaths];
    }
  }

  if (!(await flushChunk())) {
    return [...relativePaths];
  }

  if (ignoredPaths.size === 0) {
    return [...relativePaths];
  }

  return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
}
