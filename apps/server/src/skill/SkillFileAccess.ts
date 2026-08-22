// @effect-diagnostics nodeBuiltinImport:off - Provider skill paths need realpath containment checks at the Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { SkillReadFileError, type SkillReadFileResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const MAX_TEXT_BYTES = 1024 * 1024;

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

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(realTarget, "r"),
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

        const bytesToRead = Math.min(stat.size, MAX_TEXT_BYTES);
        const bytes = Buffer.alloc(bytesToRead);
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
