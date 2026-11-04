/**
 * INTERNAL — one implementation of ignore-file filtering for every place that
 * walks a directory and skips what an ignore file excludes.
 *
 * Two dialects, because the tools they imitate disagree:
 *
 * - `gitignore` (`.gitignore`, `.assetsignore`): a pattern without a slash
 *   matches at any depth, and nothing below an excluded directory can be
 *   re-included.
 * - `dockerignore` (`.dockerignore`, `<Dockerfile>.dockerignore`): patterns
 *   are rooted at the context, and a later `!` rule can re-include a path
 *   below an excluded directory.
 *
 * {@link walkIgnoring} lists a tree one level at a time and skips directories
 * the rules prune, so an excluded `node_modules` is never read and an
 * unreadable excluded folder never fails the walk. Directory symlinks are
 * reported as links and never followed.
 */

import createGitIgnore from "@alchemy.run/node-utils/ignore";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

export type IgnoreDialect = "gitignore" | "dockerignore";

export interface IgnoreRules {
  readonly dialect: IgnoreDialect;
  /**
   * Whether a path is excluded. Paths are relative to the directory the
   * ignore file applies to and use `/` separators.
   */
  readonly ignores: (relativePath: string, isDirectory?: boolean) => boolean;
  /**
   * Whether a directory and everything below it is excluded, so a walk can
   * skip reading it. Conservative: `false` only costs a directory read.
   */
  readonly prunes: (relativeDirectory: string) => boolean;
}

/** Normalize to the `/`-separated, `./`-free form the matchers expect. */
export const normalizeRelativePath = (value: string) =>
  value.replaceAll("\\", "/").replace(/^\.\/+/, "");

const splitLines = (content: string | ReadonlyArray<string>) =>
  typeof content === "string" ? content.replace(/^﻿/, "").split(/\r?\n/) : content;

export interface ParseIgnoreRulesOptions {
  /**
   * gitignore only: the walk root's path relative to the directory the
   * ignore file sits in (e.g. `"packages/app"` for the repository root's
   * `.gitignore` when walking `packages/app`). Rules see full paths, but
   * only directories below the walk root can exclude their contents, so an
   * ignore file that excludes the walk root itself still lets it be listed.
   * @default ""
   */
  readonly prefix?: string;
}

/** Parse ignore-file content (or its lines) in the given dialect. */
export const parseIgnoreRules = (
  content: string | ReadonlyArray<string>,
  dialect: IgnoreDialect,
  options: ParseIgnoreRulesOptions = {},
): IgnoreRules =>
  dialect === "gitignore"
    ? parseGitIgnore(splitLines(content), options.prefix ?? "")
    : parseDockerIgnore(splitLines(content));

/** Rules that exclude nothing. */
export const noIgnoreRules = (dialect: IgnoreDialect): IgnoreRules => ({
  dialect,
  ignores: () => false,
  prunes: () => false,
});

// ---------------------------------------------------------------------------
// gitignore
// ---------------------------------------------------------------------------

const parseGitIgnore = (lines: ReadonlyArray<string>, prefix: string): IgnoreRules => {
  const matcher = createGitIgnore().add(lines);
  const base = normalizeRelativePath(prefix).replace(/\/+$/, "");
  const full = (path: string) => (base.length === 0 ? path : `${base}/${path}`);
  // Git's rule: a path is excluded when a parent directory is, otherwise by
  // the last rule matching the path itself. The parent walk starts below the
  // walk root; directory-only patterns need the trailing slash.
  const ignores = (relativePath: string, isDirectory?: boolean) => {
    const segments = normalizeRelativePath(relativePath).split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      const path = full(segments.slice(0, index + 1).join("/"));
      const isLast = index === segments.length - 1;
      const result = matcher.matches(isLast && !isDirectory ? path : `${path}/`);
      if (isLast) return result.ignored;
      if (result.ignored) return true;
    }
    return false;
  };
  return {
    dialect: "gitignore",
    ignores,
    // Git cannot re-include anything below an excluded directory.
    prunes: (relativeDirectory) => ignores(relativeDirectory, true),
  };
};

// ---------------------------------------------------------------------------
// dockerignore (moby/patternmatcher semantics)
// ---------------------------------------------------------------------------

interface DockerIgnoreRule {
  ignored: boolean;
  expression: RegExp;
  /** The cleaned pattern is also needed when deciding whether a directory can be pruned. */
  pattern: string;
}

const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const cleanDockerIgnorePath = (value: string) => {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
};

/** Compile one line of Docker's ordered ignore-pattern form into a path matcher. */
const compileDockerIgnoreRule = (raw: string): DockerIgnoreRule | undefined => {
  if (raw.startsWith("#")) {
    return undefined;
  }

  let pattern = raw.trim();
  if (pattern.length === 0 || pattern === ".") {
    return undefined;
  }

  let ignored = true;
  if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("!")) {
    ignored = false;
    pattern = pattern.slice(1).trim();
  }

  pattern = cleanDockerIgnorePath(
    pattern
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, ""),
  );
  if (pattern.length === 0 || pattern === ".") {
    return undefined;
  }

  let body = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\" && pattern[index + 1] !== undefined) {
      body += escapeRegExp(pattern[++index]);
      continue;
    }
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") {
          index++;
        }
        if (pattern[index + 1] === "/") {
          index++;
          body += "(?:.*/)?";
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      body += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        const content = pattern.slice(index + 1, end);
        const negated = content.startsWith("!") || content.startsWith("^");
        const members = negated ? content.slice(1) : content;
        body += `[${negated ? "^" : ""}${members.replaceAll("\\", "\\\\")}]`;
        index = end;
        continue;
      }
    }
    body += escapeRegExp(char);
  }

  return { ignored, expression: new RegExp(`^${body}$`), pattern };
};

/** A path matches a rule when it, or any of its parent directories, does. */
const pathCandidates = (relativePath: string) => {
  const segments = normalizeRelativePath(relativePath).split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
};

/** Index of the last rule matching the path (or a parent), if any. */
const matchingDockerRuleIndex = (relativePath: string, rules: ReadonlyArray<DockerIgnoreRule>) => {
  const candidates = pathCandidates(relativePath);
  let matching: number | undefined;
  for (let index = 0; index < rules.length; index++) {
    if (candidates.some((candidate) => rules[index].expression.test(candidate))) {
      matching = index;
    }
  }
  return matching;
};

const hasGlob = (segment: string) => /[*?[]/.test(segment);

/**
 * Return whether a negated rule could match the directory or any path below
 * it. This is deliberately conservative: a false positive costs a directory
 * read, while a false negative would drop a re-included path.
 */
const canDockerRuleMatchDescendant = (relativeDirectory: string, rule: DockerIgnoreRule) => {
  const directory = normalizeRelativePath(relativeDirectory).split("/");
  const patternParts = rule.pattern.split("/");

  // A recursive segment can bridge any number of directory levels, but the
  // fixed prefix before it still has to reach this tree. For example,
  // `ignored/keep/**` cannot re-include anything below `ignored/other`.
  const recursiveIndex = patternParts.indexOf("**");
  if (recursiveIndex !== -1) {
    for (let index = 0; index < recursiveIndex && index < directory.length; index++) {
      const part = patternParts[index];
      if (!hasGlob(part) && part !== directory[index]) return false;
    }
    return true;
  }

  // Docker patterns are rooted, so a fixed leading segment rules out any
  // directory outside it: `!src` cannot re-include anything below `docs`.
  const compared = Math.min(directory.length, patternParts.length);
  for (let index = 0; index < compared; index++) {
    const part = patternParts[index];
    if (!hasGlob(part) && part !== directory[index]) return false;
  }
  return true;
};

/**
 * Find an ignore rule that excludes every descendant of a directory. Patterns
 * such as `node_modules/**` do not match the directory entry itself, so they
 * are recognized here to let the walker skip their contents.
 */
const descendantIgnoreRuleIndex = (
  relativeDirectory: string,
  rules: ReadonlyArray<DockerIgnoreRule>,
) => {
  const matching = matchingDockerRuleIndex(relativeDirectory, rules);
  let result = matching !== undefined && rules[matching].ignored ? matching : undefined;

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    if (!rule.ignored) continue;
    if (rule.pattern === "**" && (result === undefined || index > result)) {
      result = index;
      continue;
    }
    if (!rule.pattern.endsWith("/**")) continue;
    // Probe below the directory against the original expression, which
    // keeps the pattern's slash scope: `foo/**` must not prune `bar`.
    if (rule.expression.test(`${relativeDirectory}/__alchemy_prune_probe__`)) {
      result = index;
    }
  }
  return result;
};

const parseDockerIgnore = (lines: ReadonlyArray<string>): IgnoreRules => {
  const rules = lines.flatMap((line) => {
    const rule = compileDockerIgnoreRule(line);
    return rule === undefined ? [] : [rule];
  });
  return {
    dialect: "dockerignore",
    // Docker strips trailing slashes, so directory-ness never matters.
    ignores: (relativePath) => {
      const matching = matchingDockerRuleIndex(relativePath, rules);
      return matching !== undefined && rules[matching].ignored;
    },
    prunes: (relativeDirectory) => {
      const directory = normalizeRelativePath(relativeDirectory);
      const ignoreIndex = descendantIgnoreRuleIndex(directory, rules);
      if (ignoreIndex === undefined) return false;
      // Only a later negation can make walking this directory necessary.
      return !rules.some(
        (rule, index) =>
          index > ignoreIndex && !rule.ignored && canDockerRuleMatchDescendant(directory, rule),
      );
    },
  };
};

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

export type WalkEntryType = "File" | "Directory" | "SymbolicLink" | "Other";

export interface WalkEntry {
  /** Path relative to the walk root, `/`-separated. */
  readonly path: string;
  readonly type: WalkEntryType;
}

export interface WalkIgnoringOptions<E, R> {
  /**
   * List one directory (relative to the walk root, `""` for the root). Each
   * child's type must describe the entry itself: a symlink is a
   * `SymbolicLink`, never its target.
   */
  readonly list: (
    relativeDirectory: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly type: WalkEntryType }>, E, R>;
  /** @default no rules */
  readonly rules?: IgnoreRules;
  /**
   * Paths always listed even when excluded (Docker always sends the
   * Dockerfile and its ignore file). Their parent directories are never
   * pruned.
   */
  readonly force?: ReadonlyArray<string>;
}

/**
 * List every entry under a root that the rules keep, sorted by path.
 * Directories are listed too (Docker sends empty directories). Excluded
 * directories are only read when a later rule could re-include something
 * below them; symlinked directories are listed as links and not followed.
 */
export const walkIgnoring = <E, R>({
  list,
  rules,
  force = [],
}: WalkIgnoringOptions<E, R>): Effect.Effect<WalkEntry[], E, R> =>
  Effect.gen(function* () {
    const forced = force.map(normalizeRelativePath);
    const isForced = (path: string) => forced.includes(path);
    const hasForcedDescendant = (path: string) =>
      forced.some((forcedPath) => forcedPath.startsWith(`${path}/`));
    const keeps = (path: string, isDirectory: boolean) =>
      isForced(path) || rules === undefined || !rules.ignores(path, isDirectory);

    const entries: WalkEntry[] = [];
    const pending = [""];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const child of yield* list(directory)) {
        const path = directory.length === 0 ? child.name : `${directory}/${child.name}`;
        if (child.type !== "Directory") {
          if (keeps(path, false)) entries.push({ path, type: child.type });
          continue;
        }
        if (
          rules !== undefined &&
          !isForced(path) &&
          !hasForcedDescendant(path) &&
          rules.prunes(path)
        ) {
          continue;
        }
        if (keeps(path, true)) entries.push({ path, type: "Directory" });
        pending.push(path);
      }
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  });

/**
 * A {@link WalkIgnoringOptions.list} over the real file system rooted at
 * `root`. Symlinks are probed before `stat`, which follows them.
 */
export const listFileSystemDirectory = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn(function* (relativeDirectory: string) {
    const directory = path.join(root, relativeDirectory);
    const names = yield* fs.readDirectory(directory);
    return yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const fullPath = path.join(directory, name);
        const link = yield* Effect.result(fs.readLink(fullPath));
        if (Result.isSuccess(link)) {
          return { name, type: "SymbolicLink" as const };
        }
        const info = yield* fs.stat(fullPath);
        const type: WalkEntryType =
          info.type === "File" || info.type === "Directory" ? info.type : "Other";
        return { name, type };
      }),
    );
  });
});

/**
 * Combine rule sets, e.g. the `.gitignore` files from a working directory up
 * to the repository root (each parsed with its own `prefix`). A path is
 * excluded when any rule set excludes it.
 */
export const combineIgnoreRules = (
  dialect: IgnoreDialect,
  rules: ReadonlyArray<IgnoreRules>,
): IgnoreRules => ({
  dialect,
  ignores: (relativePath, isDirectory) =>
    rules.some((rule) => rule.ignores(relativePath, isDirectory)),
  prunes: (relativeDirectory) => rules.some((rule) => rule.prunes(relativeDirectory)),
});
