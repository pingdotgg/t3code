// @effect-diagnostics nodeBuiltinImport:off -- lstat proves no managed component is a link.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : undefined;
}

/**
 * Inspects a native runtime entry below the canonical profile, distinguishing genuinely absent
 * paths (`missing`), symlinks/wrong entry types/escaped paths (`invalid`), and transient or
 * permission lookup failures (`error`).
 */
export async function inspectAntigravityManagedPath(
  profileRoot: string,
  segments: ReadonlyArray<string>,
  kind: "file" | "directory",
): Promise<
  | { readonly status: "ok"; readonly path: string; readonly info: NodeFS.Stats }
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | { readonly status: "error"; readonly cause: unknown }
> {
  let current = profileRoot;
  let info: NodeFS.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = NodePath.join(current, segment);
    try {
      info = await NodeFS.promises.lstat(current);
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "ENOENT") return { status: "missing" };
      if (code === "ENOTDIR") return { status: "invalid" };
      return { status: "error", cause };
    }
    const expectFile = kind === "file" && index === segments.length - 1;
    if (info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) {
      return { status: "invalid" };
    }
  }
  if (info === undefined) return { status: "invalid" };
  let canonical: string;
  try {
    canonical = await NodeFS.promises.realpath(current);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT") return { status: "missing" };
    if (code === "ENOTDIR") return { status: "invalid" };
    return { status: "error", cause };
  }
  return canonical === current ? { status: "ok", path: current, info } : { status: "invalid" };
}

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
  const result = await inspectAntigravityManagedPath(profileRoot, segments, kind);
  return result.status === "ok" ? { path: result.path, info: result.info } : undefined;
}

export async function inspectAntigravityProfileRoot(
  profileDirectory: string,
): Promise<
  | { readonly status: "ok"; readonly path: string }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly cause: unknown }
> {
  try {
    return { status: "ok", path: await NodeFS.promises.realpath(profileDirectory) };
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    return { status: "error", cause };
  }
}

export const antigravityProfileRoot = async (profileDirectory: string) => {
  const result = await inspectAntigravityProfileRoot(profileDirectory);
  return result.status === "ok" ? result.path : undefined;
};
