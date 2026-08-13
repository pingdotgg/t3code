// @effect-diagnostics nodeBuiltinImport:off - Provider skill paths need realpath containment checks at the Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { SkillReadFileError, type SkillReadFileResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const MAX_TEXT_BYTES = 1024 * 1024;
async function readFilePrefix(path: string, byteLength: number): Promise<Buffer> {
  const handle = await NodeFSP.open(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(byteLength);
    const { bytesRead } = await handle.read(bytes, 0, byteLength, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function failure(input: {
  readonly skillName: string;
  readonly relativePath: string;
  readonly failure: SkillReadFileError["failure"];
  readonly message: string;
}) {
  return new SkillReadFileError(input);
}

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
    return yield* failure({
      ...input,
      failure: "path_outside_skill",
      message: "The requested file is outside this skill.",
    });
  }

  const [realRoot, realTarget] = yield* Effect.tryPromise({
    try: () => Promise.all([NodeFSP.realpath(skillRoot), NodeFSP.realpath(requestedPath)]),
    catch: () =>
      failure({
        ...input,
        failure: "path_not_file",
        message: "This skill file is no longer available.",
      }),
  });
  const relativeRealPath = NodePath.relative(realRoot, realTarget);
  if (
    relativeRealPath.length === 0 ||
    relativeRealPath === ".." ||
    relativeRealPath.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relativeRealPath)
  ) {
    return yield* failure({
      ...input,
      failure: "path_outside_skill",
      message: "The requested file is outside this skill.",
    });
  }

  const stat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(realTarget),
    catch: () =>
      failure({
        ...input,
        failure: "operation_failed",
        message: "T3 Code could not inspect this skill file.",
      }),
  });
  if (!stat.isFile()) {
    return yield* failure({
      ...input,
      failure: "path_not_file",
      message: "The requested skill path is not a file.",
    });
  }

  const bytes = yield* Effect.tryPromise({
    try: () => readFilePrefix(realTarget, Math.min(stat.size, MAX_TEXT_BYTES)),
    catch: () =>
      failure({
        ...input,
        failure: "operation_failed",
        message: "T3 Code could not read this skill file.",
      }),
  });
  const relativePath = relativeRealPath.split(NodePath.sep).join("/");
  const truncated = stat.size > MAX_TEXT_BYTES;
  const contents = bytes.toString("utf8");
  if (contents.includes("\u0000")) {
    return yield* failure({
      ...input,
      failure: "unsupported_file",
      message: "This skill file cannot be shown as text.",
    });
  }
  return {
    skillName: input.skillName,
    skillPath: input.skillPath,
    relativePath,
    contents,
    byteLength: stat.size,
    truncated,
  } satisfies SkillReadFileResult;
});
