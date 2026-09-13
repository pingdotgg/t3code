/**
 * Extra files packed next to a Fly/Hetzner/Railway program (Docker
 * context or unit zip).
 *
 * `dest: "."` means "this directory IS the image/unit root" (`COPY . /app`),
 * not a subfolder. {@link contextRootOf} then treats that source as the
 * context, and {@link posixRelUnder} places `main` relative to it so
 * `isExternal` ENTRYPOINT is `node /app/serve-node.mjs` instead of
 * bundling `index.mjs`. Hashing skips gitignore (a parent `dist` rule
 * would empty the hash) but still excludes `node_modules` / `.git` /
 * `.next/cache` / `.alchemy` so the glob stays bounded.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory } from "../Command/Memo.ts";
import { initialCwd } from "./Node.ts";
import { sha256 } from "./sha256.ts";

const ioConcurrency = 16;

/** Extra-file dest that means "merge this directory into the image/unit root". */
export const CONTEXT_ROOT_DEST = ".";

export const isContextRootDest = (dest: string): boolean =>
  dest === "." || dest === "";

/**
 * Hash extra-file trees without gitignore (a parent `dist` rule would
 * empty the hash) but skip the directories that make a recursive glob
 * unbounded.
 */
export const EXTRA_FILES_HASH_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/cache/**",
  "**/.alchemy/**",
];

/**
 * Extra file or directory copied next to a bundled program (Docker
 * context, unit archive, …). `dest` is relative to the image/unit root.
 */
export interface ExtraFile {
  /** Local file or directory (absolute, or relative to {@link initialCwd}). */
  readonly source: string;
  /**
   * Destination relative to the image/unit root (e.g. `"dist"`, `".next"`).
   * `"."` means merge into the root.
   */
  readonly dest: string;
}

const posix = (value: string): string => value.replaceAll("\\", "/");

/**
 * Path of `file` relative to `root`, POSIX. Empty string if they are the
 * same directory. Returns `undefined` when `file` is not under `root`.
 */
export const posixRelUnder = (
  root: string,
  file: string,
  path: {
    readonly resolve: (...segments: string[]) => string;
    readonly relative: (from: string, to: string) => string;
    readonly isAbsolute: (value: string) => boolean;
  },
): string | undefined => {
  const from = posix(path.resolve(root));
  const to = posix(path.resolve(file));
  const rel = posix(path.relative(from, to));
  if (rel === "") return "";
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    return undefined;
  }
  return rel;
};

/**
 * Docker/zip context root for an unbundled (`isExternal`) program. If
 * some extraFile is `dest: "."`, that source is the context; otherwise
 * the context is `dirname(main)`.
 */
export const contextRootOf = (
  main: string,
  extraFiles: ReadonlyArray<{ source: string; dest: string }>,
  path: Path.Path,
  resolveSource: (source: string) => string,
): string => {
  const root = extraFiles.find((file) => isContextRootDest(file.dest));
  return root !== undefined ? resolveSource(root.source) : path.dirname(main);
};

/** Normalize a COPY destination so it cannot escape the root. `"."` is the root. */
export const extraFileDestination = (destination: string): string => {
  const normalized = destination.replaceAll("\\", "/").replace(/^\/+/, "");
  if (isContextRootDest(normalized)) return CONTEXT_ROOT_DEST;
  const parts = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  return parts.length === 0 ? "dist" : parts.join("/");
};

export const resolveExtraSource = (
  source: string,
  path: {
    readonly isAbsolute: (value: string) => boolean;
    readonly resolve: (...segments: string[]) => string;
  },
) => (path.isAbsolute(source) ? source : path.resolve(initialCwd, source));

const skipCopySegment = (segment: string) =>
  segment === ".git" || segment === ".alchemy";

export const hashExtraFiles = Effect.fn(function* (
  extraFiles: ReadonlyArray<ExtraFile> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* Effect.all(
    (extraFiles ?? []).map((extra) =>
      Effect.gen(function* () {
        const dest = extraFileDestination(extra.dest);
        const source = resolveExtraSource(extra.source, path);
        const exists = yield* fs
          .exists(source)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [dest, ""] as const;
        const stat = yield* fs.stat(source);
        const hash =
          stat.type === "Directory"
            ? yield* hashDirectory({
                cwd: source,
                memo: {
                  exclude: EXTRA_FILES_HASH_EXCLUDE,
                  lockfile: false,
                },
              }).pipe(Effect.orElseSucceed(() => ""))
            : yield* sha256(yield* fs.readFile(source));
        return [dest, hash] as const;
      }),
    ),
    { concurrency: ioConcurrency },
  );
  return Object.fromEntries(entries) as Record<string, string>;
});

/**
 * Copy a file or directory without macOS `clonefile`. Nitro/Nuxt
 * `.output/server` trees (and their nested `node_modules`) fail
 * `fs.copy` with `EINVAL: invalid argument, clonefile`. Nested
 * `node_modules` are copied — nitro's node preset emits runtime
 * deps there (`solid-js`, `seroval`, …) and the host imports them.
 */
export const copyTree = Effect.fn(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs
    .stat(from)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (stat === undefined) return;
  if (stat.type !== "Directory") {
    if (stat.type !== "File") return;
    yield* fs.makeDirectory(path.dirname(to), { recursive: true });
    const contents = yield* fs.readFile(from);
    yield* fs.writeFile(to, contents);
    return;
  }
  yield* fs.makeDirectory(to, { recursive: true });
  const names = yield* fs.readDirectory(from, { recursive: true });
  yield* Effect.all(
    names.flatMap((name) => {
      if (name.split(/[\\/]/).some(skipCopySegment)) return [];
      return [
        Effect.gen(function* () {
          const src = path.join(from, name);
          const item = yield* fs
            .stat(src)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (item === undefined || item.type !== "File") return;
          const dst = path.join(to, name);
          yield* fs.makeDirectory(path.dirname(dst), { recursive: true });
          const contents = yield* fs.readFile(src);
          yield* fs.writeFile(dst, contents);
        }),
      ];
    }),
    { concurrency: ioConcurrency },
  );
});

export const copyExtraFiles = Effect.fn(function* (
  contextDir: string,
  extraFiles: ReadonlyArray<ExtraFile> | undefined,
  options?: {
    readonly onMissing?: (file: {
      readonly source: string;
      readonly dest: string;
    }) => Effect.Effect<unknown, any>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.all(
    (extraFiles ?? []).map((extra) =>
      Effect.gen(function* () {
        const source = resolveExtraSource(extra.source, path);
        const destName = extraFileDestination(extra.dest);
        const exists = yield* fs
          .exists(source)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          if (options?.onMissing !== undefined) {
            yield* options.onMissing({ source, dest: destName });
          }
          return;
        }
        if (isContextRootDest(destName)) {
          const stat = yield* fs.stat(source);
          if (stat.type === "Directory") {
            const names = yield* fs.readDirectory(source);
            yield* Effect.all(
              names.map((name) =>
                copyTree(path.join(source, name), path.join(contextDir, name)),
              ),
              { concurrency: ioConcurrency },
            );
          } else {
            yield* copyTree(
              source,
              path.join(contextDir, path.basename(source)),
            );
          }
          return;
        }
        const dest = path.join(contextDir, destName);
        if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) {
          yield* fs.remove(dest, { recursive: true });
        }
        yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
        yield* copyTree(source, dest);
      }),
    ),
    { concurrency: ioConcurrency },
  );
});
