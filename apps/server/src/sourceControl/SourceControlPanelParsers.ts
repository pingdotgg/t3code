import type {
  VcsPanelFileChange,
  VcsPanelFileStatus,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsRef,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as SourceControlProvider from "./SourceControlProvider.ts";
import { parseCount, readNulField, statusFromCode } from "./SourceControlPanelStatusParsers.ts";

export interface WorktreeBranchEntry {
  readonly branchName: string;
  readonly worktreePath: string;
}
export function parseRemoteVerbose(output: string): VcsPanelRemote[] {
  const byName = new Map<string, { fetchUrl: string | null; pushUrl: string | null }>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim());
    if (!match) continue;
    const [, name, url, direction] = match;
    if (!name || !url || !direction) continue;
    const current = byName.get(name) ?? { fetchUrl: null, pushUrl: null };
    if (direction === "fetch") current.fetchUrl = url;
    if (direction === "push") current.pushUrl = url;
    byName.set(name, current);
  }
  return [...byName.entries()].map(([name, remote]) => ({
    name,
    fetchUrl: remote.fetchUrl,
    pushUrl: remote.pushUrl,
    provider: remote.fetchUrl ? detectSourceControlProviderFromRemoteUrl(remote.fetchUrl) : null,
    branches: [],
  }));
}

export function parseRemoteBranches(
  output: string,
  remoteName: string,
): VcsPanelRemote["branches"] {
  const seen = new Set<string>();
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = "", lastActivityAt = ""] = line.split("\t");
      return {
        name,
        lastActivityAt: lastActivityAt.length > 0 ? lastActivityAt : null,
      };
    })
    .filter((branch) => branch.name !== `${remoteName}/HEAD`)
    .filter((branch) => branch.name !== remoteName)
    .filter((branch) => {
      const name = branch.name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map((branch) => ({
      name: branch.name.startsWith(`${remoteName}/`)
        ? branch.name.slice(remoteName.length + 1)
        : branch.name,
      fullRefName: branch.name,
      isDefaultRemoteHead: false,
      lastActivityAt: branch.lastActivityAt,
    }))
    .toSorted(compareBranchActivity);
}

export function parseStashes(output: string): VcsPanelStash[] {
  return output.split("\n").flatMap((line) => {
    const [refName, sha, createdAt, message] = line.split("\t");
    if (!refName) return [];
    return [
      {
        refName,
        sha: sha && sha.length > 0 ? sha : null,
        createdAt: createdAt && createdAt.length > 0 ? createdAt : null,
        message: message && message.trim().length > 0 ? message.trim() : refName,
      },
    ];
  });
}

export function providerContextForRemote(
  remote: VcsPanelRemote,
): SourceControlProvider.SourceControlProviderContext | null {
  if (!remote.provider || remote.provider.kind === "unknown" || !remote.fetchUrl) {
    return null;
  }
  return {
    provider: remote.provider,
    remoteName: remote.name,
    remoteUrl: remote.fetchUrl,
  };
}

export function parseBranchTrackCounts(track: string): {
  readonly aheadCount: number;
  readonly behindCount: number;
} {
  const aheadCount = Number.parseInt(/ahead (\d+)/u.exec(track)?.[1] ?? "0", 10);
  const behindCount = Number.parseInt(/behind (\d+)/u.exec(track)?.[1] ?? "0", 10);
  return {
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
    behindCount: Number.isFinite(behindCount) ? behindCount : 0,
  };
}

export function parseAheadBehindCounts(output: string): {
  readonly aheadCount: number;
  readonly behindCount: number;
} {
  const [aheadRaw = "0", behindRaw = "0"] = output.trim().split(/\s+/u);
  const aheadCount = Number.parseInt(aheadRaw, 10);
  const behindCount = Number.parseInt(behindRaw, 10);
  return {
    aheadCount: Number.isFinite(aheadCount) && aheadCount > 0 ? aheadCount : 0,
    behindCount: Number.isFinite(behindCount) && behindCount > 0 ? behindCount : 0,
  };
}

export function parseWorktreeBranchEntries(output: string): WorktreeBranchEntry[] {
  const entries: WorktreeBranchEntry[] = [];
  let currentPath: string | null = null;

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      currentPath = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (currentPath && line.startsWith("branch refs/heads/")) {
      entries.push({
        branchName: line.slice("branch refs/heads/".length),
        worktreePath: currentPath,
      });
    }
  }

  return entries;
}

export function parseWorktreeBranchPaths(output: string): Map<string, string> {
  return new Map(
    parseWorktreeBranchEntries(output).map((entry) => [entry.branchName, entry.worktreePath]),
  );
}

export function parseLocalBranches(
  output: string,
  worktreeBranchPaths: ReadonlyMap<string, string> = new Map(),
  statusDefaultBranchName: string | null = null,
): VcsRef[] {
  const rows = output
    .split(/\r?\n/u)
    .filter((line) => line.trimEnd().length > 0)
    .map((line) => {
      // Preserve trailing tabs so empty upstream track columns stay aligned.
      const columns = line.split("\t");
      const [name = "", head = ""] = columns;
      const hasInlineWorktreePath = columns.length >= 6;
      const worktreePath = hasInlineWorktreePath ? (columns[2] ?? "") : "";
      const lastActivityAt = hasInlineWorktreePath ? (columns[3] ?? "") : (columns[2] ?? "");
      const upstreamName = hasInlineWorktreePath ? (columns[4] ?? "") : (columns[3] ?? "");
      const track = hasInlineWorktreePath ? (columns[5] ?? "") : (columns[4] ?? "");
      const { aheadCount, behindCount } = parseBranchTrackCounts(track);
      const resolvedWorktreePath = worktreeBranchPaths.get(name) ?? worktreePath;
      return {
        name,
        current: head.trim() === "*",
        worktreePath: resolvedWorktreePath.length > 0 ? resolvedWorktreePath : null,
        lastActivityAt: lastActivityAt.length > 0 ? lastActivityAt : null,
        upstreamName: upstreamName.length > 0 ? upstreamName : null,
        aheadCount,
        behindCount,
      };
    })
    .filter((branch) => branch.name.length > 0);
  const defaultName =
    (statusDefaultBranchName !== null
      ? rows.find((branch) => branch.name === statusDefaultBranchName)?.name
      : null) ??
    rows.find((branch) => branch.name === "main")?.name ??
    rows.find((branch) => branch.name === "master")?.name ??
    rows.find((branch) => !branch.current)?.name ??
    rows[0]?.name ??
    null;

  return rows
    .map((branch) => ({
      name: branch.name,
      current: branch.current,
      isDefault: branch.name === defaultName,
      worktreePath: branch.worktreePath,
      lastActivityAt: branch.lastActivityAt,
      upstreamName: branch.upstreamName,
      aheadCount: branch.aheadCount,
      behindCount: branch.behindCount,
    }))
    .toSorted(compareBranchActivity);
}

export function branchActivityTime(value: {
  readonly lastActivityAt?: string | null | undefined;
}): number {
  if (!value.lastActivityAt) return 0;
  const time = Date.parse(value.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
}

export function compareBranchActivity(
  left: { readonly lastActivityAt?: string | null; readonly name: string },
  right: { readonly lastActivityAt?: string | null; readonly name: string },
): number {
  const activity = branchActivityTime(right) - branchActivityTime(left);
  return activity !== 0 ? activity : left.name.localeCompare(right.name);
}

export function parsePathLines(output: string): string[] {
  return output.split(/\r?\n/u).filter((line) => line.length > 0);
}

export function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

export function parseCreatedFromRef(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^branch: Created from (.+)$/u.exec(line.trim());
    const refName = match?.[1]?.trim();
    if (!refName || refName === "HEAD") continue;
    return refName.replace(/^refs\/heads\//u, "").replace(/^refs\/remotes\//u, "");
  }
  return null;
}

export function parseCommits(output: string): VcsPanelSnapshotResult["recentCommits"] {
  return output.split("\n").flatMap((line) => {
    const fields = line.split("\t");
    if (fields.length < 6) return [];
    const [sha, shortSha, authorName, authorEmail, authoredAt, ...messageParts] = fields;
    if (!sha || !shortSha) return [];
    const message = messageParts.join("\t");
    return [
      {
        sha,
        shortSha,
        message,
        authorName: authorName ?? null,
        authorEmail: authorEmail ?? null,
        authorAvatarUrl: null,
        authoredAt: authoredAt ?? null,
        headRefs: [],
        tags: [],
        files: [],
      },
    ];
  });
}

export function fileStatusFromNameStatus(status: string | undefined): VcsPanelFileStatus {
  if (!status) return "modified";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  return statusFromCode(status[0] ?? "M", "modified");
}

export function parseNameStatus(
  output: string,
): Map<string, { status: VcsPanelFileStatus; originalPath: string | null }> {
  const statuses = new Map<string, { status: VcsPanelFileStatus; originalPath: string | null }>();
  if (output.includes("\0")) {
    const fields = output.split("\0").filter((field) => field.length > 0);
    for (let index = 0; index < fields.length; index += 1) {
      const statusRaw = fields[index];
      const firstPath = fields[index + 1];
      if (!statusRaw || !firstPath) continue;
      const status = fileStatusFromNameStatus(statusRaw);
      const hasSecondPath = statusRaw.startsWith("R") || statusRaw.startsWith("C");
      const secondPath = hasSecondPath ? fields[index + 2] : undefined;
      if (hasSecondPath) index += 2;
      else index += 1;
      const path = secondPath ?? firstPath;
      statuses.set(path, {
        status,
        originalPath: secondPath ? firstPath : null,
      });
    }
    return statuses;
  }
  for (const line of output.split("\n")) {
    const [statusRaw, firstPath, secondPath] = line.split("\t");
    if (!statusRaw || !firstPath) continue;
    const path = secondPath ?? firstPath;
    statuses.set(path, {
      status: fileStatusFromNameStatus(statusRaw),
      originalPath: secondPath ? firstPath : null,
    });
  }
  return statuses;
}

export function parseFileChangesFromNumstat(input: {
  numstat: string;
  statuses?: Map<string, { status: VcsPanelFileStatus; originalPath: string | null }>;
}): VcsPanelFileChange[] {
  const files: VcsPanelFileChange[] = [];
  if (input.numstat.includes("\0")) {
    let index = 0;
    while (index < input.numstat.length) {
      const headerEndIndex = input.numstat.indexOf("\t", index);
      if (headerEndIndex < 0) break;
      const insertionsRaw = input.numstat.slice(index, headerEndIndex);
      const deletionEndIndex = input.numstat.indexOf("\t", headerEndIndex + 1);
      if (deletionEndIndex < 0) break;
      const deletionsRaw = input.numstat.slice(headerEndIndex + 1, deletionEndIndex);
      index = deletionEndIndex + 1;
      let pathField = readNulField(input.numstat, index);
      index = pathField.nextIndex;
      let originalPath: string | null = null;
      if (pathField.value === "") {
        const originalPathField = readNulField(input.numstat, index);
        index = originalPathField.nextIndex;
        const renamedPathField = readNulField(input.numstat, index);
        index = renamedPathField.nextIndex;
        originalPath = originalPathField.value || null;
        pathField = renamedPathField;
      }
      const path = pathField.value;
      if (!path) continue;
      const status = input.statuses?.get(path);
      const resolvedOriginalPath = status?.originalPath ?? originalPath;
      files.push({
        path,
        originalPath: resolvedOriginalPath,
        status: status?.status ?? (resolvedOriginalPath ? "renamed" : "modified"),
        insertions: parseCount(insertionsRaw),
        deletions: parseCount(deletionsRaw),
      });
    }
    return files.toSorted((left, right) => left.path.localeCompare(right.path));
  }
  for (const line of input.numstat.split("\n")) {
    const [insertionsRaw, deletionsRaw, oldPathRaw, newPathRaw] = line.split("\t");
    const path = newPathRaw ?? oldPathRaw;
    if (!path) continue;
    const status = input.statuses?.get(path);
    const originalPath = status?.originalPath ?? (newPathRaw ? (oldPathRaw ?? null) : null);
    files.push({
      path,
      originalPath,
      status: status?.status ?? (originalPath ? "renamed" : "modified"),
      insertions: parseCount(insertionsRaw),
      deletions: parseCount(deletionsRaw),
    });
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}
