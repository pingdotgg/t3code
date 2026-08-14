// @effect-diagnostics nodeBuiltinImport:off - Provider skill paths need realpath containment checks at the Node filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { SkillReadFileError, type SkillReadFileResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const MAX_TEXT_BYTES = 1024 * 1024;
const SKILL_READ_OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  // Windows does not support O_NOFOLLOW. The lstat/fstat identity check below
  // still detects a replacement there.
  (process.platform === "win32" ? 0 : NodeFS.constants.O_NOFOLLOW);

export const readResolvedSkillFile = Effect.fn("readResolvedSkillFile")(function* (input: {
  readonly skillName: string;
  readonly skillPath: string;
  readonly relativePath: string;
}) {
  const skillRoot = NodePath.dirname(input.skillPath);
  const requestedPath = NodePath.resolve(skillRoot, input.relativePath);
  const relativeRequestedPath = NodePath.relative(skillRoot, requestedPath);
  if (
    relativeRequestedPath.length === 0 ||
    relativeRequestedPath === ".." ||
    relativeRequestedPath.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relativeRequestedPath)
  ) {
    return yield* new SkillReadFileError({
      skillName: input.skillName,
      relativePath: input.relativePath,
      failure: "path_outside_skill",
    });
  }

  const [realRoot, realTarget] = yield* Effect.tryPromise({
    try: () => Promise.all([NodeFSP.realpath(skillRoot), NodeFSP.realpath(requestedPath)]),
    catch: (cause) =>
      new SkillReadFileError({
        skillName: input.skillName,
        relativePath: input.relativePath,
        failure: "path_not_file",
        cause,
      }),
  });
  const relativeRealPath = NodePath.relative(realRoot, realTarget);
  if (
    relativeRealPath.length === 0 ||
    relativeRealPath === ".." ||
    relativeRealPath.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relativeRealPath)
  ) {
    return yield* new SkillReadFileError({
      skillName: input.skillName,
      relativePath: input.relativePath,
      failure: "path_outside_skill",
    });
  }

  // Keep the lstat identity and later file-handle stat aligned. A swapped
  // symlink changes inode/device and is rejected before its contents are read.
  const expectedStat = yield* Effect.tryPromise({
    try: () => NodeFSP.lstat(realTarget),
    catch: (cause) =>
      new SkillReadFileError({
        skillName: input.skillName,
        relativePath: input.relativePath,
        failure: "operation_failed",
        cause,
      }),
  });
  if (!expectedStat.isFile()) {
    return yield* new SkillReadFileError({
      skillName: input.skillName,
      relativePath: input.relativePath,
      failure: "path_not_file",
    });
  }

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(realTarget, SKILL_READ_OPEN_FLAGS),
      catch: (cause) =>
        new SkillReadFileError({
          skillName: input.skillName,
          relativePath: input.relativePath,
          failure: "operation_failed",
          cause,
        }),
    }),
    (handle) =>
      Effect.gen(function* () {
        const stat = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: (cause) =>
            new SkillReadFileError({
              skillName: input.skillName,
              relativePath: input.relativePath,
              failure: "operation_failed",
              cause,
            }),
        });
        if (!stat.isFile()) {
          return yield* new SkillReadFileError({
            skillName: input.skillName,
            relativePath: input.relativePath,
            failure: "path_not_file",
          });
        }
        if (stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) {
          return yield* new SkillReadFileError({
            skillName: input.skillName,
            relativePath: input.relativePath,
            failure: "operation_failed",
          });
        }

        const bytesToRead = Math.min(stat.size, MAX_TEXT_BYTES);
        const bytes = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = yield* Effect.tryPromise({
          try: () => handle.read(bytes, 0, bytesToRead, 0),
          catch: (cause) =>
            new SkillReadFileError({
              skillName: input.skillName,
              relativePath: input.relativePath,
              failure: "operation_failed",
              cause,
            }),
        });
        const contents = bytes.subarray(0, bytesRead).toString("utf8");
        if (contents.includes("\u0000")) {
          return yield* new SkillReadFileError({
            skillName: input.skillName,
            relativePath: input.relativePath,
            failure: "unsupported_file",
          });
        }

        return {
          skillName: input.skillName,
          skillPath: input.skillPath,
          relativePath: relativeRealPath.split(NodePath.sep).join("/"),
          contents,
          byteLength: stat.size,
          truncated: stat.size > MAX_TEXT_BYTES,
        } satisfies SkillReadFileResult;
      }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.close(),
        catch: (cause) =>
          new SkillReadFileError({
            skillName: input.skillName,
            relativePath: input.relativePath,
            failure: "operation_failed",
            cause,
          }),
      }),
  );
});
