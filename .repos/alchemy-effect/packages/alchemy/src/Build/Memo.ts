import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import fg from "fast-glob";
import { gitignoreRulesToGlobs } from "../Util/gitignore-rules-to-globs.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";

/**
 * Controls which files are included in the content hash that determines
 * whether a build needs to re-run.
 *
 * By default (no options), every non-gitignored file in the working directory
 * is hashed, plus the nearest package-manager lockfile. Provide explicit
 * `include`/`exclude` globs to narrow the scope when the default is too broad.
 */
export interface MemoOptions {
  /**
   * Glob patterns of files to hash. Paths are relative to the working directory.
   *
   * @default ["**\/*"] (all files, filtered by `exclude`)
   * @example ["src/**", "package.json", "tsconfig.json"]
   */
  include?: string[];
  /**
   * Glob patterns to exclude from hashing. Paths are relative to the working directory.
   *
   * @default gitignore rules collected from the working directory up to the repo root
   */
  exclude?: string[];
  /**
   * Whether to include the nearest package-manager lockfile (`bun.lock`,
   * `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`) in the hash,
   * even when it lives above the working directory (e.g. monorepo root).
   *
   * @default true when both `include` and `exclude` are unset; false otherwise
   */
  lockfile?: boolean;
}

interface ResolvedMemoOptions {
  cwd: string;
  include: string[];
  exclude: string[];
  lockfile: boolean;
}

/**
 * Internal service that resolves memo options, lists matching files, and
 * produces a single SHA-256 content hash. Constructed as an Effect so it
 * can access the platform `FileSystem` and `Path` services.
 */
const Memo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findUp = Effect.fnUntraced(function* (
    cwd: string,
    filenames: string[],
  ): Effect.fn.Return<string | undefined, PlatformError> {
    const [file] = yield* Effect.filter(
      filenames.map((filename) => path.join(cwd, filename)),
      fs.exists,
      { concurrency: "unbounded" },
    );
    if (file) {
      return file;
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) {
      return undefined;
    }
    return yield* findUp(parent, filenames);
  });

  const readGitIgnoreRules = Effect.fnUntraced(function* (
    cwd: string,
  ): Effect.fn.Return<string[], PlatformError> {
    const rules = yield* fs.readFileString(path.join(cwd, ".gitignore")).pipe(
      Effect.map((file) => file.split("\n")),
      Effect.catchIf(
        (error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    const parent = path.dirname(cwd);
    if (parent === cwd || (yield* fs.exists(path.join(cwd, ".git")))) {
      return rules;
    }
    return [...(yield* readGitIgnoreRules(parent)), ...rules];
  });

  const resolveMemoOptions = Effect.fnUntraced(function* (
    cwd: string | undefined,
    options: MemoOptions,
  ): Effect.fn.Return<ResolvedMemoOptions, PlatformError> {
    const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
    return {
      cwd: resolvedCwd,
      include: options.include ?? ["**/*"],
      exclude:
        options.exclude ??
        (yield* readGitIgnoreRules(resolvedCwd).pipe(
          Effect.map(gitignoreRulesToGlobs),
          Effect.map((globs) => ["**/.git/**", ...globs]),
        )),
      lockfile: options.lockfile ?? !(options.exclude || options.include),
    };
  });

  const listFiles = Effect.fnUntraced(function* (
    options: ResolvedMemoOptions,
  ): Effect.fn.Return<string[], PlatformError> {
    const [files, lockfile] = yield* Effect.all(
      [
        Effect.promise(() =>
          fg.glob(options.include, {
            cwd: options.cwd,
            ignore: options.exclude,
            onlyFiles: true,
            dot: true,
          }),
        ),
        options.lockfile
          ? findUp(options.cwd, [
              "bun.lock",
              "bun.lockb",
              "package-lock.json",
              "pnpm-lock.yaml",
              "yarn.lock",
            ]).pipe(
              Effect.map((lockfile) =>
                lockfile ? path.relative(options.cwd, lockfile) : undefined,
              ),
            )
          : Effect.succeed(undefined),
      ],
      { concurrency: "unbounded" },
    );
    if (lockfile && !files.includes(lockfile)) {
      files.push(lockfile);
    }
    return files.sort();
  });

  const hashFiles = Effect.fnUntraced(function* (
    cwd: string,
    files: string[],
  ): Effect.fn.Return<string, PlatformError> {
    const hashes = yield* Effect.forEach(
      files,
      (file) =>
        fs.readFile(path.join(cwd, file)).pipe(
          Effect.flatMap(sha256),
          Effect.map((hash) => `${file}:${hash}`),
        ),
      { concurrency: "unbounded" },
    );
    return yield* sha256Object(hashes);
  });

  return {
    resolveMemoOptions,
    listFiles,
    hashFiles,
  };
});

/**
 * Produces a deterministic SHA-256 hash of all files matched by the given
 * memo options. The hash changes if and only if the content of the matched
 * files changes, making it suitable for cache-busting build outputs.
 */
export const hashDirectory = Effect.fn(function* (props: {
  cwd?: string;
  memo?: MemoOptions;
}): Effect.fn.Return<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  const service = yield* Memo;
  const resolvedOptions = yield* service.resolveMemoOptions(
    props.cwd,
    props.memo ?? {},
  );
  const files = yield* service.listFiles(resolvedOptions);
  const hash = yield* service.hashFiles(resolvedOptions.cwd, files);
  return hash;
});
