/**
 * mirrorInclude - the t3.json `mirror.include` allowlist.
 *
 * Git-based sync never transfers ignored files, so paths an agent needs
 * anyway (.env and friends) must be declared in t3.json. Both sides read
 * the list from their own copy of the workspace root; a malformed or
 * missing t3.json simply means no extra paths.
 */
import { T3_PROJECT_FILE_NAME, T3ProjectFile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeProjectFile = Schema.decodeUnknownOption(Schema.fromJsonString(T3ProjectFile));

/**
 * Fixed pattern set force-included when a project's `mirrorIncludeIgnoredFiles`
 * setting is on. Deliberately not a free-text list: it rides the same
 * `git add -f` mechanism as `t3.json`'s `mirror.include`, but as a per-project
 * DB toggle rather than a checked-in, team-shared file.
 *
 * `:(glob)**` matches env files at any depth (monorepos keep them in
 * per-app subfolders, not just the repo root); node_modules is excluded at
 * add time by {@link MIRROR_INCLUDE_EXCLUDE_PATHSPECS}.
 */
export const MIRROR_EXTRA_ENV_PATTERNS: ReadonlyArray<string> = [
  ":(glob)**/.env",
  ":(glob)**/.env.local",
  ":(glob)**/.env.*.local",
];

/**
 * Exclude pathspecs appended to every include-path force-add: dependency
 * trees are never synced (they ship their own stray .env files), so matches
 * under any node_modules are dropped.
 */
export const MIRROR_INCLUDE_EXCLUDE_PATHSPECS: ReadonlyArray<string> = [
  ":(glob,exclude)**/node_modules/**",
];

export const readMirrorIncludePaths = (services: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) =>
  Effect.fn("mirror.readMirrorIncludePaths")(function* (
    workspaceRoot: string,
  ): Effect.fn.Return<ReadonlyArray<string>> {
    const { fileSystem, path } = services;
    const contents = yield* fileSystem
      .readFileString(path.join(workspaceRoot, T3_PROJECT_FILE_NAME))
      .pipe(Effect.option);
    if (Option.isNone(contents)) return [];
    const parsed = decodeProjectFile(contents.value);
    if (Option.isNone(parsed)) return [];
    const include = parsed.value.mirror?.include ?? [];
    // Containment: entries are workspace-relative; anything absolute or
    // escaping upward is dropped rather than force-added.
    return include.filter(
      (entry) =>
        !path.isAbsolute(entry) &&
        !entry.split(/[\\/]/).some((segment) => segment === ".." || segment.includes("\0")),
    );
  });
