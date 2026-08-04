import type {
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelFileStatus,
  VcsPanelSnapshotResult,
  VcsStatusLocalResult,
  VcsStatusResult,
} from "@t3tools/contracts";

export function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function readNulField(output: string, startIndex: number) {
  const endIndex = output.indexOf("\0", startIndex);
  if (endIndex < 0) return { value: output.slice(startIndex), nextIndex: output.length };
  return { value: output.slice(startIndex, endIndex), nextIndex: endIndex + 1 };
}

export function parseNumstat(
  output: string,
): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  if (output.includes("\0")) {
    let index = 0;
    while (index < output.length) {
      const headerEndIndex = output.indexOf("\t", index);
      if (headerEndIndex < 0) break;
      const insertionsRaw = output.slice(index, headerEndIndex);
      const deletionEndIndex = output.indexOf("\t", headerEndIndex + 1);
      if (deletionEndIndex < 0) break;
      const deletionsRaw = output.slice(headerEndIndex + 1, deletionEndIndex);
      index = deletionEndIndex + 1;
      let pathField = readNulField(output, index);
      index = pathField.nextIndex;
      if (pathField.value === "") {
        pathField = readNulField(output, index);
        index = pathField.nextIndex;
        const renamedPathField = readNulField(output, index);
        index = renamedPathField.nextIndex;
        pathField = renamedPathField;
      }
      if (!pathField.value) continue;
      stats.set(pathField.value, {
        insertions: parseCount(insertionsRaw),
        deletions: parseCount(deletionsRaw),
      });
    }
    return stats;
  }
  for (const line of output.split("\n")) {
    const [insertionsRaw, deletionsRaw, path] = line.split("\t");
    if (!path) continue;
    stats.set(path, {
      insertions: parseCount(insertionsRaw),
      deletions: parseCount(deletionsRaw),
    });
  }
  return stats;
}

export function mergeNumstats(
  maps: Iterable<ReadonlyMap<string, { insertions: number; deletions: number }>>,
): Map<string, { insertions: number; deletions: number }> {
  const merged = new Map<string, { insertions: number; deletions: number }>();
  for (const map of maps) {
    for (const [path, stats] of map) {
      const existing = merged.get(path);
      merged.set(path, {
        insertions: (existing?.insertions ?? 0) + stats.insertions,
        deletions: (existing?.deletions ?? 0) + stats.deletions,
      });
    }
  }
  return merged;
}

export function statusFromCode(code: string, fallback: VcsPanelFileStatus): VcsPanelFileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case "M":
      return "modified";
    default:
      return fallback;
  }
}

function decodeGitQuotedPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const inner = path.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) {
      bytes.push("\\".charCodeAt(0));
      continue;
    }
    const octal = /^[0-7]{1,3}/u.exec(inner.slice(index + 1))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    index += 1;
    switch (next) {
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      default:
        bytes.push(...Buffer.from(next));
        break;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function addChange(
  target: VcsPanelFileChange[],
  input: {
    path: string;
    originalPath: string | null;
    status: VcsPanelFileStatus;
    stats?: { insertions: number; deletions: number } | undefined;
  },
) {
  target.push({
    path: input.path,
    originalPath: input.originalPath,
    status: input.status,
    insertions: input.stats?.insertions ?? 0,
    deletions: input.stats?.deletions ?? 0,
  });
}

export function parsePorcelainStatus(input: {
  status: string;
  stagedFiles?: readonly VcsPanelFileChange[];
  stagedStats: Map<string, { insertions: number; deletions: number }>;
  unstagedStats: Map<string, { insertions: number; deletions: number }>;
  untrackedStats: Map<string, { insertions: number; deletions: number }>;
  unstagedFiles?: readonly VcsPanelFileChange[];
}): VcsPanelChangeGroup[] {
  const staged: VcsPanelFileChange[] = [];
  const unstaged: VcsPanelFileChange[] = [];
  const conflicts: VcsPanelFileChange[] = [];

  for (const line of input.status.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("? ")) {
      if (input.unstagedFiles !== undefined) continue;
      const path = decodeGitQuotedPath(line.slice(2));
      addChange(unstaged, {
        path,
        originalPath: null,
        status: "untracked",
        stats: input.untrackedStats.get(path),
      });
      continue;
    }
    if (line.startsWith("u ")) {
      const fields = line.split(" ");
      const path = decodeGitQuotedPath(fields.slice(10).join(" "));
      if (path.length > 0) {
        addChange(conflicts, {
          path,
          originalPath: null,
          status: "conflicted",
          stats: input.unstagedStats.get(path) ?? input.stagedStats.get(path),
        });
      }
      continue;
    }

    if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
    const xy = line.slice(2, 4);
    const stagedCode = xy[0] ?? ".";
    const unstagedCode = xy[1] ?? ".";
    const isRename = line.startsWith("2 ");
    const pathPart = isRename
      ? line.split(" ").slice(9).join(" ")
      : line.split(" ").slice(8).join(" ");
    const [rawPath = "", rawOriginalPath = null] = pathPart.split("\t");
    const path = decodeGitQuotedPath(rawPath);
    const originalPath = rawOriginalPath === null ? null : decodeGitQuotedPath(rawOriginalPath);
    if (path.length === 0) continue;
    if (stagedCode === "U" || unstagedCode === "U") {
      addChange(conflicts, {
        path,
        originalPath,
        status: "conflicted",
        stats: input.unstagedStats.get(path) ?? input.stagedStats.get(path),
      });
      continue;
    }
    if (stagedCode !== "." && input.stagedFiles === undefined) {
      addChange(staged, {
        path,
        originalPath,
        status: statusFromCode(stagedCode, "modified"),
        stats: input.stagedStats.get(path),
      });
    }
    if (unstagedCode !== "." && input.unstagedFiles === undefined) {
      addChange(unstaged, {
        path,
        originalPath,
        status: statusFromCode(unstagedCode, "modified"),
        stats: input.unstagedStats.get(path),
      });
    }
  }

  const sortFiles = (files: VcsPanelFileChange[]) =>
    files.toSorted((left, right) => left.path.localeCompare(right.path));
  return [
    {
      kind: "staged" as const,
      files: sortFiles(input.stagedFiles ? [...input.stagedFiles] : staged),
    },
    {
      kind: "unstaged" as const,
      files: sortFiles(input.unstagedFiles ? [...input.unstagedFiles] : unstaged),
    },
    { kind: "conflicts" as const, files: sortFiles(conflicts) },
  ];
}

export function untrackedPathsFromPorcelain(status: string): string[] {
  return status.split(/\r?\n/u).flatMap((line) => (line.startsWith("? ") ? [line.slice(2)] : []));
}

export function unstagedFilesFromPorcelainStatus(input: {
  status: string;
  unstagedStats?: Map<string, { insertions: number; deletions: number }>;
  untrackedStats?: Map<string, { insertions: number; deletions: number }>;
}): readonly VcsPanelFileChange[] {
  return (
    parsePorcelainStatus({
      status: input.status,
      stagedStats: new Map(),
      unstagedStats: input.unstagedStats ?? new Map(),
      untrackedStats: input.untrackedStats ?? new Map(),
    }).find((group) => group.kind === "unstaged")?.files ?? []
  );
}

function parsePorcelainBranchSync(status: string) {
  let hasUpstream = false;
  let aheadCount = 0;
  let behindCount = 0;

  for (const line of status.split(/\r?\n/u)) {
    if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      for (const part of line.slice("# branch.ab ".length).split(" ")) {
        if (part.startsWith("+")) {
          const ahead = Number.parseInt(part.slice(1), 10);
          if (Number.isFinite(ahead)) aheadCount = ahead;
        }
        if (part.startsWith("-")) {
          const behind = Number.parseInt(part.slice(1), 10);
          if (Number.isFinite(behind)) behindCount = behind;
        }
      }
    }
  }

  return { hasUpstream, aheadCount, behindCount };
}

export function panelStatusFromLocal(
  local: VcsStatusLocalResult | VcsStatusResult,
  porcelain: string,
): VcsPanelSnapshotResult["status"] {
  const sync = parsePorcelainBranchSync(porcelain);
  return {
    ...local,
    ...sync,
    aheadOfDefaultCount: "aheadOfDefaultCount" in local ? local.aheadOfDefaultCount : 0,
    pr: null,
  };
}
