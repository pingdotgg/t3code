import type { SourceControlProviderInfo, SourceControlProviderKind } from "@t3tools/contracts";

export interface ChangeRequestPresentation {
  readonly icon: "github" | "gitlab" | "azure-devops" | "bitbucket" | "change-request";
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
    case "azure-devops":
      return AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION;
    case "bitbucket":
      return BITBUCKET_CHANGE_REQUEST_PRESENTATION;
    case "unknown":
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

export function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export function formatChangeRequestAction(
  verb: "View" | "Create",
  presentation: ChangeRequestPresentation,
): string {
  return `${verb} ${presentation.shortName}`;
}

export function formatCreateChangeRequestPhrase(presentation: ChangeRequestPresentation): string {
  return `create ${presentation.shortName}`;
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

/** Identifies an Azure DevOps organization, project, and repository. */
export interface AzureDevOpsRepositoryCoordinates {
  readonly organization: string;
  readonly project: string;
  readonly repository: string;
}

function decodeAzureDevOpsPathSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Extracts organization, project, and repository from an Azure Repos clone URL. */
export function parseAzureDevOpsRepositoryCoordinates(
  remoteUrl: string | null | undefined,
): AzureDevOpsRepositoryCoordinates | undefined {
  const trimmed = remoteUrl?.trim() ?? "";
  if (trimmed.length === 0) {
    return undefined;
  }

  let hostname: string;
  let segments: ReadonlyArray<string>;

  if (trimmed.startsWith("git@")) {
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= "git@".length) {
      return undefined;
    }
    hostname = trimmed.slice("git@".length, separatorIndex).toLowerCase();
    segments = trimmed
      .slice(separatorIndex + 1)
      .split("/")
      .filter((segment) => segment.length > 0);
  } else {
    try {
      const url = new URL(trimmed);
      hostname = url.hostname.toLowerCase();
      segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    } catch {
      return undefined;
    }
  }

  if (hostname !== "dev.azure.com" && hostname !== "ssh.dev.azure.com") {
    return undefined;
  }

  const isSshClonePath = segments[0]?.toLowerCase() === "v3";
  const isHttpClonePath = segments[2]?.toLowerCase() === "_git";
  const [organizationSegment, projectSegment, repositorySegment] = isSshClonePath
    ? [segments[1], segments[2], segments[3]]
    : isHttpClonePath
      ? [segments[0], segments[1], segments[3]]
      : [];

  const organization = organizationSegment
    ? decodeAzureDevOpsPathSegment(organizationSegment)
    : null;
  const project = projectSegment ? decodeAzureDevOpsPathSegment(projectSegment) : null;
  const repository = repositorySegment
    ? decodeAzureDevOpsPathSegment(repositorySegment.replace(/\.git$/iu, ""))
    : null;

  return organization && project && repository ? { organization, project, repository } : undefined;
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    if (separatorIndex <= 0) {
      return null;
    }
    return hostWithPath.slice(0, separatorIndex).toLowerCase();
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

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

function isGitLabHost(host: string): boolean {
  return host === "gitlab.com" || host.includes("gitlab");
}

function isAzureDevOpsHost(host: string): boolean {
  return (
    host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com")
  );
}

function isBitbucketHost(host: string): boolean {
  return host === "bitbucket.org" || host.includes("bitbucket");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  const hostname = parseHostName(host);

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
      baseUrl: toBaseUrl(hostname === "ssh.dev.azure.com" ? "dev.azure.com" : host),
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
