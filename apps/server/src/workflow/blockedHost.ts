/**
 * blockedHost — literal-blocklist SSRF guard for user-supplied work-source hosts.
 *
 * Jira is the first work-source provider whose base URL is chosen by the
 * connection creator, so the server makes outbound requests to a host that a
 * user controls. `isBlockedHost` rejects hostnames that point at the loopback
 * interface, link-local/cloud-metadata ranges, or RFC1918 private networks, so
 * a malicious base URL cannot pivot the server into internal infrastructure.
 *
 * ### KNOWN LIMITATION (proportionate mitigation, by design)
 * This is a LITERAL, string-based check on the hostname only — it performs NO
 * DNS resolution. Therefore it does NOT catch:
 *   - DNS rebinding (a public name that resolves to 127.0.0.1 at request time)
 *   - any public hostname that simply has a private/loopback A or AAAA record
 * Note: numeric-encoded IPv4 literals (`http://2130706433/`, `0x7f000001`,
 * `0177.0.0.1`) are NOT a gap — Node's WHATWG URL parser normalizes them to
 * dotted-decimal (`127.0.0.1`) before `.hostname`, so the prefix checks below
 * catch them.
 * Full DNS-resolution hardening (resolve, then re-check every resolved address,
 * and pin the connection to that address) is a deliberate follow-up — the owner
 * chose this proportionate level for v1.
 */

/** Returns true when the hostname must NOT be used for an outbound request. */
export function isBlockedHost(hostname: string): boolean {
  // Normalize: lowercase, strip surrounding IPv6 brackets, and strip an
  // absolute-FQDN trailing dot (`localhost.` / `127.0.0.1.` resolve to loopback
  // but would otherwise slip past the literal equality / prefix checks below).
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

  // IPv4-mapped / IPv4-compatible IPv6 (::ffff:x.x.x.x, ::x.x.x.x). These route
  // to the embedded IPv4 — including private/loopback/metadata ranges — on
  // dual-stack hosts. Node renders the embedded IPv4 in hex (e.g.
  // ::ffff:a9fe:a9fe for 169.254.169.254), so a per-range numeric check would
  // miss it; block every ::-leading address instead. No legitimate public Jira
  // uses one — every ::-prefixed address is non-global.
  if (host.startsWith("::")) return true;

  // Cloud metadata service names.
  if (
    host === "metadata.google.internal" ||
    host === "metadata.goog" ||
    host === "metadata"
  ) {
    return true;
  }

  // IPv4 loopback (127.0.0.0/8).
  if (host.startsWith("127.")) return true;

  // IPv4 link-local / cloud metadata (169.254.0.0/16).
  if (host.startsWith("169.254.")) return true;

  // RFC1918 private ranges.
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  // 172.16.0.0/12 → second octet 16..31.
  const match172 = /^172\.(\d{1,3})\./u.exec(host);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 unique-local (fc00::/7 → fc*/fd*) and link-local (fe80::/10 → fe8*/fe9*/fea*/feb*).
  // Gate on ":" so we only match IPv6 literals — an IPv6 address always contains a
  // colon, a DNS name never does. Without this gate a legitimate hostname that
  // merely starts with these letters (e.g. "fdic.gov", "fd-corp.com",
  // "fcgroup.com", "february.example.com") would be wrongly blocked.
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
