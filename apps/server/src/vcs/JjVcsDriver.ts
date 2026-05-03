import { Context, Effect, FileSystem, Layer, Option } from "effect";

import { VcsOutputDecodeError, VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import { VcsDriver, type VcsDriverShape } from "./VcsDriver.ts";
import { nowFreshness } from "./VcsFreshness.ts";
import { VcsProcess, type VcsProcessShape } from "./VcsProcess.ts";

export interface JjVcsDriverShape extends VcsDriverShape {
  readonly capabilities: VcsDriverShape["capabilities"] & {
    readonly kind: "jj";
    readonly supportsBookmarks: true;
    readonly supportsAtomicSnapshot: true;
    readonly supportsWorktrees: false;
    readonly ignoreClassifier: "git-compatible-fallback";
  };
  readonly currentChange: (cwd: string) => Effect.Effect<JjCurrentChange | null, VcsError>;
  readonly listBookmarks: (cwd: string) => Effect.Effect<ReadonlyArray<JjBookmark>, VcsError>;
  readonly listWorkspaces: (cwd: string) => Effect.Effect<ReadonlyArray<JjWorkspace>, VcsError>;
}

export interface JjCurrentChange {
  readonly changeId: string;
  readonly commitId: string | null;
  readonly description: string | null;
}

export interface JjBookmark {
  readonly name: string;
  readonly target: string | null;
}

export interface JjWorkspace {
  readonly name: string;
  readonly path: string | null;
}

export class JjVcsDriver extends Context.Service<JjVcsDriver, JjVcsDriverShape>()(
  "t3/vcs/JjVcsDriver",
) {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function splitLineSeparatedPaths(input: string, truncated: boolean): string[] {
  const lines = input.split(/\r?\n/g);
  if (truncated && lines[lines.length - 1]?.length) {
    lines.pop();
  }

  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseJjRemoteList(output: string): Array<{ name: string; url: string }> {
  return output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) {
        return [];
      }

      const [name, ...urlParts] = line.split(/\s+/g);
      const url = urlParts.join(" ").trim();
      return name && url ? [{ name, url }] : [];
    });
}

function parseNullRecord(record: string): string[] {
  return record.split("\0").map((value) => value.trim());
}

function decodeJjCurrentChange(raw: string, cwd: string): JjCurrentChange | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const [changeId, commitId, description] = parseNullRecord(trimmed);
  if (!changeId) {
    throw new VcsOutputDecodeError({
      operation: "JjVcsDriver.currentChange",
      command: "jj log",
      cwd,
      detail: "jj current change output did not include a change id",
    });
  }

  return {
    changeId,
    commitId: commitId || null,
    description: description || null,
  };
}

function decodeJjBookmarkList(raw: string): ReadonlyArray<JjBookmark> {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, target] = parseNullRecord(line);
      return {
        name: name ?? line,
        target: target || null,
      };
    });
}

function decodeJjWorkspaceList(raw: string): ReadonlyArray<JjWorkspace> {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, path] = parseNullRecord(line);
      return {
        name: name ?? line,
        path: path || null,
      };
    });
}

function chunkPathsForCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

const processCommand = (
  process: VcsProcessShape,
  command: string,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly truncateOutputAtMaxBytes?: boolean;
  },
) =>
  process.run({
    operation,
    command,
    args,
    cwd,
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.truncateOutputAtMaxBytes !== undefined
      ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
      : {}),
  });

const jjCommand = (
  process: VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly truncateOutputAtMaxBytes?: boolean;
  },
) => processCommand(process, "jj", operation, cwd, ["--no-pager", ...args], options);

const gitCommand = (
  process: VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: Parameters<typeof processCommand>[5],
) => processCommand(process, "git", operation, cwd, args, options);

function fileSystemError(operation: string, cwd: string, detail: string, cause: unknown) {
  return new VcsOutputDecodeError({
    operation,
    command: "git check-ignore",
    cwd,
    detail,
    cause,
  });
}

const makeScopedTempGitDir = (fileSystem: FileSystem.FileSystem, operation: string, cwd: string) =>
  fileSystem
    .makeTempDirectoryScoped({ prefix: "t3-jj-check-ignore-" })
    .pipe(
      Effect.mapError((cause) =>
        fileSystemError(operation, cwd, "failed to create temp git dir", cause),
      ),
    );

export const makeVcsDriverShape = Effect.fn("makeJjVcsDriverShape")(function* () {
  const process = yield* VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: false as const,
    supportsBookmarks: true as const,
    supportsAtomicSnapshot: true as const,
    supportsPushDefaultRemote: false as const,
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const isInsideWorkTree: VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    jjCommand(process, "JjVcsDriver.isInsideWorkTree", cwd, ["root"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(
      Effect.map((result) => result.exitCode === 0 && result.stdout.trim().length > 0),
      Effect.catch(() => Effect.succeed(false)),
    );

  const execute: VcsDriverShape["execute"] = (input) =>
    jjCommand(process, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
        : {}),
    });

  const initRepository: VcsDriverShape["initRepository"] = (input) =>
    jjCommand(process, "JjVcsDriver.initRepository", input.cwd, ["git", "init"]);

  const detectRepository: VcsDriverShape["detectRepository"] = Effect.fn("detectRepository")(
    function* (cwd) {
      const root = yield* jjCommand(process, "JjVcsDriver.detectRepository.root", cwd, ["root"], {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!root || root.exitCode !== 0) {
        return null;
      }

      const rootPath = root.stdout.trim();
      if (rootPath.length === 0) {
        return null;
      }

      return {
        kind: "jj" as const,
        rootPath,
        metadataPath: `${rootPath.replace(/[\\/]$/g, "")}/.jj`,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const listWorkspaceFiles: VcsDriverShape["listWorkspaceFiles"] = (cwd) =>
    jjCommand(process, "JjVcsDriver.listWorkspaceFiles", cwd, ["file", "list"], {
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      truncateOutputAtMaxBytes: true,
    }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              return {
                paths: splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness: yield* nowFreshness(),
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "JjVcsDriver.listWorkspaceFiles",
                command: "jj file list",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "jj file list failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriverShape["listRemotes"] = Effect.fn("listRemotes")(function* (cwd) {
    const result = yield* jjCommand(
      process,
      "JjVcsDriver.listRemotes",
      cwd,
      ["git", "remote", "list"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      },
    );

    if (result.exitCode !== 0) {
      return {
        remotes: [],
        freshness: yield* nowFreshness(),
      };
    }

    return {
      remotes: parseJjRemoteList(result.stdout).map((remote) => ({
        name: remote.name,
        url: remote.url,
        pushUrl: Option.none(),
        isPrimary: remote.name === "origin",
      })),
      freshness: yield* nowFreshness(),
    };
  });

  const currentChange: JjVcsDriverShape["currentChange"] = (cwd) =>
    jjCommand(
      process,
      "JjVcsDriver.currentChange",
      cwd,
      [
        "log",
        "-r",
        "@",
        "--no-graph",
        "--template",
        'change_id ++ "\\0" ++ commit_id ++ "\\0" ++ description.first_line()',
      ],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      },
    ).pipe(Effect.map((result) => decodeJjCurrentChange(result.stdout, cwd)));

  const listBookmarks: JjVcsDriverShape["listBookmarks"] = (cwd) =>
    jjCommand(
      process,
      "JjVcsDriver.listBookmarks",
      cwd,
      ["bookmark", "list", "--template", 'name ++ "\\0" ++ target.commit_id() ++ "\\n"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024,
      },
    ).pipe(
      Effect.map((result) => (result.exitCode === 0 ? decodeJjBookmarkList(result.stdout) : [])),
    );

  const listWorkspaces: JjVcsDriverShape["listWorkspaces"] = (cwd) =>
    jjCommand(
      process,
      "JjVcsDriver.listWorkspaces",
      cwd,
      ["workspace", "list", "--template", 'name ++ "\\0" ++ root ++ "\\n"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024,
      },
    ).pipe(
      Effect.map((result) => (result.exitCode === 0 ? decodeJjWorkspaceList(result.stdout) : [])),
    );

  const filterIgnoredPaths: VcsDriverShape["filterIgnoredPaths"] = Effect.fn("filterIgnoredPaths")(
    function* (cwd, relativePaths) {
      if (relativePaths.length === 0) {
        return relativePaths;
      }

      const operation = "JjVcsDriver.filterIgnoredPaths";
      const ignoredPaths = new Set<string>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const gitDir = yield* makeScopedTempGitDir(fileSystem, operation, cwd);
          const initResult = yield* gitCommand(
            process,
            operation,
            cwd,
            ["--git-dir", gitDir, "init", "--bare"],
            {
              allowNonZeroExit: true,
            },
          );
          if (initResult.exitCode !== 0) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git init --bare",
              cwd,
              exitCode: initResult.exitCode,
              detail: initResult.stderr.trim() || "git init --bare failed",
            });
          }

          for (const chunk of chunkPathsForCheckIgnore(relativePaths)) {
            const result = yield* gitCommand(
              process,
              operation,
              cwd,
              [
                "--git-dir",
                gitDir,
                "--work-tree",
                cwd,
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
              ],
              {
                stdin: `${chunk.join("\0")}\0`,
                allowNonZeroExit: true,
                timeoutMs: 20_000,
                maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                truncateOutputAtMaxBytes: true,
              },
            );

            if (result.exitCode !== 0 && result.exitCode !== 1) {
              return yield* new VcsProcessExitError({
                operation,
                command: "git check-ignore",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git check-ignore failed",
              });
            }

            for (const ignoredPath of splitNullSeparatedPaths(
              result.stdout,
              result.stdoutTruncated,
            )) {
              ignoredPaths.add(ignoredPath);
            }
          }
        }),
      );

      if (ignoredPaths.size === 0) {
        return relativePaths;
      }

      return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
    },
  );

  return {
    capabilities,
    execute,
    initRepository,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    currentChange,
    listBookmarks,
    listWorkspaces,
  } satisfies JjVcsDriverShape;
});

export const makeJjVcsDriver = Effect.fn("makeJjVcsDriver")(function* () {
  const driver = yield* makeVcsDriverShape();
  return JjVcsDriver.of(driver);
});

export const makeVcsDriver = Effect.fn("makeJjGenericVcsDriver")(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.of(driver);
});

export const layer = Layer.effect(JjVcsDriver, makeJjVcsDriver());
export const vcsLayer = Layer.effect(VcsDriver, makeVcsDriver());
