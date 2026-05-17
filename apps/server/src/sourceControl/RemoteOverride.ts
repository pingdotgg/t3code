import type {
  ProjectRemoteOverride,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import * as SourceControlProvider from "./SourceControlProvider.ts";

export function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    return separatorIndex > 0 ? hostWithPath.slice(0, separatorIndex).toLowerCase() : null;
  }

  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

export function parseBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    const host = parseRemoteHost(value);
    return host ? `https://${host}` : null;
  }
}

export function providerName(kind: SourceControlProviderKind, baseUrl: string | null): string {
  switch (kind) {
    case "github":
      return baseUrl === "https://github.com" ? "GitHub" : "GitHub Self-Hosted";
    case "gitlab":
      return baseUrl === "https://gitlab.com" ? "GitLab" : "GitLab Self-Hosted";
    case "azure-devops":
      return "Azure DevOps";
    case "bitbucket":
      return baseUrl === "https://bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted";
    case "unknown":
      return parseRemoteHost(baseUrl ?? "") ?? "Source control";
  }
}

export function providerInfoFromOverride(
  override: ProjectRemoteOverride,
): SourceControlProviderInfo | null {
  const baseUrl = override.webUrl
    ? parseBaseUrl(override.webUrl)
    : parseBaseUrl(override.remoteUrl);
  if (!baseUrl) {
    return null;
  }
  return {
    kind: override.provider,
    name: providerName(override.provider, baseUrl),
    baseUrl,
  };
}

export function providerContextFromOverride(
  override: ProjectRemoteOverride,
): SourceControlProvider.SourceControlProviderContext | null {
  const provider = providerInfoFromOverride(override);
  return provider
    ? {
        provider,
        remoteName: override.remoteName ?? "origin",
        remoteUrl: override.remoteUrl,
      }
    : null;
}
