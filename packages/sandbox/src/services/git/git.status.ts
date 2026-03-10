import type {
  GitFileStatus,
  GitFileStatusValue,
  GitRepositoryBranches,
  GitRepositoryPaths,
  GitRepositoryStatus,
  GitWorktreeEntry,
} from "./git.service";

function normalizeBranchHead(value: string): string {
  if (value === "(detached)") {
    return "HEAD";
  }

  return value;
}

function decodeGitPath(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  return inner
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"')
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n");
}

function mapStatusCode(value: string): GitFileStatusValue {
  switch (value) {
    case ".":
      return "Unmodified";
    case "?":
      return "Untracked";
    case "M":
    case "T":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "U":
      return "Updated but unmerged";
    default:
      return "Modified";
  }
}

function createFileStatus(
  name: string,
  staging: GitFileStatusValue,
  worktree: GitFileStatusValue,
  extra = "",
): GitFileStatus {
  return {
    name,
    staging,
    worktree,
    extra,
  };
}

function parseOrdinaryEntry(line: string): GitFileStatus | undefined {
  const fields = line.split(" ");
  const xy = fields[1];
  if (!xy || xy.length < 2) {
    return undefined;
  }

  const name = decodeGitPath(fields.slice(8).join(" "));
  return createFileStatus(name, mapStatusCode(xy[0]), mapStatusCode(xy[1]));
}

function parseRenameOrCopyEntry(line: string): GitFileStatus | undefined {
  const tabIndex = line.indexOf("\t");
  const firstPathLine = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
  const originalPath = tabIndex >= 0 ? decodeGitPath(line.slice(tabIndex + 1)) : "";
  const fields = firstPathLine.split(" ");
  const xy = fields[1];
  if (!xy || xy.length < 2) {
    return undefined;
  }

  const name = decodeGitPath(fields.slice(9).join(" "));
  return createFileStatus(name, mapStatusCode(xy[0]), mapStatusCode(xy[1]), originalPath);
}

function parseUnmergedEntry(line: string): GitFileStatus | undefined {
  const fields = line.split(" ");
  const name = decodeGitPath(fields.slice(10).join(" "));
  if (name.length === 0) {
    return undefined;
  }

  return createFileStatus(name, "Updated but unmerged", "Updated but unmerged");
}

export function parseGitStatusPorcelain(output: string): GitRepositoryStatus {
  let currentBranch = "HEAD";
  let branchPublished: boolean | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const fileStatus: GitFileStatus[] = [];

  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      currentBranch = normalizeBranchHead(line.slice("# branch.head ".length).trim());
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      branchPublished = true;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(line.trim());
      if (match?.[1] && match[2]) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
      continue;
    }

    if (line.startsWith("? ")) {
      fileStatus.push(createFileStatus(decodeGitPath(line.slice(2)), "Untracked", "Untracked"));
      continue;
    }

    if (line.startsWith("! ")) {
      continue;
    }

    if (line.startsWith("1 ")) {
      const entry = parseOrdinaryEntry(line);
      if (entry) {
        fileStatus.push(entry);
      }
      continue;
    }

    if (line.startsWith("2 ")) {
      const entry = parseRenameOrCopyEntry(line);
      if (entry) {
        fileStatus.push(entry);
      }
      continue;
    }

    if (line.startsWith("u ")) {
      const entry = parseUnmergedEntry(line);
      if (entry) {
        fileStatus.push(entry);
      }
    }
  }

  if (branchPublished === undefined && currentBranch !== "HEAD") {
    branchPublished = false;
  }

  return {
    currentBranch,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    ...(branchPublished !== undefined ? { branchPublished } : {}),
    fileStatus,
  };
}

export function parseGitBranchesOutput(output: string): GitRepositoryBranches {
  const branches: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const branch = rawLine.trim();
    if (branch.length === 0 || branch.endsWith("/HEAD") || branch.includes(" -> ")) {
      continue;
    }

    if (!seen.has(branch)) {
      seen.add(branch);
      branches.push(branch);
    }
  }

  return { branches };
}

export function parseRepositoryPathsOutput(
  repoOutput: string,
  worktreeOutput: string,
): GitRepositoryPaths {
  const parsePaths = (output: string): string[] => {
    const paths: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of output.split("\n")) {
      const path = rawLine.trim();
      if (path.length === 0 || seen.has(path)) {
        continue;
      }

      seen.add(path);
      paths.push(path);
    }

    return paths;
  };

  return {
    repos: parsePaths(repoOutput),
    worktrees: parsePaths(worktreeOutput),
  };
}

export function parseGitWorktreeList(output: string): readonly GitWorktreeEntry[] {
  type MutableGitWorktreeEntry = {
    path?: string;
    head?: string;
    branch?: string;
    bare?: boolean;
    detached?: boolean;
    locked?: string;
    prunable?: string;
  };

  const entries: GitWorktreeEntry[] = [];
  let current: MutableGitWorktreeEntry = {};

  const pushCurrent = () => {
    if (current.path && current.head) {
      entries.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
        locked: current.locked,
        prunable: current.prunable,
      });
    }
    current = {};
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      pushCurrent();
      continue;
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length).trim();
      continue;
    }

    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      continue;
    }

    if (line === "bare") {
      current.bare = true;
      continue;
    }

    if (line === "detached") {
      current.detached = true;
      continue;
    }

    if (line.startsWith("locked")) {
      current.locked = line.slice("locked".length).trim() || undefined;
      continue;
    }

    if (line.startsWith("prunable")) {
      current.prunable = line.slice("prunable".length).trim() || undefined;
    }
  }

  pushCurrent();
  return entries;
}
