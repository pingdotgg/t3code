import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

const ENTRY = "diff --git ";
const QUOTE = '"';

interface Entry {
  oldPath: string | null;
  newPath: string | null;
  deleted: boolean;
  revision: string | null;
  /** Past the first hunk header every line is content, and content can start like a header. */
  inBody: boolean;
}

function quotedEnd(rest: string): number {
  for (let at = 1; at < rest.length; at += 1) {
    const char = rest.charAt(at);
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === QUOTE) return at;
  }
  return -1;
}

/**
 * Git ends the name with a tab when it holds a space, and a name with a tab of its own
 * arrives quoted with that tab escaped, so the first literal tab is never part of what the
 * file is called.
 */
function sidePath(rest: string, prefix: string): string | null {
  const tab = rest.indexOf("\t");
  const token = tab === -1 ? rest : rest.slice(0, tab);
  if (token === "/dev/null") return null;
  const path = unquoteGitPatchPath(token);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function headerSide(token: string, prefix: string): string | null {
  const path = unquoteGitPatchPath(token);
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/**
 * `a/one two b/one two` can split in more than one place, so the split leaving both sides
 * equal wins; a rename (the only case where sides differ) states its names on separate lines
 * instead.
 */
function headerPaths(rest: string): readonly [string | null, string | null] {
  if (rest.startsWith(QUOTE)) {
    const end = quotedEnd(rest);
    if (end === -1 || rest.charAt(end + 1) !== " ") return [null, null];
    return [headerSide(rest.slice(0, end + 1), "a/"), headerSide(rest.slice(end + 2), "b/")];
  }
  if (rest.endsWith(QUOTE)) {
    const opens = rest.indexOf(QUOTE);
    if (opens < 1 || rest.charAt(opens - 1) !== " ") return [null, null];
    return [headerSide(rest.slice(0, opens - 1), "a/"), headerSide(rest.slice(opens), "b/")];
  }
  if (!rest.startsWith("a/")) return [null, null];
  const splits: Array<number> = [];
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) splits.push(at);
  const chosen =
    splits.find((at) => rest.slice(2, at) === rest.slice(at + 3)) ??
    (splits.length === 1 ? splits[0] : undefined);
  return chosen === undefined ? [null, null] : [rest.slice(2, chosen), rest.slice(chosen + 3)];
}

function headRevision(rest: string): string | null {
  const gap = rest.indexOf("..");
  if (gap === -1) return null;
  const after = rest.slice(gap + 2);
  const end = after.indexOf(" ");
  const head = end === -1 ? after : after.slice(0, end);
  return head.length === 0 ? null : head;
}

function parseEntries(patch: string): ReadonlyArray<Omit<Entry, "inBody">> {
  const entries: Array<Omit<Entry, "inBody">> = [];
  let entry: Entry | null = null;

  const close = () => {
    if (entry === null) return;
    const { inBody: _inBody, ...closed } = entry;
    entries.push(closed);
    entry = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith(ENTRY)) {
      close();
      const [oldPath, newPath] = headerPaths(line.slice(ENTRY.length));
      entry = { oldPath, newPath, deleted: false, revision: null, inBody: false };
      continue;
    }
    if (entry === null || entry.inBody) continue;
    if (line.startsWith("@@")) {
      entry.inBody = true;
    } else if (line.startsWith("index ")) {
      entry.revision = headRevision(line.slice("index ".length));
    } else if (line.startsWith("deleted file mode")) {
      entry.deleted = true;
    } else if (line.startsWith("rename from ")) {
      entry.oldPath = unquoteGitPatchPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      entry.newPath = unquoteGitPatchPath(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) {
      entry.oldPath = sidePath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      const side = sidePath(line.slice(4), "b/");
      entry.newPath = side;
      if (side === null) entry.deleted = true;
    }
  }
  close();
  return entries;
}

/**
 * What the head has of each file, as the blob ids from a unified patch's `index <before>..<after>`
 * line: Bitbucket exposes no blob id for a file anywhere else. Keyed by the head's name, except
 * for a deletion where only the old name exists. An entry with no `index` line (most often one
 * Bitbucket excluded by pattern) is left out.
 */
export function parseDiffFileRevisions(patch: string): ReadonlyMap<string, string> {
  const revisions = new Map<string, string>();
  for (const entry of parseEntries(patch)) {
    const path = entry.deleted ? entry.oldPath : (entry.newPath ?? entry.oldPath);
    if (path !== null && path.length > 0 && entry.revision !== null) {
      revisions.set(path, entry.revision);
    }
  }
  return revisions;
}

/**
 * The files a unified patch changes, as the name each side has. A side with no file (`/dev/null`
 * for an added or a deleted file) is null; a rename is the only entry whose two names differ.
 */
export function parseDiffFilePaths(
  patch: string,
): ReadonlyArray<{ readonly oldPath: string | null; readonly newPath: string | null }> {
  return parseEntries(patch).flatMap(({ oldPath, newPath }) =>
    (oldPath ?? newPath) === null ? [] : [{ oldPath, newPath }],
  );
}
