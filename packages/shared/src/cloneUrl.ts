export type CloneProtocol = "ssh" | "https";

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;

function parseCloneUrl(
  url: string,
): { protocol: CloneProtocol; host: string; path: string; customPort: boolean } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { protocol: "ssh", host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
  // URL() keeps userinfo past an @ in the password; a regex that stops at the first @
  // would treat that remainder as the host.
  try {
    const https = new URL(trimmed);
    if (https.protocol === "http:" || https.protocol === "https:") {
      const path = https.pathname.replace(/^\/+/, "");
      if (https.hostname.length === 0 || path.length === 0) return null;
      return {
        protocol: "https",
        host: https.hostname,
        path,
        customPort: https.port !== "",
      };
    }
  } catch {
    // Not an absolute URL; try scp-like below.
  }
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
  return protocol === "ssh"
    ? `git@${parsed.host}:${parsed.path}`
    : `https://${parsed.host}/${parsed.path}`;
}
