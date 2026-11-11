// @effect-diagnostics nodeBuiltinImport:off -- lstat proves no managed component is a link.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Proves a native runtime entry is at its literal path below the canonical profile: every
 * component exists with the expected type and none is a link. A link could point at another
 * child's transcript or another session's database under the same profile.
 */
export async function antigravityManagedPath(
  profileRoot: string,
  segments: ReadonlyArray<string>,
  kind: "file" | "directory",
): Promise<{ readonly path: string; readonly info: NodeFS.Stats } | undefined> {
  let current = profileRoot;
  let info: NodeFS.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = NodePath.join(current, segment);
    info = await NodeFSP.lstat(current).catch(() => undefined);
    const expectFile = kind === "file" && index === segments.length - 1;
    if (
      info === undefined ||
      info.isSymbolicLink() ||
      (expectFile ? !info.isFile() : !info.isDirectory())
    ) {
      return undefined;
    }
  }
  if (info === undefined) return undefined;
  return (await NodeFSP.realpath(current).catch(() => undefined)) === current
    ? { path: current, info }
    : undefined;
}

export const antigravityProfileRoot = (profileDirectory: string) =>
  NodeFSP.realpath(profileDirectory).catch(() => undefined);
