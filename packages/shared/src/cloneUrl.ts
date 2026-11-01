export type CloneProtocol = "ssh" | "https";

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
// Userinfo may contain `@`; the last one before the first slash separates the host.
const SSH_URL = /^ssh:\/\/(?:[^/\s]*@)?([^@:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^/\s]*@)?([^@:/\s]+)(:\d+)?\/(.+)$/;

function parseCloneUrl(
  url: string,
): { protocol: CloneProtocol; host: string; path: string; customPort: boolean } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { protocol: "ssh", host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
  const https = HTTPS_URL.exec(trimmed);
  if (https) return { protocol: "https", host: https[1]!, path: https[3]!, customPort: !!https[2] };
  const scp = SCP_LIKE_URL.exec(trimmed);
  if (scp) return { protocol: "ssh", host: scp[1]!, path: scp[2]!, customPort: false };
  return null;
}

export function cloneUrlProtocol(url: string): CloneProtocol | null {
  return parseCloneUrl(url)?.protocol ?? null;
}

/**
 * Rewrites a clone URL to the other protocol, because the target machine may
 * only have SSH keys or only an HTTPS credential helper. Returns null when the
 * URL cannot be rewritten safely, such as a custom port.
 */
export function cloneUrlForProtocol(url: string, protocol: CloneProtocol): string | null {
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  if (parsed.protocol === protocol) return url.trim();
  if (parsed.customPort) return null;
  // Azure's transports use different hosts and put the repository marker in
  // different positions; changing only the scheme produces an invalid clone URL.
  if (parsed.protocol === "ssh" && parsed.host.toLowerCase() === "ssh.dev.azure.com") {
    const azure = /^v3\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(parsed.path);
    return azure ? `https://dev.azure.com/${azure[1]}/${azure[2]}/_git/${azure[3]}` : null;
  }
  if (parsed.protocol === "https" && parsed.host.toLowerCase() === "dev.azure.com") {
    const azure = /^([^/?#]+)\/([^/?#]+)\/_git\/([^/?#]+)$/.exec(parsed.path);
    return azure ? `git@ssh.dev.azure.com:v3/${azure[1]}/${azure[2]}/${azure[3]}` : null;
  }
  return protocol === "ssh"
    ? `git@${parsed.host}:${parsed.path}`
    : `https://${parsed.host}/${parsed.path}`;
}
