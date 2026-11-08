import type { VcsHistoryCommit, VcsHistoryRef } from "@t3tools/contracts";

/** `git log` format read by {@link parseGitHistoryLog}; use with `--decorate=full`. */
export const GIT_HISTORY_LOG_FORMAT = "--format=%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s%x1e";

function parseDecorations(raw: string): { head: boolean; refs: VcsHistoryRef[] } {
  let head = false;
  const refs: VcsHistoryRef[] = [];
  for (const part of raw.split(",")) {
    let name = part.trim();
    if (name === "HEAD") {
      head = true;
      continue;
    }
    if (name.startsWith("HEAD -> ")) {
      head = true;
      name = name.slice("HEAD -> ".length);
    }
    if (name.startsWith("tag: refs/tags/")) {
      refs.push({ name: name.slice("tag: refs/tags/".length), kind: "tag" });
    } else if (name.startsWith("refs/heads/")) {
      refs.push({ name: name.slice("refs/heads/".length), kind: "local" });
    } else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD")) {
      refs.push({ name: name.slice("refs/remotes/".length), kind: "remote" });
    }
  }
  return { head, refs };
}

export function parseGitHistoryLog(text: string): VcsHistoryCommit[] {
  const commits: VcsHistoryCommit[] = [];
  for (const record of text.split("\x1e")) {
    const fields = record.replace(/^\n+/, "").split("\0");
    const [sha, shortSha, parents, author, timestamp, decorations] = fields;
    if (!sha || fields.length < 7) continue;
    const { head, refs } = parseDecorations(decorations ?? "");
    commits.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author: author ?? "",
      timestamp: Number(timestamp) || 0,
      subject: fields.slice(6).join("\0").trimEnd(),
      refs,
      head,
    });
  }
  return commits;
}
