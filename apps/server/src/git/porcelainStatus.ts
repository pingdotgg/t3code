import type { VcsWorkingTreeFileStatus } from "@t3tools/contracts";

export type PorcelainStatusEntry = {
  readonly path: string;
  readonly status: VcsWorkingTreeFileStatus;
};

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (line.startsWith("2 ")) {
    const tabIndex = line.indexOf("\t");
    const head = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
    const dest = head.split(" ").slice(9).join(" ").trim();
    return dest.length > 0 ? dest : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

export function workingTreeStatusFromPorcelainXy(
  xy: string,
  renamed: boolean,
): VcsWorkingTreeFileStatus {
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  if (index === "U" || worktree === "U") return "modified";
  if (index === "D" || worktree === "D") return "deleted";
  if (renamed || index === "R" || worktree === "R" || index === "C" || worktree === "C") {
    return "renamed";
  }
  if (index === "A" || worktree === "A") return "added";
  if (index === "M" || worktree === "M" || index === "T" || worktree === "T") return "modified";
  return "modified";
}

/** Maps one porcelain-2 row to the single status the file explorer can show. */
export function parsePorcelainStatus(line: string): PorcelainStatusEntry | null {
  if (line.startsWith("? ")) {
    const path = line.slice(2).trim();
    return path.length > 0 ? { path, status: "untracked" } : null;
  }
  if (line.startsWith("! ")) {
    return null;
  }
  const path = parsePorcelainPath(line);
  if (!path) return null;
  if (line.startsWith("u ")) {
    return { path, status: "modified" };
  }
  if (line.startsWith("1 ") || line.startsWith("2 ")) {
    return {
      path,
      status: workingTreeStatusFromPorcelainXy(line.slice(2, 4), line.startsWith("2 ")),
    };
  }
  return null;
}
