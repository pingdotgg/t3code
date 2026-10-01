import type { SourceControlProviderKind } from "@t3tools/contracts";

const scpRemote = /^[A-Za-z0-9][A-Za-z0-9._-]*@([A-Za-z0-9][A-Za-z0-9.-]*):([^\s]+)$/;

export function isSafeRepositoryRemote(remote: string, allowHttp = false): boolean {
  // URL parsing strips controls; reject them before git can interpret a different remote.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(remote)) return false;
  if (scpRemote.test(remote)) return !remote.includes("://");
  if (/^[a-z]+:\/\/[^/]*%/i.test(remote)) return false;
  if (!remote.includes("://")) return false;
  try {
    const url = new URL(remote);
    return (
      (url.protocol === "https:" ||
        url.protocol === "ssh:" ||
        (allowHttp && url.protocol === "http:")) &&
      url.hostname.length > 0 &&
      !decodeURIComponent(url.hostname).startsWith("-") &&
      !decodeURIComponent(url.username).startsWith("-") &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "ssh:" || !url.username)
    );
  } catch {
    return false;
  }
}

export function isSafeRepositoryIdentifier(
  provider: SourceControlProviderKind,
  repository: string,
): boolean {
  if (repository !== repository.trim() || repository.startsWith("-")) return false;
  const locator = providerRepositoryPath(provider, repository);
  if (locator === null) return false;
  const segments = locator.split("/");
  const segmentPattern =
    provider === "azure-devops" ? /^[\p{L}\p{N}_.-][\p{L}\p{N} ._()&-]*$/u : /^[A-Za-z0-9._-]+$/;
  if (
    locator.startsWith("-") ||
    !segments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        segment === segment.trim() &&
        segmentPattern.test(segment),
    )
  )
    return false;
  switch (provider) {
    case "github":
      return segments.length === 2;
    case "gitlab":
      return segments.length >= 2;
    case "forgejo":
    case "bitbucket":
      return segments.length === 2;
    case "azure-devops":
      return segments.length <= 3 || (segments.length === 4 && segments[2] === "_git");
    case "unknown":
      return false;
  }
}

export function repositoryRemoteHost(remote: string): string | null {
  if (!isSafeRepositoryRemote(remote, true)) return null;
  if (!remote.includes("://")) return /^[^@]+@([^:]+):/.exec(remote)?.[1]?.toLowerCase() ?? null;
  return new URL(remote).hostname.toLowerCase();
}

export function providerRepositoryHost(
  provider: SourceControlProviderKind,
  repository: string,
): string | null {
  if (repository.includes("://") || repository.includes("@"))
    return isSafeRepositoryRemote(repository, provider === "forgejo")
      ? (scpRemote.exec(repository)?.[1]?.toLowerCase() ??
          (new URL(repository).protocol === "ssh:"
            ? new URL(repository).hostname
            : new URL(repository).host
          ).toLowerCase())
      : null;
  const segments = repository.replace(/\/$/, "").split("/");
  return (provider === "github" && segments.length === 3) ||
    (segments.length >= 3 && /[.]/.test(segments[0] ?? ""))
    ? (segments[0] ?? "").toLowerCase()
    : null;
}

export function providerRepositoryPath(
  provider: SourceControlProviderKind,
  repository: string,
): string | null {
  let path = repository;
  if (repository.includes("://") || repository.includes("@")) {
    if (!isSafeRepositoryRemote(repository, provider === "forgejo")) return null;
    try {
      path = repository.includes("://")
        ? decodeURIComponent(new URL(repository).pathname.slice(1))
        : repository.slice(repository.indexOf(":") + 1);
    } catch {
      return null;
    }
  } else if (providerRepositoryHost(provider, repository) !== null) {
    path = repository.split("/").slice(1).join("/");
  }
  return path.replace(/\/$/, "");
}

/** Configured origins retain their scheme/port for HTTP Forgejo lookups. */
export function configuredRepositoryOrigin(host: string): URL | null {
  try {
    const url = new URL(host.includes("://") ? host : `https://${host}`);
    return isSafeRepositoryRemote(url.origin, true) ? url : null;
  } catch {
    return null;
  }
}
