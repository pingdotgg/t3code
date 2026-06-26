import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import {
  GitCommandError,
  type VcsPanelAddRemoteInput,
  type VcsPanelActionableForkBranch,
  type VcsPanelBranchActionInput,
  type VcsPanelBranchCommitsInput,
  type VcsPanelBranchCommitsResult,
  type VcsPanelBranchDetails,
  type VcsPanelBranchDetailsInput,
  type VcsPanelCommitActionInput,
  type VcsPanelCommitInput,
  type VcsPanelChangeGroup,
  type VcsPanelCompareInput,
  type VcsPanelCompareResult,
  type VcsPanelDeleteBranchInput,
  type VcsPanelFileActionInput,
  type VcsPanelFileChange,
  type VcsPanelFileDiffInput,
  type VcsPanelFileDiffResult,
  type VcsPanelFileStatus,
  type VcsPanelRemote,
  type VcsPanelRemoteInput,
  type VcsPanelRefActionInput,
  type VcsPanelSnapshotInput,
  type VcsPanelSnapshotResult,
  type VcsPanelStash,
  type VcsPanelStashDetails,
  type VcsPanelStashDetailsInput,
  type VcsPanelStashInput,
  type VcsPanelUndoCommitInput,
  type VcsPanelWorktreeChangeSet,
  type VcsPanelWorkingTreeFileEnrichmentInput,
  type VcsPanelWorkingTreeFileEnrichmentResult,
  type VcsPullResult,
  type VcsRef,
  type VcsStatusLocalResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import type { ChangeRequest } from "@t3tools/contracts";

import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
const isGitCommandError = Schema.is(GitCommandError);
const LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS = [
  "branch",
  "--format=%(refname:short)%09%(HEAD)%09%(worktreepath)%09%(committerdate:iso-strict)%09%(upstream:short)%09%(upstream:track)",
] as const;
const LOCAL_BRANCHES_WITHOUT_WORKTREE_PATH_ARGS = [
  "branch",
  "--format=%(refname:short)%09%(HEAD)%09%09%(committerdate:iso-strict)%09%(upstream:short)%09%(upstream:track)",
] as const;

interface WorktreeBranchEntry {
  readonly branchName: string;
  readonly worktreePath: string;
}

export class SourceControlPanelService extends Context.Service<
  SourceControlPanelService,
  {
    readonly snapshot: (
      input: VcsPanelSnapshotInput,
    ) => Effect.Effect<VcsPanelSnapshotResult, GitCommandError>;
    readonly branchDetails: (
      input: VcsPanelBranchDetailsInput,
    ) => Effect.Effect<VcsPanelBranchDetails, GitCommandError>;
    readonly branchCommits: (
      input: VcsPanelBranchCommitsInput,
    ) => Effect.Effect<VcsPanelBranchCommitsResult, GitCommandError>;
    readonly stashDetails: (
      input: VcsPanelStashDetailsInput,
    ) => Effect.Effect<VcsPanelStashDetails, GitCommandError>;
    readonly stageFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly unstageFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly discardFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly enrichWorkingTreeFiles: (
      input: VcsPanelWorkingTreeFileEnrichmentInput,
    ) => Effect.Effect<VcsPanelWorkingTreeFileEnrichmentResult, GitCommandError>;
    readonly readFileDiff: (
      input: VcsPanelFileDiffInput,
    ) => Effect.Effect<VcsPanelFileDiffResult, GitCommandError>;
    readonly commitStaged: (input: VcsPanelCommitInput) => Effect.Effect<void, GitCommandError>;
    readonly pullBranch: (
      input: VcsPanelBranchActionInput,
    ) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly pushBranch: (input: VcsPanelBranchActionInput) => Effect.Effect<void, GitCommandError>;
    readonly deleteBranch: (
      input: VcsPanelDeleteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly undoLatestCommit: (
      input: VcsPanelUndoCommitInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly revertCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly checkoutCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<{ readonly refName: string }, GitCommandError>;
    readonly createBranchFromCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<{ readonly refName: string }, GitCommandError>;
    readonly mergeBranchIntoCurrent: (
      input: VcsPanelRefActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly rebaseCurrentOnto: (
      input: VcsPanelRefActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchBranch: (
      input: VcsPanelBranchActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemote: (input: VcsPanelRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly fetchAllRemotes: (
      input: VcsPanelSnapshotInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly addRemote: (input: VcsPanelAddRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly removeRemote: (input: VcsPanelRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly createStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly applyStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly popStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly dropStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly compare: (
      input: VcsPanelCompareInput,
    ) => Effect.Effect<VcsPanelCompareResult, GitCommandError>;
  }
>()("t3/sourceControl/SourceControlPanelService") {}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function gitError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
) {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause: sanitizeErrorCause(cause) }),
  });
}

function detailFromUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const detail = cause.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Source control operation failed.";
}

function asGitCommandError(operation: string, cwd: string, args: readonly string[]) {
  return (cause: unknown) =>
    isGitCommandError(cause)
      ? cause
      : gitError(operation, cwd, args, detailFromUnknown(cause), cause);
}

function isUnsupportedWorktreePathFormat(detail: string) {
  detail = detail.toLowerCase();
  return detail.includes("worktreepath") && detail.includes("unknown field");
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNulField(output: string, startIndex: number) {
  const endIndex = output.indexOf("\0", startIndex);
  if (endIndex < 0) return { value: output.slice(startIndex), nextIndex: output.length };
  return { value: output.slice(startIndex, endIndex), nextIndex: endIndex + 1 };
}

function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
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

function mergeNumstats(
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

function statusFromCode(code: string, fallback: VcsPanelFileStatus): VcsPanelFileStatus {
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

function parsePorcelainStatus(input: {
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

function untrackedPathsFromPorcelain(status: string): string[] {
  return status.split(/\r?\n/u).flatMap((line) => (line.startsWith("? ") ? [line.slice(2)] : []));
}

function unstagedFilesFromPorcelainStatus(input: {
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

function panelStatusFromLocal(
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

function parseRemoteVerbose(output: string): VcsPanelRemote[] {
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

function parseRemoteBranches(output: string, remoteName: string): VcsPanelRemote["branches"] {
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

function parseStashes(output: string): VcsPanelStash[] {
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

function providerContextForRemote(
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

function parseBranchTrackCounts(track: string): {
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

function parseAheadBehindCounts(output: string): {
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

function parseWorktreeBranchEntries(output: string): WorktreeBranchEntry[] {
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

function parseWorktreeBranchPaths(output: string): Map<string, string> {
  return new Map(
    parseWorktreeBranchEntries(output).map((entry) => [entry.branchName, entry.worktreePath]),
  );
}

function parseLocalBranches(
  output: string,
  worktreeBranchPaths: ReadonlyMap<string, string> = new Map(),
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

function branchActivityTime(value: {
  readonly lastActivityAt?: string | null | undefined;
}): number {
  if (!value.lastActivityAt) return 0;
  const time = Date.parse(value.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
}

function compareBranchActivity(
  left: { readonly lastActivityAt?: string | null; readonly name: string },
  right: { readonly lastActivityAt?: string | null; readonly name: string },
): number {
  const activity = branchActivityTime(right) - branchActivityTime(left);
  return activity !== 0 ? activity : left.name.localeCompare(right.name);
}

function avatarUrlForEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return null;
  return null;
}

function parsePathLines(output: string): string[] {
  return output.split(/\r?\n/u).filter((line) => line.length > 0);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function parseCreatedFromRef(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^branch: Created from (.+)$/u.exec(line.trim());
    const refName = match?.[1]?.trim();
    if (!refName || refName === "HEAD") continue;
    return refName.replace(/^refs\/heads\//u, "").replace(/^refs\/remotes\//u, "");
  }
  return null;
}

function parseCommits(output: string): VcsPanelSnapshotResult["recentCommits"] {
  return output.split("\n").flatMap((line) => {
    const [sha, shortSha, authorName, authorEmail, authoredAt, message] = line.split("\t");
    if (!sha || !shortSha || !message) return [];
    return [
      {
        sha,
        shortSha,
        message,
        authorName: authorName ?? null,
        authorEmail: authorEmail ?? null,
        authorAvatarUrl: avatarUrlForEmail(authorEmail),
        authoredAt: authoredAt ?? null,
        headRefs: [],
        tags: [],
        files: [],
      },
    ];
  });
}

function fileStatusFromNameStatus(status: string | undefined): VcsPanelFileStatus {
  if (!status) return "modified";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  return statusFromCode(status[0] ?? "M", "modified");
}

function parseNameStatus(
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

function parseFileChangesFromNumstat(input: {
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

function validateGitPositionalName(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly kind: string;
  readonly value: string;
}): Effect.Effect<string, GitCommandError> {
  const value = input.value.trim();
  if (value.length === 0) {
    return Effect.fail(
      gitError(input.operation, input.cwd, input.args, `${input.kind} is required.`),
    );
  }
  if (value.startsWith("-")) {
    return Effect.fail(
      gitError(input.operation, input.cwd, input.args, `${input.kind} cannot start with "-".`),
    );
  }
  return Effect.succeed(value);
}

function targetRef(target: VcsPanelCompareInput["left"]): string {
  switch (target.kind) {
    case "working-tree":
      return "";
    case "branch":
      return target.refName;
    case "stash":
      return target.refName;
  }
}

export const make = Effect.fn("makeSourceControlPanelService")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver;
  const path = yield* Path.Path;
  const workflow = yield* GitWorkflowService;
  const serverSettings = yield* ServerSettingsService;
  const context = yield* Effect.context<never>();
  const sourceControlProviders = Option.getOrUndefined(
    Context.getOption(context, SourceControlProviderRegistry),
  );
  const textGeneration = Option.getOrUndefined(Context.getOption(context, TextGeneration));

  const runResult = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: { readonly allowNonZeroExit?: boolean; readonly env?: NodeJS.ProcessEnv },
  ) =>
    git
      .execute({
        operation,
        cwd,
        args,
        ...(options?.env !== undefined ? { env: options.env } : {}),
        allowNonZeroExit: options?.allowNonZeroExit ?? false,
        timeoutMs: 30_000,
        maxOutputBytes: 8 * 1024 * 1024,
        appendTruncationMarker: true,
      })
      .pipe(Effect.mapError(asGitCommandError(operation, cwd, args)));

  const run = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: { readonly allowNonZeroExit?: boolean; readonly env?: NodeJS.ProcessEnv },
  ) =>
    runResult(operation, cwd, args, options).pipe(
      Effect.flatMap((result) => {
        if (options?.allowNonZeroExit === true || result.exitCode === 0) {
          return Effect.succeed(result.stdout);
        }
        return Effect.fail(
          gitError(operation, cwd, args, result.stderr.trim() || result.stdout.trim()),
        );
      }),
    );

  const withTemporaryIntentToAddIndex = <A, E>(
    input: {
      readonly cwd: string;
      readonly paths: readonly string[];
      readonly operations: {
        readonly gitIndexPath: string;
        readonly tempIndexReadTree: string;
        readonly tempIndexIntentToAdd: string;
      };
    },
    body: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const gitIndexPath = (yield* run(input.operations.gitIndexPath, input.cwd, [
        "rev-parse",
        "--git-path",
        "index",
      ])).trim();
      const sourceIndexPath = path.isAbsolute(gitIndexPath)
        ? gitIndexPath
        : path.resolve(input.cwd, gitIndexPath);
      const tempDir = yield* fileSystem.makeTempDirectory({ prefix: "t3-vcs-index-" });
      return yield* Effect.gen(function* () {
        const tempIndexPath = path.join(tempDir, "index");
        const env = { ...globalThis.process.env, GIT_INDEX_FILE: tempIndexPath };
        yield* fileSystem.copyFile(sourceIndexPath, tempIndexPath).pipe(
          Effect.catch(() =>
            run(input.operations.tempIndexReadTree, input.cwd, ["read-tree", "HEAD"], {
              env,
            }).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          ),
        );
        yield* run(
          input.operations.tempIndexIntentToAdd,
          input.cwd,
          ["add", "-N", "--", ...input.paths],
          { env },
        ).pipe(Effect.asVoid);
        return yield* body(env);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    });

  const COMMIT_PAGE_SIZE = 10;

  const readWorkingTreeChangeGroups = (
    cwd: string,
  ): Effect.Effect<
    {
      readonly porcelain: string;
      readonly changeGroups: VcsPanelChangeGroup[];
    },
    GitCommandError
  > =>
    Effect.all(
      [
        run("vcs.panel.statusPorcelain", cwd, ["status", "--porcelain=2", "--branch", "-uall"]),
        run("vcs.panel.unstagedNumstat", cwd, ["diff", "--numstat", "-z", "--find-renames=20%"]),
        run("vcs.panel.stagedNumstat", cwd, [
          "diff",
          "--cached",
          "--numstat",
          "-z",
          "--find-renames=20%",
        ]),
        run("vcs.panel.stagedNameStatus", cwd, [
          "diff",
          "--cached",
          "--name-status",
          "-z",
          "--find-renames=20%",
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([porcelain, unstagedNumstat, stagedNumstat, stagedNameStatus]) => {
        const stagedFiles = parseFileChangesFromNumstat({
          numstat: stagedNumstat,
          statuses: parseNameStatus(stagedNameStatus),
        });
        return {
          porcelain,
          changeGroups: parsePorcelainStatus({
            status: porcelain,
            stagedFiles,
            stagedStats: parseNumstat(stagedNumstat),
            unstagedStats: parseNumstat(unstagedNumstat),
            untrackedStats: new Map(),
          }),
        };
      }),
    );

  const changeGroupsHaveFiles = (groups: readonly VcsPanelChangeGroup[]) =>
    groups.some((group) => group.files.length > 0);

  const commitFiles = (cwd: string, sha: string) =>
    Effect.all(
      [
        run("vcs.panel.commitNumstat", cwd, [
          "show",
          "--format=",
          "--numstat",
          "-z",
          "--find-renames",
          sha,
        ]),
        run("vcs.panel.commitNameStatus", cwd, [
          "show",
          "--format=",
          "--name-status",
          "-z",
          "--find-renames",
          sha,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        parseFileChangesFromNumstat({
          numstat,
          statuses: parseNameStatus(nameStatus),
        }),
      ),
      Effect.orElseSucceed(() => []),
    );

  const commitRefsBySha = (cwd: string, commits: VcsPanelSnapshotResult["recentCommits"]) => {
    const commitShas = new Set(commits.map((commit) => commit.sha));
    if (commitShas.size === 0) {
      return Effect.succeed(
        new Map<
          string,
          { readonly headRefs: readonly string[]; readonly tags: readonly string[] }
        >(),
      );
    }

    return run("vcs.panel.commitRefs", cwd, [
      "for-each-ref",
      "--format=%(objectname)%09%(*objectname)%09%(refname:short)%09%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]).pipe(
      Effect.map((output) => {
        const refs = new Map<
          string,
          { readonly headRefs: readonly string[]; readonly tags: readonly string[] }
        >();
        for (const line of output.split(/\r?\n/u)) {
          const [objectName, peeledObjectName, shortRefName, fullRefName] = line.split("\t");
          const sha = peeledObjectName || objectName;
          if (!sha || !shortRefName || !fullRefName || !commitShas.has(sha)) continue;
          if (shortRefName.endsWith("/HEAD") || shortRefName.includes(" -> ")) continue;
          if (fullRefName.startsWith("refs/remotes/") && !shortRefName.includes("/")) continue;

          const current = refs.get(sha) ?? { headRefs: [], tags: [] };
          if (fullRefName.startsWith("refs/tags/")) {
            refs.set(sha, {
              headRefs: current.headRefs,
              tags: [...current.tags, shortRefName].toSorted((left, right) =>
                left.localeCompare(right),
              ),
            });
            continue;
          }
          refs.set(sha, {
            headRefs: [...current.headRefs, shortRefName].toSorted((left, right) =>
              left.localeCompare(right),
            ),
            tags: current.tags,
          });
        }
        return refs;
      }),
      Effect.orElseSucceed(
        () =>
          new Map<
            string,
            { readonly headRefs: readonly string[]; readonly tags: readonly string[] }
          >(),
      ),
    );
  };

  const withCommitDetails = (cwd: string, commits: VcsPanelSnapshotResult["recentCommits"]) =>
    commitRefsBySha(cwd, commits).pipe(
      Effect.flatMap((refsBySha) =>
        Effect.forEach(
          commits,
          (commit) =>
            commitFiles(cwd, commit.sha).pipe(
              Effect.map((files) => ({
                ...commit,
                ...(refsBySha.get(commit.sha) ?? { headRefs: [], tags: [] }),
                files,
              })),
            ),
          { concurrency: 2 },
        ),
      ),
    );

  const parseCount = (value: string) => {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const countCommitsForRange = (cwd: string, range: string) =>
    run("vcs.panel.branchCommitCount", cwd, ["rev-list", "--count", range]).pipe(
      Effect.map(parseCount),
      Effect.orElseSucceed(() => 0),
    );

  const countAheadBehindForRefs = (cwd: string, leftRef: string, rightRef: string) =>
    run("vcs.panel.branchForkAheadBehind", cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${leftRef}...${rightRef}`,
    ]).pipe(
      Effect.map(parseAheadBehindCounts),
      Effect.orElseSucceed(() => ({ aheadCount: 0, behindCount: 0 })),
    );

  const refsShareAncestry = (cwd: string, leftRef: string, rightRef: string) =>
    run("vcs.panel.branchForkMergeBase", cwd, ["merge-base", leftRef, rightRef], {
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

  const actionableForkBranches = (
    cwd: string,
    localBranches: readonly VcsRef[],
    remotes: readonly VcsPanelRemote[],
  ): Effect.Effect<readonly VcsPanelActionableForkBranch[], never> => {
    const uniqueForks = (
      forks: readonly VcsPanelActionableForkBranch[],
    ): readonly VcsPanelActionableForkBranch[] => {
      const byKey = new Map<string, VcsPanelActionableForkBranch>();
      for (const fork of forks) {
        const key = `${fork.localBranchName}\0${fork.remoteRefName}`;
        const existing = byKey.get(key);
        if (!existing || fork.behindCount > existing.behindCount) {
          byKey.set(key, fork);
        }
      }
      return [...byKey.values()].toSorted((left, right) => {
        const activity = branchActivityTime(right) - branchActivityTime(left);
        return activity !== 0
          ? activity
          : `${left.remoteName}/${left.remoteBranchName}`.localeCompare(
              `${right.remoteName}/${right.remoteBranchName}`,
            );
      });
    };

    const candidates =
      remotes.length < 2
        ? []
        : localBranches.flatMap((localBranch) =>
            remotes.flatMap((remote) =>
              remote.branches
                .filter((remoteBranch) => remoteBranch.name === localBranch.name)
                .filter((remoteBranch) => localBranch.upstreamName !== remoteBranch.fullRefName)
                .map((remoteBranch) => ({ localBranch, remote, remoteBranch })),
            ),
          );
    const sameNameForks = Effect.forEach(
      candidates,
      ({ localBranch, remote, remoteBranch }) =>
        Effect.gen(function* () {
          const shareAncestry = yield* refsShareAncestry(
            cwd,
            localBranch.name,
            remoteBranch.fullRefName,
          );
          if (!shareAncestry) return null;
          const counts = yield* countAheadBehindForRefs(
            cwd,
            localBranch.name,
            remoteBranch.fullRefName,
          );
          if (counts.behindCount <= 0) return null;
          const fork = {
            localBranchName: localBranch.name,
            remoteName: remote.name,
            remoteBranchName: remoteBranch.name,
            remoteRefName: remoteBranch.fullRefName,
            aheadCount: counts.aheadCount,
            behindCount: counts.behindCount,
          };
          return {
            ...fork,
            ...(remoteBranch.lastActivityAt ? { lastActivityAt: remoteBranch.lastActivityAt } : {}),
          } satisfies VcsPanelActionableForkBranch;
        }),
      { concurrency: 4 },
    ).pipe(Effect.map((forks) => forks.flatMap((fork) => (fork ? [fork] : []))));

    const pullRequestForks = Effect.forEach(
      remotes,
      (remote) => {
        const context = providerContextForRemote(remote);
        if (!context || !sourceControlProviders) {
          return Effect.succeed<readonly VcsPanelActionableForkBranch[]>([]);
        }

        return sourceControlProviders.get(context.provider.kind).pipe(
          Effect.flatMap((provider) =>
            Effect.forEach(
              localBranches,
              (localBranch) =>
                provider
                  .listChangeRequests({
                    cwd,
                    context,
                    headSelector: localBranch.name,
                    state: "open",
                    limit: 20,
                  })
                  .pipe(
                    Effect.flatMap((changeRequests) =>
                      Effect.forEach(
                        changeRequests,
                        (changeRequest) =>
                          actionableForkForChangeRequest(cwd, localBranch, remote, changeRequest),
                        { concurrency: 4 },
                      ),
                    ),
                    Effect.map((forks) => forks.flatMap((fork) => (fork ? [fork] : []))),
                    Effect.orElseSucceed(() => []),
                  ),
              { concurrency: 4 },
            ),
          ),
          Effect.map((forks) => forks.flat()),
          Effect.orElseSucceed(() => []),
        );
      },
      { concurrency: 2 },
    ).pipe(Effect.map((forks) => forks.flat()));

    return Effect.all([sameNameForks, pullRequestForks], { concurrency: "unbounded" }).pipe(
      Effect.map(([forks, prForks]) => uniqueForks([...forks, ...prForks])),
      Effect.orElseSucceed(() => []),
    );
  };

  const actionableForkForChangeRequest = (
    cwd: string,
    localBranch: VcsRef,
    remote: VcsPanelRemote,
    changeRequest: ChangeRequest,
  ): Effect.Effect<VcsPanelActionableForkBranch | null, never> => {
    if (changeRequest.headRefName !== localBranch.name) return Effect.succeed(null);
    const remoteBranch = remote.branches.find(
      (branch) => branch.name === changeRequest.baseRefName,
    );
    if (!remoteBranch) return Effect.succeed(null);

    return Effect.gen(function* () {
      const shareAncestry = yield* refsShareAncestry(
        cwd,
        localBranch.name,
        remoteBranch.fullRefName,
      );
      if (!shareAncestry) return null;
      const counts = yield* countAheadBehindForRefs(
        cwd,
        localBranch.name,
        remoteBranch.fullRefName,
      );
      if (counts.behindCount <= 0) return null;
      const fork = {
        localBranchName: localBranch.name,
        remoteName: remote.name,
        remoteBranchName: remoteBranch.name,
        remoteRefName: remoteBranch.fullRefName,
        aheadCount: counts.aheadCount,
        behindCount: counts.behindCount,
      };
      return {
        ...fork,
        ...(remoteBranch.lastActivityAt ? { lastActivityAt: remoteBranch.lastActivityAt } : {}),
      } satisfies VcsPanelActionableForkBranch;
    }).pipe(Effect.orElseSucceed(() => null));
  };

  const commitShasForRange = (cwd: string, range: string) =>
    run("vcs.panel.branchCommitShas", cwd, ["rev-list", range]).pipe(
      Effect.map((output) =>
        output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
      Effect.orElseSucceed(() => []),
    );

  const commitsForRange = (
    cwd: string,
    range: string,
    maxCount: number,
    skip = 0,
  ): Effect.Effect<VcsPanelSnapshotResult["recentCommits"], GitCommandError> =>
    run("vcs.panel.branchCommits", cwd, [
      "log",
      `--skip=${skip}`,
      `--max-count=${maxCount}`,
      "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
      range,
    ]).pipe(
      Effect.map(parseCommits),
      Effect.flatMap((commits) => withCommitDetails(cwd, commits)),
    );

  const branchCommits = (
    cwd: string,
    branch: VcsRef,
    baseRef: string | null | undefined,
    kind: VcsPanelBranchCommitsInput["kind"],
    skip: number,
    limit: number,
  ): Effect.Effect<VcsPanelBranchCommitsResult, GitCommandError> =>
    Effect.gen(function* () {
      const refName = branch.name;
      const historyRef = yield* branchCommitRange(baseRef ?? null, refName, kind ?? "history");
      if (!historyRef) {
        return {
          commits: [],
          remaining: 0,
        };
      }
      const [total, commits] = yield* Effect.all(
        [countCommitsForRange(cwd, historyRef), commitsForRange(cwd, historyRef, limit, skip)],
        { concurrency: "unbounded" },
      );
      return {
        commits,
        remaining: Math.max(0, total - skip - commits.length),
      };
    });

  const stashDetails = (
    cwd: string,
    stashRef: string,
  ): Effect.Effect<VcsPanelStashDetails, GitCommandError> =>
    Effect.all(
      [
        run("vcs.panel.stashNumstat", cwd, [
          "stash",
          "show",
          "--numstat",
          "-z",
          "--find-renames",
          "--include-untracked",
          stashRef,
        ]),
        run("vcs.panel.stashNameStatus", cwd, [
          "stash",
          "show",
          "--name-status",
          "-z",
          "--find-renames",
          "--include-untracked",
          stashRef,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        parseFileChangesFromNumstat({
          numstat,
          statuses: parseNameStatus(nameStatus),
        }),
      ),
      Effect.orElseSucceed(() => []),
      Effect.map((files) => ({
        refName: stashRef,
        files,
      })),
    );

  const generatedStashMessage = (
    cwd: string,
    mode: "all" | "staged" | "unstaged",
    paths?: readonly string[],
  ): Effect.Effect<string, never> =>
    Effect.gen(function* () {
      const fallback = `T3 Code ${mode} stash`;
      const diffArgs =
        mode === "staged"
          ? (["diff", "--cached", "--stat"] as const)
          : (["diff", "--stat"] as const);
      const patchArgs =
        mode === "staged"
          ? (["diff", "--cached", "--no-ext-diff", "--patch", "--minimal"] as const)
          : (["diff", "--no-ext-diff", "--patch", "--minimal"] as const);
      const pathArgs = paths && paths.length > 0 ? (["--", ...paths] as const) : [];
      const [settings, summary, patch, status] = yield* Effect.all(
        [
          serverSettings.getSettings,
          run("vcs.panel.stashMessageSummary", cwd, [...diffArgs, ...pathArgs]),
          run("vcs.panel.stashMessagePatch", cwd, [...patchArgs, ...pathArgs]),
          run("vcs.panel.stashMessageStatus", cwd, ["status", "--short"]),
        ],
        { concurrency: "unbounded" },
      );
      const stagedSummary = [summary.trim(), status.trim()].filter(Boolean).join("\n");
      if (!textGeneration) return fallback;
      if (stagedSummary.length === 0 && patch.trim().length === 0) return fallback;
      const generated = yield* textGeneration.generateCommitMessage({
        cwd,
        branch: null,
        stagedSummary: stagedSummary.slice(0, 8_000),
        stagedPatch: patch.slice(0, 50_000),
        modelSelection: settings.textGenerationModelSelection,
      });
      return generated.subject.trim() || fallback;
    }).pipe(Effect.orElseSucceed(() => `T3 Code ${mode} stash`));

  const generatedCommitMessage = (
    cwd: string,
    paths?: readonly string[],
  ): Effect.Effect<string, never> =>
    Effect.gen(function* () {
      const fallback = "T3 Code changes";
      const pathArgs = paths && paths.length > 0 ? (["--", ...paths] as const) : [];
      const [settings, summary, patch] = yield* Effect.all(
        [
          serverSettings.getSettings,
          run("vcs.panel.commitMessageSummary", cwd, ["diff", "--cached", "--stat", ...pathArgs]),
          run("vcs.panel.commitMessagePatch", cwd, [
            "diff",
            "--cached",
            "--no-ext-diff",
            "--patch",
            "--minimal",
            ...pathArgs,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      if (!textGeneration) return fallback;
      if (summary.trim().length === 0 && patch.trim().length === 0) return fallback;
      const generated = yield* textGeneration.generateCommitMessage({
        cwd,
        branch: null,
        stagedSummary: summary.slice(0, 8_000),
        stagedPatch: patch.slice(0, 50_000),
        modelSelection: settings.textGenerationModelSelection,
      });
      return generated.subject.trim() || fallback;
    }).pipe(Effect.orElseSucceed(() => "T3 Code changes"));

  const compareFiles = (cwd: string, baseRef: string | null, refName: string) => {
    if (!baseRef) return Effect.succeed([]);
    return Effect.all(
      [
        run("vcs.panel.branchCompareNumstat", cwd, [
          "diff",
          "--numstat",
          "-z",
          "--find-renames",
          `${baseRef}...${refName}`,
        ]),
        run("vcs.panel.branchCompareNameStatus", cwd, [
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          `${baseRef}...${refName}`,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        parseFileChangesFromNumstat({
          numstat,
          statuses: parseNameStatus(nameStatus),
        }),
      ),
      Effect.orElseSucceed(() => []),
    );
  };

  const branchCommitRange = (
    baseRef: string | null,
    refName: string,
    kind: NonNullable<VcsPanelBranchCommitsInput["kind"]>,
  ) => {
    switch (kind) {
      case "ahead":
        return Effect.succeed(baseRef ? `${baseRef}..${refName}` : "");
      case "behind":
        return Effect.succeed(baseRef ? `${refName}..${baseRef}` : "");
      case "compare-history":
        return Effect.succeed(baseRef ? `${baseRef}...${refName}` : refName);
      case "history":
        return Effect.succeed(refName);
    }
  };

  const upstreamForRef = (cwd: string, refName: string) =>
    run("vcs.panel.branchUpstream", cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${refName}@{upstream}`,
    ]).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => ""),
      Effect.map((value) => (value.length > 0 ? value : null)),
    );

  const refExists = (operation: string, cwd: string, refName: string) =>
    run(operation, cwd, ["show-ref", "--verify", refName], { allowNonZeroExit: true }).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

  const resolveRemoteBranchRef = (refName: string, remoteNamesByLength: readonly string[]) => {
    const parsed = parseRemoteRefWithRemoteNames(refName, remoteNamesByLength);
    if (!parsed) return null;
    return {
      remoteName: parsed.remoteName,
      branchName: parsed.branchName,
    };
  };

  const createdFromRef = (cwd: string, refName: string) =>
    run("vcs.panel.branchCreatedFrom", cwd, [
      "reflog",
      "show",
      "--format=%gs",
      "--max-count=20",
      refName,
    ]).pipe(
      Effect.map(parseCreatedFromRef),
      Effect.orElseSucceed(() => null),
    );

  const branchDetails = (
    cwd: string,
    branch: VcsRef,
    defaultCompareRef: string | null,
    compareBaseRef?: string,
  ): Effect.Effect<VcsPanelBranchDetails, GitCommandError> =>
    Effect.gen(function* () {
      const refName = branch.name;
      const upstreamRef = branch.isRemote ? null : yield* upstreamForRef(cwd, refName);
      const createdBaseRef = upstreamRef ? null : yield* createdFromRef(cwd, refName);
      const baseRef =
        compareBaseRef ??
        upstreamRef ??
        createdBaseRef ??
        (!branch.isDefault ? defaultCompareRef : null);
      const unsyncedBaseRef = branch.isRemote ? null : (upstreamRef ?? defaultCompareRef);
      const historyRef = refName;
      const [
        aheadCommits,
        aheadCommitTotal,
        behindCommits,
        behindCommitTotal,
        totalCommits,
        commits,
        files,
        unsyncedCommitShas,
      ] = yield* Effect.all(
        [
          baseRef
            ? commitsForRange(cwd, `${baseRef}..${refName}`, COMMIT_PAGE_SIZE)
            : Effect.succeed([]),
          baseRef ? countCommitsForRange(cwd, `${baseRef}..${refName}`) : Effect.succeed(0),
          baseRef
            ? commitsForRange(cwd, `${refName}..${baseRef}`, COMMIT_PAGE_SIZE)
            : Effect.succeed([]),
          baseRef ? countCommitsForRange(cwd, `${refName}..${baseRef}`) : Effect.succeed(0),
          countCommitsForRange(cwd, historyRef),
          commitsForRange(cwd, historyRef, COMMIT_PAGE_SIZE),
          compareFiles(cwd, baseRef, refName),
          unsyncedBaseRef
            ? commitShasForRange(cwd, `${unsyncedBaseRef}..${refName}`)
            : Effect.succeed([]),
        ],
        { concurrency: "unbounded" },
      );
      return {
        name: branch.name,
        fullRefName: branch.name,
        isRemote: branch.isRemote === true,
        remoteName: branch.remoteName ?? null,
        current: branch.current,
        isDefault: branch.isDefault,
        worktreePath: branch.worktreePath,
        upstreamRef,
        baseRef,
        unsyncedCommitShas,
        aheadCommits,
        aheadCommitsRemaining: Math.max(0, aheadCommitTotal - aheadCommits.length),
        behindCommits,
        behindCommitsRemaining: Math.max(0, behindCommitTotal - behindCommits.length),
        compareCommits: [],
        compareCommitsRemaining: 0,
        commits,
        commitsRemaining: Math.max(0, totalCommits - commits.length),
        compareFiles: files,
      };
    });

  const unstagedFilesWithUntrackedRenames = (cwd: string, untrackedPaths: readonly string[]) =>
    Effect.gen(function* () {
      if (untrackedPaths.length === 0) return null;

      return yield* withTemporaryIntentToAddIndex(
        {
          cwd,
          paths: untrackedPaths,
          operations: {
            gitIndexPath: "vcs.panel.gitIndexPath",
            tempIndexReadTree: "vcs.panel.tempIndexReadTree",
            tempIndexIntentToAdd: "vcs.panel.tempIndexIntentToAdd",
          },
        },
        (env) =>
          Effect.gen(function* () {
            const [nameStatus, numstat] = yield* Effect.all(
              [
                run(
                  "vcs.panel.unstagedNameStatusWithUntracked",
                  cwd,
                  ["diff", "--name-status", "-z", "--find-renames=20%"],
                  { env },
                ),
                run(
                  "vcs.panel.unstagedNumstatWithUntracked",
                  cwd,
                  ["diff", "--numstat", "-z", "--find-renames=20%"],
                  { env },
                ),
              ],
              { concurrency: "unbounded" },
            );
            return parseFileChangesFromNumstat({
              numstat,
              statuses: parseNameStatus(nameStatus),
            });
          }),
      );
    }).pipe(Effect.orElseSucceed(() => null));

  const enrichWorkingTreeFiles: SourceControlPanelService["Service"]["enrichWorkingTreeFiles"] =
    Effect.fn("enrichWorkingTreeFiles")(function* (input) {
      const requestedPaths = uniquePaths(input.paths);
      const [porcelain, unstagedNumstat] = yield* Effect.all(
        [
          run("vcs.panel.enrichWorkingTreeFiles.statusPorcelain", input.cwd, [
            "status",
            "--porcelain=2",
            "--branch",
            "-uall",
          ]),
          run("vcs.panel.enrichWorkingTreeFiles.unstagedNumstat", input.cwd, [
            "diff",
            "--numstat",
            "-z",
            "--find-renames=20%",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      const requestedPathSet = new Set(requestedPaths);
      const untrackedPaths = untrackedPathsFromPorcelain(porcelain);
      const untrackedPathSet = new Set(untrackedPaths);
      const unstagedFiles = unstagedFilesFromPorcelainStatus({
        status: porcelain,
        unstagedStats: parseNumstat(unstagedNumstat),
      });
      const deletedPathSet = new Set(
        unstagedFiles.filter((file) => file.status === "deleted").map((file) => file.path),
      );
      const requestedUntrackedPaths = requestedPaths.filter((path) => untrackedPathSet.has(path));
      const requestedDeletedPaths = requestedPaths.filter((path) => deletedPathSet.has(path));
      const renameCandidateUntrackedPaths =
        requestedDeletedPaths.length > 0 ? untrackedPaths : requestedUntrackedPaths;

      const [untrackedStats, renameCandidates] = yield* Effect.all(
        [
          Effect.forEach(
            requestedUntrackedPaths,
            (path) =>
              run(
                "vcs.panel.enrichWorkingTreeFiles.untrackedNumstat",
                input.cwd,
                ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path],
                { allowNonZeroExit: true },
              ).pipe(
                Effect.map(parseNumstat),
                Effect.orElseSucceed(() => new Map()),
              ),
            { concurrency: 4 },
          ).pipe(Effect.map((stats) => mergeNumstats(stats))),
          unstagedFilesWithUntrackedRenames(input.cwd, renameCandidateUntrackedPaths),
        ],
        { concurrency: "unbounded" },
      );

      const filesByPath = new Map<string, VcsPanelFileChange>();
      const hiddenPaths = new Set<string>();
      for (const file of renameCandidates ?? []) {
        if (file.status !== "renamed" || !file.originalPath) continue;
        if (!requestedPathSet.has(file.path) && !requestedPathSet.has(file.originalPath)) continue;
        filesByPath.set(file.path, file);
        hiddenPaths.add(file.originalPath);
      }

      for (const path of requestedUntrackedPaths) {
        if (filesByPath.has(path)) continue;
        const stats = untrackedStats.get(path);
        filesByPath.set(path, {
          path,
          originalPath: null,
          status: "untracked",
          insertions: stats?.insertions ?? 0,
          deletions: stats?.deletions ?? 0,
        });
      }
      for (const file of unstagedFiles) {
        if (file.status !== "deleted") continue;
        if (
          !requestedPathSet.has(file.path) ||
          hiddenPaths.has(file.path) ||
          filesByPath.has(file.path)
        ) {
          continue;
        }
        filesByPath.set(file.path, file);
      }

      return {
        files: [...filesByPath.values()].toSorted((left, right) =>
          left.path.localeCompare(right.path),
        ),
        hiddenPaths: [...hiddenPaths].toSorted((left, right) => left.localeCompare(right)),
      };
    });

  const snapshot: SourceControlPanelService["Service"]["snapshot"] = Effect.fn("snapshot")(
    function* (input) {
      const [
        localStatus,
        localBranchesOutput,
        worktreeListOutput,
        workingTree,
        remotesOutput,
        stashes,
      ] = yield* Effect.all(
        [
          workflow
            .status(input)
            .pipe(Effect.mapError(asGitCommandError("vcs.panel.status", input.cwd, ["status"]))),
          runResult("vcs.panel.localBranches", input.cwd, LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS, {
            allowNonZeroExit: true,
          }).pipe(
            Effect.flatMap((result) => {
              if (result.exitCode === 0) return Effect.succeed(result.stdout);
              const detail = result.stderr.trim() || result.stdout.trim();
              return isUnsupportedWorktreePathFormat(detail)
                ? run(
                    "vcs.panel.localBranches",
                    input.cwd,
                    LOCAL_BRANCHES_WITHOUT_WORKTREE_PATH_ARGS,
                  )
                : Effect.fail(
                    gitError(
                      "vcs.panel.localBranches",
                      input.cwd,
                      LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS,
                      detail,
                    ),
                  );
            }),
          ),
          run("vcs.panel.worktrees", input.cwd, ["worktree", "list", "--porcelain"], {
            allowNonZeroExit: true,
          }),
          readWorkingTreeChangeGroups(input.cwd),
          run("vcs.panel.remotes", input.cwd, ["remote", "-v"]),
          run("vcs.panel.stashes", input.cwd, [
            "stash",
            "list",
            "--format=%gd%x09%H%x09%cI%x09%gs",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      const localBranches = parseLocalBranches(
        localBranchesOutput,
        parseWorktreeBranchPaths(worktreeListOutput),
      );
      const remotes = parseRemoteVerbose(remotesOutput);
      const remotesWithBranches = yield* Effect.forEach(
        remotes,
        (remote) =>
          run("vcs.panel.remoteBranches", input.cwd, [
            "branch",
            "-r",
            "--list",
            `${remote.name}/*`,
            "--format=%(refname:short)%09%(committerdate:iso-strict)",
          ]).pipe(
            Effect.map((branchesOutput) => ({
              ...remote,
              branches: parseRemoteBranches(branchesOutput, remote.name),
            })),
            Effect.orElseSucceed(() => remote),
          ),
        { concurrency: "unbounded" },
      );
      const defaultCompareRef =
        localBranches.find((ref) => ref.isDefault)?.name ??
        localBranches.find((ref) => !ref.current)?.name ??
        null;
      const forkBranches = yield* actionableForkBranches(
        input.cwd,
        localBranches,
        remotesWithBranches,
      );
      const worktreeBranchEntries = parseWorktreeBranchEntries(worktreeListOutput);
      const worktreeChangeSets = yield* Effect.forEach(
        localBranches.filter((branch) => {
          if (branch.current || !branch.worktreePath) return false;
          if (path.resolve(branch.worktreePath) === path.resolve(input.cwd)) return false;
          return worktreeBranchEntries.some(
            (entry) =>
              entry.branchName === branch.name && entry.worktreePath === branch.worktreePath,
          );
        }),
        (branch) =>
          readWorkingTreeChangeGroups(branch.worktreePath!).pipe(
            Effect.map((result): VcsPanelWorktreeChangeSet | null =>
              changeGroupsHaveFiles(result.changeGroups)
                ? {
                    branchName: branch.name,
                    worktreePath: branch.worktreePath!,
                    current: false,
                    lastActivityAt: branch.lastActivityAt ?? null,
                    changeGroups: result.changeGroups,
                  }
                : null,
            ),
            Effect.orElseSucceed(() => null),
          ),
        { concurrency: 4 },
      ).pipe(
        Effect.map((sets) =>
          sets
            .filter((set): set is VcsPanelWorktreeChangeSet => set !== null)
            .toSorted((left, right) => {
              const leftTime = Date.parse(left.lastActivityAt ?? "");
              const rightTime = Date.parse(right.lastActivityAt ?? "");
              const activity =
                (Number.isFinite(rightTime) ? rightTime : 0) -
                (Number.isFinite(leftTime) ? leftTime : 0);
              return activity !== 0 ? activity : left.branchName.localeCompare(right.branchName);
            }),
        ),
      );
      return {
        status: panelStatusFromLocal(localStatus, workingTree.porcelain),
        changeGroups: workingTree.changeGroups,
        worktreeChangeSets,
        localBranches,
        branchDetails: [],
        remotes: remotesWithBranches,
        actionableForkBranches: forkBranches,
        stashes: parseStashes(stashes),
        recentCommits: [],
        defaultCompareRef,
      };
    },
  );

  const stageFiles: SourceControlPanelService["Service"]["stageFiles"] = (input) =>
    run("vcs.panel.stageFiles", input.cwd, ["add", "-A", "--", ...input.paths]).pipe(Effect.asVoid);

  const unstageFiles: SourceControlPanelService["Service"]["unstageFiles"] = (input) =>
    run("vcs.panel.unstageFiles", input.cwd, ["reset", "--", ...input.paths]).pipe(Effect.asVoid);

  const discardFiles: SourceControlPanelService["Service"]["discardFiles"] = (input) =>
    Effect.gen(function* () {
      const paths = uniquePaths(input.paths);
      if (paths.length === 0) return;
      if (input.staged) {
        const headPaths = yield* run(
          "vcs.panel.discardStagedFiles.listHeadPaths",
          input.cwd,
          ["ls-tree", "-r", "--name-only", "HEAD", "--", ...paths],
          { allowNonZeroExit: true },
        ).pipe(Effect.map(parsePathLines));
        const headPathSet = new Set(headPaths);
        const pathsInHead = paths.filter((path) => headPathSet.has(path));
        const pathsOutsideHead = paths.filter((path) => !headPathSet.has(path));

        if (pathsInHead.length > 0) {
          yield* run("vcs.panel.discardStagedFiles", input.cwd, [
            "restore",
            "--staged",
            "--worktree",
            "--source=HEAD",
            "--",
            ...pathsInHead,
          ]).pipe(Effect.asVoid);
        }
        if (pathsOutsideHead.length > 0) {
          yield* run("vcs.panel.discardStagedFiles.reset", input.cwd, [
            "reset",
            "--",
            ...pathsOutsideHead,
          ]).pipe(Effect.asVoid);
          yield* run("vcs.panel.discardStagedFiles.clean", input.cwd, [
            "clean",
            "-fd",
            "--",
            ...pathsOutsideHead,
          ]).pipe(Effect.asVoid);
        }
        return;
      }

      const trackedPaths = yield* run("vcs.panel.discardUnstagedFiles.listIndexPaths", input.cwd, [
        "ls-files",
        "--cached",
        "--",
        ...paths,
      ]).pipe(Effect.map(parsePathLines));
      if (trackedPaths.length > 0) {
        yield* run("vcs.panel.discardUnstagedFiles", input.cwd, [
          "restore",
          "--worktree",
          "--",
          ...trackedPaths,
        ]).pipe(Effect.asVoid);
      }
      yield* run("vcs.panel.cleanUntrackedFiles", input.cwd, ["clean", "-fd", "--", ...paths]).pipe(
        Effect.asVoid,
      );
    });

  const readFileDiff: SourceControlPanelService["Service"]["readFileDiff"] = Effect.fn(
    "readFileDiff",
  )(function* (input) {
    const source = input.source ?? {
      kind: "working-tree" as const,
      staged: input.staged ?? false,
    };
    const diffPaths = uniquePaths(
      input.originalPath ? [input.originalPath, input.path] : [input.path],
    );
    if (source.kind === "commit") {
      const patch = yield* run("vcs.panel.readCommitFileDiff", input.cwd, [
        "show",
        "--format=",
        "--no-ext-diff",
        "--patch",
        "--minimal",
        source.sha,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }
    if (source.kind === "compare") {
      const patch = yield* run("vcs.panel.readCompareFileDiff", input.cwd, [
        "diff",
        "--no-ext-diff",
        "--patch",
        "--minimal",
        `${source.baseRef}...${source.refName}`,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }
    if (source.kind === "stash") {
      const patch = yield* run("vcs.panel.readStashFileDiff", input.cwd, [
        "stash",
        "show",
        "--patch",
        "--include-untracked",
        source.stashRef,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }

    const args = source.staged
      ? [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--patch",
          "--minimal",
          "--find-renames=20%",
          "--",
          ...diffPaths,
        ]
      : ["diff", "--no-ext-diff", "--patch", "--minimal", "--find-renames=20%", "--", ...diffPaths];
    let patch =
      !source.staged && input.originalPath
        ? yield* withTemporaryIntentToAddIndex(
            {
              cwd: input.cwd,
              paths: [input.path],
              operations: {
                gitIndexPath: "vcs.panel.readFileDiff.gitIndexPath",
                tempIndexReadTree: "vcs.panel.readFileDiff.tempIndexReadTree",
                tempIndexIntentToAdd: "vcs.panel.readFileDiff.tempIndexIntentToAdd",
              },
            },
            (env) => run("vcs.panel.readFileDiff", input.cwd, args, { env }),
          ).pipe(Effect.catch(() => run("vcs.panel.readFileDiff", input.cwd, args)))
        : yield* run("vcs.panel.readFileDiff", input.cwd, args);
    if (!source.staged && patch.trim().length === 0) {
      patch = yield* run(
        "vcs.panel.readUntrackedFileDiff",
        input.cwd,
        ["diff", "--no-index", "--", "/dev/null", input.path],
        { allowNonZeroExit: true },
      );
    }
    return { path: input.path, staged: source.staged, patch };
  });

  const pushBranchDirect = Effect.fn("pushBranchDirect")(function* (
    cwd: string,
    branchName: string,
    force: boolean,
    publishRemoteName?: string,
  ) {
    const upstream = publishRemoteName ? "" : ((yield* upstreamForRef(cwd, branchName)) ?? "");
    const remoteNames =
      upstream.length > 0
        ? yield* run("vcs.panel.pushBranch.remotes", cwd, ["remote"]).pipe(
            Effect.map(parseRemoteNames),
            Effect.orElseSucceed((): readonly string[] => []),
          )
        : [];
    const parsedUpstream =
      upstream.length > 0 ? parseRemoteRefWithRemoteNames(upstream, remoteNames) : null;
    const fallbackUpstreamParts = parsedUpstream ? [] : upstream.split("/");
    const upstreamRemoteName = parsedUpstream?.remoteName ?? fallbackUpstreamParts[0] ?? "origin";
    const upstreamBranchName =
      (parsedUpstream?.branchName ?? fallbackUpstreamParts.slice(1).join("/")) || branchName;
    const hasSameNameUpstream = upstream.length > 0 && upstreamBranchName === branchName;
    const remoteName = publishRemoteName ?? (hasSameNameUpstream ? upstreamRemoteName : "origin");
    const remoteBranchName = hasSameNameUpstream ? upstreamBranchName : branchName;
    yield* run("vcs.panel.pushBranch", cwd, [
      "push",
      ...(force ? ["--force-with-lease"] : []),
      "-u",
      remoteName,
      `${branchName}:refs/heads/${remoteBranchName}`,
    ]).pipe(Effect.asVoid);
  });

  const commitStaged: SourceControlPanelService["Service"]["commitStaged"] = Effect.fn(
    "commitStaged",
  )(function* (input) {
    const paths = uniquePaths(input.paths ?? []);
    const message = input.message?.trim() || (yield* generatedCommitMessage(input.cwd, paths));
    const args = ["commit", "-m", message];
    yield* run("vcs.panel.commitStaged", input.cwd, args).pipe(Effect.asVoid);
    if (input.push) {
      const status = yield* workflow
        .status({ cwd: input.cwd })
        .pipe(
          Effect.mapError(
            asGitCommandError("vcs.panel.commitStaged.status", input.cwd, ["status"]),
          ),
        );
      if (!status.refName) {
        return yield* gitError(
          "vcs.panel.commitStaged.push",
          input.cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }
      yield* pushBranchDirect(input.cwd, status.refName, false);
    }
  });

  const pullBranch: SourceControlPanelService["Service"]["pullBranch"] = Effect.fn("pullBranch")(
    function* (input) {
      const status = yield* workflow
        .status({ cwd: input.cwd })
        .pipe(
          Effect.mapError(asGitCommandError("vcs.panel.pullBranch.status", input.cwd, ["status"])),
        );
      if (status.refName !== input.branchName) {
        if (input.merge) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull", "--no-rebase"],
            "Merge sync is only available for the current branch.",
          );
        }
        const upstream = yield* upstreamForRef(input.cwd, input.branchName);
        if (!upstream) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull"],
            `Branch ${input.branchName} has no upstream.`,
          );
        }
        const remoteOutput = yield* run("vcs.panel.pullBranch.remotes", input.cwd, ["remote"]);
        const resolvedUpstream = resolveRemoteBranchRef(upstream, parseRemoteNames(remoteOutput));
        if (!resolvedUpstream) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull"],
            `Branch ${input.branchName} has invalid upstream ${upstream}.`,
          );
        }
        yield* run("vcs.panel.pullBranch.nonCurrent", input.cwd, [
          "fetch",
          resolvedUpstream.remoteName,
          `${input.force ? "+" : ""}refs/heads/${resolvedUpstream.branchName}:refs/heads/${input.branchName}`,
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      if (input.force) {
        yield* run("vcs.panel.forcePullBranch", input.cwd, ["fetch"]);
        const upstream = yield* run("vcs.panel.forcePullBranch.upstream", input.cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).pipe(Effect.map((value) => value.trim()));
        yield* run("vcs.panel.forcePullBranch.reset", input.cwd, [
          "reset",
          "--hard",
          upstream,
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      if (input.merge) {
        const upstream = yield* run("vcs.panel.mergePullBranch.upstream", input.cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).pipe(Effect.map((value) => value.trim()));
        yield* run("vcs.panel.mergePullBranch", input.cwd, [
          "pull",
          "--no-rebase",
          "--no-edit",
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      return yield* workflow.pullCurrentBranch(input.cwd);
    },
  );

  const pushBranch: SourceControlPanelService["Service"]["pushBranch"] = Effect.fn("pushBranch")(
    function* (input) {
      yield* pushBranchDirect(input.cwd, input.branchName, input.force ?? false, input.remoteName);
    },
  );

  const fetchBranch: SourceControlPanelService["Service"]["fetchBranch"] = Effect.fn("fetchBranch")(
    function* (input) {
      const remoteOutput = yield* run("vcs.panel.fetchBranch.remotes", input.cwd, ["remote"]);
      const gitOrderRemoteNames = parseRemoteNamesInGitOrder(remoteOutput);
      const sortedRemoteNames = parseRemoteNames(remoteOutput);
      // Local branches intentionally win over same-named remote refs.
      const isLocalBranch = yield* refExists(
        "vcs.panel.fetchBranch.localBranch",
        input.cwd,
        `refs/heads/${input.branchName}`,
      );
      const parsedRemoteBranch = isLocalBranch
        ? null
        : parseRemoteRefWithRemoteNames(input.branchName, sortedRemoteNames);
      const isRemoteBranch = parsedRemoteBranch
        ? yield* refExists(
            "vcs.panel.fetchBranch.remoteBranch",
            input.cwd,
            `refs/remotes/${parsedRemoteBranch.remoteRef}`,
          )
        : false;
      const upstream =
        isRemoteBranch && parsedRemoteBranch
          ? parsedRemoteBranch.remoteRef
          : yield* upstreamForRef(input.cwd, input.branchName);
      const resolvedUpstream = upstream
        ? resolveRemoteBranchRef(upstream, sortedRemoteNames)
        : null;
      if (upstream && !resolvedUpstream) {
        return yield* gitError(
          "vcs.panel.fetchBranch",
          input.cwd,
          ["fetch"],
          `Branch ${input.branchName} has invalid upstream ${upstream}.`,
        );
      }
      const remoteName = resolvedUpstream?.remoteName ?? gitOrderRemoteNames[0] ?? "origin";
      const remoteBranchName = resolvedUpstream?.branchName ?? input.branchName;
      yield* run("vcs.panel.fetchBranch", input.cwd, [
        "fetch",
        remoteName,
        `refs/heads/${remoteBranchName}:refs/remotes/${remoteName}/${remoteBranchName}`,
      ]).pipe(Effect.asVoid);
    },
  );

  const deleteBranch: SourceControlPanelService["Service"]["deleteBranch"] = Effect.fn(
    "deleteBranch",
  )(function* (input) {
    const panelSnapshot = yield* snapshot({ cwd: input.cwd });
    const localBranch = panelSnapshot.localBranches.find(
      (branch) => branch.name === input.branchName,
    );
    if (localBranch?.current) {
      return yield* gitError(
        "vcs.panel.deleteBranch",
        input.cwd,
        ["branch", "-d", input.branchName],
        "Cannot delete the current branch.",
      );
    }
    if (localBranch) {
      yield* run("vcs.panel.deleteLocalBranch", input.cwd, [
        "branch",
        input.force ? "-D" : "-d",
        input.branchName,
      ]).pipe(Effect.asVoid);
      return;
    }
    const remoteBranch = panelSnapshot.remotes.flatMap((remote) =>
      remote.branches
        .filter(
          (branch) =>
            branch.fullRefName === input.branchName ||
            `${remote.name}/${branch.name}` === input.branchName,
        )
        .map((branch) => ({ remoteName: remote.name, branchName: branch.name })),
    )[0];
    if (remoteBranch) {
      yield* run("vcs.panel.deleteRemoteBranch", input.cwd, [
        "push",
        remoteBranch.remoteName,
        "--delete",
        remoteBranch.branchName,
      ]).pipe(Effect.asVoid);
      return;
    }
    return yield* gitError(
      "vcs.panel.deleteBranch",
      input.cwd,
      ["branch", input.force ? "-D" : "-d", input.branchName],
      `Branch ${input.branchName} was not found in the current source-control snapshot.`,
    );
  });

  const undoLatestCommit: SourceControlPanelService["Service"]["undoLatestCommit"] = Effect.fn(
    "undoLatestCommit",
  )(function* (input) {
    const currentBranch = yield* run("vcs.panel.currentBranch", input.cwd, [
      "branch",
      "--show-current",
    ]).pipe(Effect.map((branch) => branch.trim()));
    const targetBranch = input.branchName ?? currentBranch;
    const resetTarget = input.sha ? `${input.sha}^` : `${targetBranch || "HEAD"}~1`;

    if (!targetBranch || targetBranch === currentBranch) {
      yield* run("vcs.panel.undoLatestCommit", input.cwd, ["reset", "--soft", resetTarget]).pipe(
        Effect.asVoid,
      );
      return;
    }

    yield* run("vcs.panel.undoBranchCommit", input.cwd, [
      "branch",
      "-f",
      targetBranch,
      resetTarget,
    ]).pipe(Effect.asVoid);
  });

  const revertCommit: SourceControlPanelService["Service"]["revertCommit"] = (input) =>
    run("vcs.panel.revertCommit", input.cwd, ["revert", "--no-edit", input.sha]).pipe(
      Effect.asVoid,
    );

  const checkoutCommit: SourceControlPanelService["Service"]["checkoutCommit"] = Effect.fn(
    "checkoutCommit",
  )(function* (input) {
    yield* run("vcs.panel.checkoutCommit", input.cwd, ["checkout", "--detach", input.sha]).pipe(
      Effect.asVoid,
    );
    return { refName: input.sha };
  });

  const createBranchFromCommit: SourceControlPanelService["Service"]["createBranchFromCommit"] =
    Effect.fn("createBranchFromCommit")(function* (input) {
      const branchName = yield* validateGitPositionalName({
        operation: "vcs.panel.createBranchFromCommit",
        cwd: input.cwd,
        args: ["branch", "<name>", input.sha],
        kind: "Branch name",
        value: input.branchName ?? "",
      });
      yield* run("vcs.panel.createBranchFromCommit", input.cwd, [
        "branch",
        "--",
        branchName,
        input.sha,
      ]).pipe(Effect.asVoid);
      return { refName: branchName };
    });

  const mergeBranchIntoCurrent: SourceControlPanelService["Service"]["mergeBranchIntoCurrent"] = (
    input,
  ) =>
    run("vcs.panel.mergeBranchIntoCurrent", input.cwd, [
      "merge",
      "--no-edit",
      "--",
      input.refName,
    ]).pipe(Effect.asVoid);

  const rebaseCurrentOnto: SourceControlPanelService["Service"]["rebaseCurrentOnto"] = (input) =>
    run("vcs.panel.rebaseCurrentOnto", input.cwd, ["rebase", input.refName]).pipe(Effect.asVoid);

  return SourceControlPanelService.of({
    snapshot,
    branchDetails: (input) =>
      branchDetails(input.cwd, input.branch, input.defaultCompareRef, input.compareBaseRef),
    branchCommits: (input) =>
      branchCommits(input.cwd, input.branch, input.baseRef, input.kind, input.skip, input.limit),
    stashDetails: (input) => stashDetails(input.cwd, input.stashRef),
    stageFiles,
    unstageFiles,
    discardFiles,
    enrichWorkingTreeFiles,
    readFileDiff,
    commitStaged,
    pullBranch,
    pushBranch,
    deleteBranch,
    undoLatestCommit,
    revertCommit,
    checkoutCommit,
    createBranchFromCommit,
    mergeBranchIntoCurrent,
    rebaseCurrentOnto,
    fetchBranch,
    fetchRemote: (input) =>
      run("vcs.panel.fetchRemote", input.cwd, ["fetch", input.remoteName]).pipe(Effect.asVoid),
    fetchAllRemotes: (input) =>
      run("vcs.panel.fetchAllRemotes", input.cwd, ["fetch", "--all"]).pipe(Effect.asVoid),
    addRemote: (input) =>
      Effect.gen(function* () {
        const remoteName = yield* validateGitPositionalName({
          operation: "vcs.panel.addRemote",
          cwd: input.cwd,
          args: ["remote", "add", "<name>", input.url],
          kind: "Remote name",
          value: input.name,
        });
        yield* run("vcs.panel.addRemote", input.cwd, ["remote", "add", remoteName, input.url]).pipe(
          Effect.asVoid,
        );
      }),
    removeRemote: (input) =>
      Effect.gen(function* () {
        const remoteName = yield* validateGitPositionalName({
          operation: "vcs.panel.removeRemote",
          cwd: input.cwd,
          args: ["remote", "remove", "<name>"],
          kind: "Remote name",
          value: input.remoteName,
        });
        yield* run("vcs.panel.removeRemote", input.cwd, ["remote", "remove", remoteName]).pipe(
          Effect.asVoid,
        );
      }),
    createStash: (input) => {
      const mode = input.mode ?? "all";
      const modeArgs =
        mode === "staged"
          ? ["--staged"]
          : mode === "unstaged" || input.includeUntracked
            ? ["--include-untracked", ...(mode === "unstaged" ? ["--keep-index"] : [])]
            : [];
      return Effect.gen(function* () {
        const paths = input.paths ?? [];
        const pathArgs = paths.length > 0 ? ["--", ...paths] : [];
        const message =
          input.message?.trim() || (yield* generatedStashMessage(input.cwd, mode, paths));
        yield* run("vcs.panel.createStash", input.cwd, [
          "stash",
          "push",
          ...modeArgs,
          "-m",
          message,
          ...pathArgs,
        ]).pipe(Effect.asVoid);
      });
    },
    applyStash: (input) =>
      run("vcs.panel.applyStash", input.cwd, [
        "stash",
        "apply",
        input.stashRef ?? "stash@{0}",
      ]).pipe(Effect.asVoid),
    popStash: (input) =>
      run("vcs.panel.popStash", input.cwd, ["stash", "pop", input.stashRef ?? "stash@{0}"]).pipe(
        Effect.asVoid,
      ),
    dropStash: (input) =>
      run("vcs.panel.dropStash", input.cwd, ["stash", "drop", input.stashRef ?? "stash@{0}"]).pipe(
        Effect.asVoid,
      ),
    compare: (input) => {
      const left = targetRef(input.left);
      const right = targetRef(input.right);
      const range = left && right ? `${left}..${right}` : left || right;
      const args = range ? ["diff", "--no-ext-diff", "--patch", "--minimal", range] : ["diff"];
      return run("vcs.panel.compare", input.cwd, args).pipe(
        Effect.map((patch): VcsPanelCompareResult => ({ patch })),
      );
    },
  });
});

export const layer = Layer.effect(SourceControlPanelService, make());
