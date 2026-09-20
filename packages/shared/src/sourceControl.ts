import type {
  RepositoryIdentity,
  ChangeRequestState,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsRef,
} from "@t3tools/contracts";

export function isTerminalChangeRequestState(
  state: ChangeRequestState,
): state is "closed" | "merged" {
  return state === "closed" || state === "merged";
}

export type BranchSyncState = "fetch" | "pull" | "push" | "publish" | "diverged";

export type BranchAttentionKind =
  | "conflicts"
  | "diverged"
  | "behind"
  | "unpushed"
  | "dirty"
  | "stale";

export interface PanelChangedFile extends VcsPanelFileChange {
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly hasConflicts: boolean;
}

function mergedPanelFileStatus(
  statuses: ReadonlySet<VcsPanelFileChange["status"]>,
): VcsPanelFileChange["status"] {
  if (statuses.has("conflicted")) return "conflicted";
  if (statuses.has("deleted")) return "deleted";
  if (statuses.has("renamed")) return "renamed";
  if (statuses.has("copied")) return "copied";
  if (statuses.has("added")) return "added";
  if (statuses.has("untracked")) return "untracked";
  return "modified";
}

/** Shared presentation model for the web and native Version Control surfaces. */
export function mergePanelChangeGroups(groups: readonly VcsPanelChangeGroup[]): PanelChangedFile[] {
  const files = new Map<
    string,
    {
      originalPath: string | null;
      statuses: Set<VcsPanelFileChange["status"]>;
      insertions: number;
      deletions: number;
      hasStagedChanges: boolean;
      hasUnstagedChanges: boolean;
      hasConflicts: boolean;
    }
  >();

  for (const group of groups) {
    for (const file of group.files) {
      const existing = files.get(file.path) ?? {
        originalPath: file.originalPath,
        statuses: new Set<VcsPanelFileChange["status"]>(),
        insertions: 0,
        deletions: 0,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasConflicts: false,
      };
      existing.originalPath ??= file.originalPath;
      existing.statuses.add(file.status);
      existing.insertions += file.insertions;
      existing.deletions += file.deletions;
      existing.hasStagedChanges ||= group.kind === "staged";
      existing.hasUnstagedChanges ||= group.kind === "unstaged";
      existing.hasConflicts ||= group.kind === "conflicts";
      files.set(file.path, existing);
    }
  }

  return [...files.entries()]
    .map(([path, file]) => ({
      path,
      originalPath: file.originalPath,
      status: mergedPanelFileStatus(file.statuses),
      insertions: file.insertions,
      deletions: file.deletions,
      hasStagedChanges: file.hasStagedChanges,
      hasUnstagedChanges: file.hasUnstagedChanges,
      hasConflicts: file.hasConflicts,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function remoteBranchName(remoteRef: string, snapshot: VcsPanelSnapshotResult): string {
  const normalized = remoteRef.trim();
  const remote = [...snapshot.remotes]
    .sort((left, right) => right.name.length - left.name.length)
    .find((candidate) => normalized.startsWith(`${candidate.name}/`));
  if (remote) return normalized.slice(remote.name.length + 1);

  const separatorIndex = normalized.indexOf("/");
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

export function panelBranchSyncCounts(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
): { readonly aheadCount: number; readonly behindCount: number } {
  if (branch.current) {
    return {
      aheadCount: snapshot.status.aheadCount,
      behindCount: snapshot.status.behindCount,
    };
  }
  return {
    aheadCount: branch.aheadCount ?? 0,
    behindCount: branch.behindCount ?? 0,
  };
}

export function panelBranchHasUpstream(branch: VcsRef, snapshot: VcsPanelSnapshotResult): boolean {
  const upstreamName = branch.upstreamName?.trim();
  if (!upstreamName) return branch.current && snapshot.status.hasUpstream;
  return remoteBranchName(upstreamName, snapshot) === branch.name;
}

export function panelBranchSyncState(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
): BranchSyncState {
  const hasUpstream = panelBranchHasUpstream(branch, snapshot);
  const { aheadCount, behindCount } = panelBranchSyncCounts(branch, snapshot);
  if (!hasUpstream) return "publish";
  if (aheadCount > 0 && behindCount > 0) return "diverged";
  if (behindCount > 0) return "pull";
  if (aheadCount > 0) return "push";
  return "fetch";
}

export function panelBranchOperationCwd(branch: VcsRef, fallbackCwd: string): string {
  return branch.worktreePath ?? fallbackCwd;
}

export function panelBranchAttention(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
): BranchAttentionKind {
  const hasUpstream = panelBranchHasUpstream(branch, snapshot);
  const { aheadCount, behindCount } = panelBranchSyncCounts(branch, snapshot);
  if (!hasUpstream) return "unpushed";
  if (aheadCount > 0 && behindCount > 0) return "diverged";
  if (behindCount > 0) return "behind";
  if (aheadCount > 0) return "unpushed";
  return "stale";
}

export interface ChangeRequestPresentation {
  readonly icon: "github" | "gitlab" | "forgejo" | "azure-devops" | "bitbucket" | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  singular: "pull request",
};

const GITHUB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://github.com/owner/repo/pull/42",
};

const GITLAB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "gitlab",
  providerName: "GitLab",
  shortName: "MR",
  longName: "merge request",
  pluralLongName: "merge requests",
  providerLongName: "GitLab merge request",
  checkoutCommandExample: "glab mr checkout 123",
  urlExample: "https://gitlab.com/group/project/-/merge_requests/42",
};

const FORGEJO_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "forgejo",
  providerName: "Forgejo",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Forgejo pull request",
  checkoutCommandExample: "tea pr checkout 123",
  urlExample: "https://codeberg.org/owner/repo/pulls/42",
};

const AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "azure-devops",
  providerName: "Azure DevOps",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Azure DevOps pull request",
  checkoutCommandExample: "az repos pr checkout --id 123",
  urlExample: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
};

const BITBUCKET_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "bitbucket",
  providerName: "Bitbucket",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Bitbucket pull request",
  urlExample: "https://bitbucket.org/workspace/repo/pull-requests/42",
};

const GENERIC_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "change-request",
  providerName: "source control",
  shortName: "change request",
  longName: "change request",
  pluralLongName: "change requests",
  providerLongName: "change request",
  urlExample: "#42",
};

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  switch (provider?.kind) {
    case "github":
    case undefined:
      return GITHUB_CHANGE_REQUEST_PRESENTATION;
    case "gitlab":
      return GITLAB_CHANGE_REQUEST_PRESENTATION;
    case "forgejo":
      return FORGEJO_CHANGE_REQUEST_PRESENTATION;
    case "azure-devops":
      return AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION;
    case "bitbucket":
      return BITBUCKET_CHANGE_REQUEST_PRESENTATION;
    case "unknown":
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  if (!provider) {
    return DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  }

  const presentation = resolveChangeRequestPresentation(provider);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

export function getChangeRequestTerminologyForKind(
  kind: SourceControlProviderKind,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return SCP_SSH_REMOTE_PATTERN.test(trimmed) || trimmed.toLowerCase().startsWith("ssh://");
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const scpMatch = SCP_SSH_REMOTE_PATTERN.exec(trimmed);
  if (scpMatch?.[1]) {
    return scpMatch[1].toLowerCase();
  }

  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return null;
  }
}

function parseHostName(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/u, "").toLowerCase();
  }
}

function toBaseUrl(host: string): string {
  return `https://${host}`;
}

function hasDnsLabel(host: string, label: string): boolean {
  return host.split(".").includes(label);
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || hasDnsLabel(host, "github");
}

function isGitLabHost(host: string): boolean {
  return host === "gitlab.com" || hasDnsLabel(host, "gitlab");
}

function isAzureDevOpsHost(host: string): boolean {
  // `ssh.dev.azure.com` is the default Azure DevOps SSH clone host
  // (git@ssh.dev.azure.com:v3/org/project/repo), so match any `*.dev.azure.com`
  // subdomain, not just the bare `dev.azure.com`. Legacy hosts stay under
  // `.visualstudio.com` (including `vs-ssh.visualstudio.com`).
  return (
    host === "dev.azure.com" ||
    host.endsWith(".dev.azure.com") ||
    host.endsWith(".visualstudio.com")
  );
}

function isBitbucketHost(host: string): boolean {
  return host === "bitbucket.org" || hasDnsLabel(host, "bitbucket");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  const hostname = parseHostName(host);

  if (
    hostname === "codeberg.org" ||
    hasDnsLabel(hostname, "forgejo") ||
    hasDnsLabel(hostname, "gitea")
  ) {
    return {
      kind: "forgejo",
      name: "Forgejo",
      baseUrl: /^https?:/iu.test(remoteUrl.trim())
        ? new URL(remoteUrl.trim()).origin
        : toBaseUrl(host),
    };
  }

  if (isGitHubHost(hostname)) {
    return {
      kind: "github",
      name: hostname === "github.com" ? "GitHub" : "GitHub Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isGitLabHost(hostname)) {
    return {
      kind: "gitlab",
      name: hostname === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isAzureDevOpsHost(hostname)) {
    return {
      kind: "azure-devops",
      name: "Azure DevOps",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isBitbucketHost(hostname)) {
    return {
      kind: "bitbucket",
      name: hostname === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  return {
    kind: "unknown",
    name: host,
    baseUrl: toBaseUrl(host),
  };
}

/**
 * The provider-native repository selector. `displayName` is the full path below the host, which
 * is what nested GitLab groups need; owner/name is the two-segment fallback for identities
 * recorded before that field existed.
 *
 * Azure DevOps is the exception: `az repos pr list --repository` takes a repository name, and
 * takes the organisation and project from the checkout it detects — so the recorded
 * `org/project/_git/repo` path is refused outright and the whole repository reads as
 * unavailable. Its name is the last segment, which is what this hands over.
 *
 * One function because everything downstream is keyed by what it answers: the rows' own
 * `repository`, the per-repository cursors, and the detail and diff reads a row leads to.
 */
export function sourceControlRepositorySelector(
  identity:
    | Pick<RepositoryIdentity, "provider" | "displayName" | "owner" | "name">
    | null
    | undefined,
): string | null {
  if (!identity) return null;
  if (identity.provider === "azure-devops") {
    const segments = (identity.displayName ?? "").split("/").filter((part) => part !== "_git");
    return identity.name || segments.at(-1) || null;
  }
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}

/** Detail identity excludes working-tree changes, which cannot change committed history. */
export function panelBranchDetailsFingerprint(snapshot: VcsPanelSnapshotResult): string {
  return JSON.stringify([
    snapshot.refsFingerprint,
    snapshot.status.refName,
    snapshot.localBranches,
    snapshot.remotes,
    snapshot.actionableForkBranches,
    snapshot.defaultCompareRef,
  ]);
}
