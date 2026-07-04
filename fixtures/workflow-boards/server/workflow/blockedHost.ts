/**
 * blockedHost - literal-blocklist SSRF guard for user-supplied work-source hosts.
 *
 * Jira is the first work-source provider whose base URL is chosen by the
 * connection creator, so the server makes outbound requests to a host that a
 * user controls. `isBlockedHost` rejects hostnames that point at the loopback
 * interface, link-local/cloud-metadata ranges, or RFC1918 private networks, so
 * a malicious base URL cannot pivot the server into internal infrastructure.
 *
 * Known limitation: this is a literal, string-based check on the hostname only;
 * it performs no DNS resolution.
 */

/** Returns true when the hostname must not be used for an outbound request. */
export function isBlockedHost(hostname: string): boolean {
  // Normalize: lowercase, strip surrounding IPv6 brackets, and strip an
  // absolute-FQDN trailing dot.
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");

  if (host === "") return true;

  // localhost and any *.localhost label.
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // Unspecified / loopback literals.
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;

  // IPv4-mapped / IPv4-compatible IPv6 addresses are non-global in this use.
  if (host.startsWith("::")) return true;

  // Cloud metadata service names.
  if (host === "metadata.google.internal" || host === "metadata.goog" || host === "metadata") {
    return true;
  }

  // IPv4 loopback (127.0.0.0/8).
  if (host.startsWith("127.")) return true;

  // IPv4 link-local / cloud metadata (169.254.0.0/16).
  if (host.startsWith("169.254.")) return true;

  // RFC1918 private ranges.
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const match172 = /^172\.(\d{1,3})\./u.exec(host);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 unique-local and link-local literals. Gate on ":" so DNS names that
  // merely start with these letters are not blocked.
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    if (
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    ) {
      return true;
    }
  }

  return false;
}
