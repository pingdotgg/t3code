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

/** Where a quoted name closes, given git escapes every quote the name itself holds. */
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
 * `a/x` and `b/x` on a `---` or `+++` line; `/dev/null` is the side that has no file.
 *
 * Git ends these two lines with a tab when the name holds a space, so that a reader can tell where
 * the name stops, and other producers of the format put a timestamp past that tab. A name holding a
 * tab of its own arrives quoted, with that tab written as an escape, so the first literal tab is
 * never part of what the file is called and everything from it on belongs to git.
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
 * The two names on a `diff --git` line, which git writes with no delimiter between them.
 *
 * `a/one two b/one two` splits in more than one place, so the split that leaves both sides equal
 * wins. A rename is the only entry whose sides differ, and a rename states its names on lines of
 * its own. Anything still ambiguous is left unnamed rather than guessed at.
 *
 * A quoted name ends at its own closing quote, so a header carrying one splits there and needs
 * none of that guessing. Git quotes only the side that needs it, so one side can be quoted alone.
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

/** The right-hand id of `index <before>..<after> <mode>`. */
function headRevision(rest: string): string | null {
  const gap = rest.indexOf("..");
  if (gap === -1) return null;
  const after = rest.slice(gap + 2);
  const end = after.indexOf(" ");
  const head = end === -1 ? after : after.slice(0, end);
  return head.length === 0 ? null : head;
}

/**
 * What the head has of each file in a unified patch, as the blob ids git writes into it.
 *
 * Bitbucket states a file's version nowhere else: its diffstat entries carry a commit and a path
 * and no blob id, and no endpoint answers what a file is now. Git's own `index <before>..<after>`
 * line is in the patch the diff already reads, so the versions cost no call of their own.
 *
 * Keyed the way the client names files: the head's name for it, except for a deletion, where the
 * head has no name and the one it had is what is on screen. An entry the patch gives no `index`
 * line for, one Bitbucket excluded by pattern most often, is left out. `getFileRevisions` in the
 * provider turns that into the empty revision where it holds the whole patch and keeps it out
 * where the patch was cut, on the tick and the read back alike, so the mark holds either way.
 */
export function parseDiffFileRevisions(patch: string): ReadonlyMap<string, string> {
  const revisions = new Map<string, string>();
  let entry: Entry | null = null;

  const close = () => {
    if (entry === null) return;
    const path = entry.deleted ? entry.oldPath : (entry.newPath ?? entry.oldPath);
    if (path !== null && path.length > 0 && entry.revision !== null) {
      revisions.set(path, entry.revision);
    }
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
  return revisions;
}
