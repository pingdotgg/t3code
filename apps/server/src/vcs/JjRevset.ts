/**
 * `listRefs` emits git-shaped `<remote>/<name>` rows so the shared client helpers keep working, and
 * the clients hand those names straight back to `switchRef` / `createWorktree`. jj cannot resolve
 * `origin/main` (its form is `main@origin`), so every name-to-revset conversion goes through here.
 */

import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/;
const CHANGE_ID_PATTERN = /^[k-z]{32}$/;

/** Escapes `\` and `"` for a jj string literal. */
export function escapeRevsetString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Splits `origin/feature/x` into `{ remote: "origin", name: "feature/x" }` for a known remote. */
export function splitRemoteRefName(
  refName: string,
  remoteNames: ReadonlyArray<string>,
): { readonly remote: string; readonly name: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(
    refName,
    remoteNames.toSorted((a, b) => b.length - a.length),
  );
  return parsed === null ? null : { remote: parsed.remoteName, name: parsed.branchName };
}

/**
 * `file:"<escaped>"` is jj's literal fileset form, git's `--literal-pathspecs` equivalent. Bare
 * arguments are parsed as fileset *expressions*, so `a~b` silently becomes a difference and
 * `a (1).png` fails to parse; a bare leading `-` is parsed as an option instead of a path.
 */
export function literalFilesetPath(filePath: string): string {
  return `file:"${escapeRevsetString(filePath)}"`;
}

/** `bookmarks(exact:"<escaped>")` resolves a local bookmark unambiguously. */
export function localBookmarkRevset(name: string): string {
  return `bookmarks(exact:"${escapeRevsetString(name)}")`;
}

/** `<name>@<remote>` is the only form jj accepts for a remote bookmark. */
export function remoteBookmarkRevset(remote: string, name: string): string {
  return `${name}@${remote}`;
}

/**
 * Client ref name to jj revset. A commit id or change id is returned unchanged so a base handed
 * over the wire as a revision still resolves.
 */
export function refNameToRevset(refName: string, remoteNames: ReadonlyArray<string>): string {
  const remoteRef = splitRemoteRefName(refName, remoteNames);
  if (remoteRef) {
    return remoteBookmarkRevset(remoteRef.remote, remoteRef.name);
  }
  if (COMMIT_ID_PATTERN.test(refName) || CHANGE_ID_PATTERN.test(refName)) {
    return refName;
  }
  return localBookmarkRevset(refName);
}
