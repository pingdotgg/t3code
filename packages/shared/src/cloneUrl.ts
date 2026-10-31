import { isWindowsDrivePath } from "./path.ts";

export type CloneProtocol = "ssh" | "https";

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;

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
  return protocol === "ssh"
    ? `git@${parsed.host}:${parsed.path}`
    : `https://${parsed.host}/${parsed.path}`;
}

const UNSAFE_SEGMENT = /^\.{1,2}$|[\\:*?"<>|\p{Cc}]|[ .]$/u;
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.| *$)/i;

/**
 * The `<host>/<owner>/<repo>` folders ghq clones a URL into, or null for local paths and
 * anything with a folder that could leave the root.
 */
export function cloneUrlRepositoryPath(url: string): string | null {
  if (isWindowsDrivePath(url.trim())) return null;
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  const segments = [parsed.host, ...parsed.path.split(/[?#]/)[0]!.split("/").filter(Boolean)];
  const last = segments.at(-1)!;
  if (last.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -".git".length);
  if (
    segments.length < 2 ||
    segments.some((s) => s === "" || UNSAFE_SEGMENT.test(s) || WINDOWS_DEVICE_NAME.test(s))
  )
    return null;
  return segments.join("/");
}
