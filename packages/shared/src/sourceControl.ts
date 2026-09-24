import type {
  RepositoryIdentity,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "@t3tools/contracts";

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

export function isSshRemoteUrl(remoteUrl: string): boolean {
  return parseGitRemote(remoteUrl)?.ssh === true;
}

export interface GitRemote {
  /** Lower case, with the port when the remote names one. */
  readonly host: string;
  /** Lower case, without the port. */
  readonly hostname: string;
  /** True for SSH remotes, whose port is the SSH daemon's and never the web host's. */
  readonly ssh: boolean;
  /** The repository path below the host, without `.git`. */
  readonly path: string;
}

/**
 * The host and path of a git remote: a URL of any scheme, or the SCP form `[user@]host:path`,
 * whose user is optional. Local paths (`/srv/repo.git`, `C:\repo`, `file://`) have no host and
 * give null.
 */
export function parseGitRemote(remoteUrl: string): GitRemote | null {
  const value = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      // `file://host/path` names a filesystem, not a server a provider could be signed in to.
      if (url.protocol === "file:" || url.host.length === 0) return null;
      return {
        host: url.host.toLowerCase(),
        hostname: url.hostname.toLowerCase(),
        // `git+ssh://` and `ssh+git://` are git's own spellings of `ssh://`.
        ssh: /^(?:ssh|git\+ssh|ssh\+git):$/u.test(url.protocol),
        path: url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""),
      };
    } catch {
      return null;
    }
  }
  // Git reads a drive letter, drive-relative `C:repo` included, as a local path, not an SCP host.
  if (/^[a-z]:/iu.test(value)) return null;
  const scp = /^(?:[^@/]+@)?(\[[^\]/]+\]|[^:/]+):([^/].*)$/u.exec(value);
  if (!scp?.[1] || !scp[2]) return null;
  const host = scp[1].toLowerCase();
  return { host, hostname: host, ssh: true, path: scp[2].replace(/\.git$/, "") };
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
  const remote = parseGitRemote(remoteUrl);
  if (!remote) {
    return null;
  }
  const { host, hostname } = remote;

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
