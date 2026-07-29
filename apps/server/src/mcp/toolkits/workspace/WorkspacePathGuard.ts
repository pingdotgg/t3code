/**
 * WorkspacePathGuard — the containment boundary for the workspace MCP toolkit.
 *
 * Every path a remote MCP client supplies passes through `resolveWithin`
 * before any filesystem call happens. The guard is deliberately pure and
 * synchronous over already-realised paths: it takes the workspace root, the
 * caller's relative path, and (for symlink checks) the real path the OS
 * resolved to, and answers one question — may this be read?
 *
 * The threat model is not "a confused model asks for the wrong file". It is
 * "the MCP endpoint is reachable from the public internet, and the token
 * leaked". So containment does not rely on the model behaving, on the schema
 * having rejected `..` first, or on the caller passing a relative path at all.
 * Each check re-establishes the invariant from scratch.
 *
 * Three rules, in order:
 *
 *   1. **Containment.** The resolved path must be the root or live under it.
 *      Compared segment-wise, never by string prefix — `/repo-secrets` must
 *      not pass as a child of `/repo`.
 *   2. **Symlink escape.** The path the OS really resolved to must satisfy
 *      rule 1 as well, so a symlink inside the worktree cannot point out of
 *      it. Callers pass the realpath; the guard does not perform I/O.
 *   3. **Blocked segments and globs.** Secrets and noise (`.env`, `*.pem`,
 *      `.git`, `node_modules`, …) are refused even when contained, because
 *      containment alone would still hand over credentials.
 *
 * @module mcp/toolkits/workspace/WorkspacePathGuard
 */
// @effect-diagnostics nodeBuiltinImport:off
// Path arithmetic here is pure and synchronous by design — the guard is a
// decision function over strings, not an I/O boundary — so it uses the Node
// builtin rather than the effectful `Path` service.
import * as NodePath from "node:path";

/**
 * Path segments refused anywhere in a path. `.git` is included because the
 * object store holds every historical version of files the globs below are
 * meant to protect, so blocking `.env` while serving `.git` protects nothing.
 */
export const BLOCKED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".npmrc",
  "node_modules",
  ".venv",
  "__pycache__",
  ".DS_Store",
]);

/**
 * Filename patterns refused anywhere in the tree, matched against the base
 * name. Kept as explicit predicates rather than a glob dependency: the set is
 * small, the matching is hot, and a wrong glob here is a credential leak.
 */
const BLOCKED_FILENAME_MATCHERS: ReadonlyArray<(name: string) => boolean> = [
  (name) => name === ".env" || name.startsWith(".env."),
  (name) => name.endsWith(".pem"),
  (name) => name.endsWith(".key"),
  (name) => name.endsWith(".p12"),
  (name) => name.endsWith(".pfx"),
  (name) => name.startsWith("id_rsa"),
  (name) => name.startsWith("id_ed25519"),
  (name) => name.startsWith("id_ecdsa"),
  (name) => name === ".netrc" || name === "_netrc",
  (name) => name === "credentials" || name === "credentials.json",
];

export type WorkspacePathRejection =
  | "escapes-workspace"
  | "symlink-escapes-workspace"
  | "blocked-path";

export type WorkspacePathResolution =
  | { readonly ok: true; readonly absolutePath: string; readonly relativePath: string }
  | { readonly ok: false; readonly rejection: WorkspacePathRejection };

/**
 * Splits a path into non-empty segments, normalising separators so Windows
 * and POSIX inputs compare the same way.
 */
const segmentsOf = (value: string): ReadonlyArray<string> =>
  value.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");

/**
 * True when `candidate` is `root` itself or lives beneath it.
 *
 * Segment-wise on purpose. `NodePath.relative` alone would accept
 * `/repo-secrets` as `../repo-secrets`-free on some inputs, and a plain
 * `startsWith` accepts the classic sibling-prefix escape.
 */
export const isContainedWithin = (root: string, candidate: string): boolean => {
  const rootSegments = segmentsOf(NodePath.resolve(root));
  const candidateSegments = segmentsOf(NodePath.resolve(candidate));
  if (candidateSegments.length < rootSegments.length) return false;
  return rootSegments.every((segment, index) => candidateSegments[index] === segment);
};

/** True when any segment or base name of the relative path is refused. */
export const isBlockedPath = (relativePath: string): boolean => {
  const segments = segmentsOf(relativePath);
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) return true;
  return segments.some((segment) => BLOCKED_FILENAME_MATCHERS.some((matches) => matches(segment)));
};

/**
 * Resolves a caller-supplied path against the workspace root and applies
 * every containment rule.
 *
 * `realPath` is the path the OS resolved symlinks to, supplied by the caller
 * after it has stat'd the file. Omit it when the path does not exist yet or
 * has not been realised — rule 2 is then skipped, which is safe because rules
 * 1 and 3 still hold and nothing has been read.
 */
export const resolveWithin = (input: {
  readonly root: string;
  readonly requestedPath: string;
  readonly realPath?: string | undefined;
}): WorkspacePathResolution => {
  const root = NodePath.resolve(input.root);
  // An absolute request is resolved on its own, not joined, so `/etc/passwd`
  // is caught by the containment check instead of silently becoming
  // `<root>/etc/passwd` and reading the wrong file without complaint.
  const absolutePath = NodePath.isAbsolute(input.requestedPath)
    ? NodePath.resolve(input.requestedPath)
    : NodePath.resolve(root, input.requestedPath);

  if (!isContainedWithin(root, absolutePath)) {
    return { ok: false, rejection: "escapes-workspace" };
  }
  if (input.realPath !== undefined && !isContainedWithin(root, input.realPath)) {
    return { ok: false, rejection: "symlink-escapes-workspace" };
  }

  const relativePath = NodePath.relative(root, absolutePath);
  if (isBlockedPath(relativePath)) {
    return { ok: false, rejection: "blocked-path" };
  }

  return { ok: true, absolutePath, relativePath: relativePath === "" ? "." : relativePath };
};

/** Human-readable reason surfaced to the calling model. */
export const describeRejection = (rejection: WorkspacePathRejection): string => {
  switch (rejection) {
    case "escapes-workspace":
      return "That path is outside this thread's workspace.";
    case "symlink-escapes-workspace":
      return "That path resolves through a symlink that leaves this thread's workspace.";
    case "blocked-path":
      return "That path is blocked: version-control internals, dependency directories, and credential files are never served.";
  }
};
