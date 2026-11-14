import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";

export function gitLabRemoteHost(remoteUrl: string): string | null {
  const remote = parseGitRemoteHost(remoteUrl);
  if (remote === null) return null;
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/iu.exec(remoteUrl.trim())?.[1];
  const host = authority
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : remoteUrl.trim().replace(/^[^@:/]+@/u, "");
  // glab's per-host configuration keys retain the remote's spelling, excluding SSH ports.
  return host.slice(0, remote.host.length);
}

export function gitLabApiHost(value: string): string | null {
  const raw = value.trim();
  if (!raw || /\s/u.test(raw)) return null;
  const url = URL.parse(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
  return url && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    ? url.host
    : null;
}
