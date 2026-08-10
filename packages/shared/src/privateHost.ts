/**
 * Private host detection, for code that sends a host name to a third party.
 *
 * A public favicon service cannot resolve a private host, so a request for one
 * always fails. The request also tells that service the private host name.
 *
 * This module holds no runtime dependency, so web, mobile and desktop can all
 * import it.
 */

// RFC 6761 reserves every name under .localhost for the loopback interface.
const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".ts.net"];

const IPV4_MAPPED_PREFIX = /^::ffff:/;

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, or null.
 *
 * Accepts the dotted form `::ffff:192.168.1.10` and the hex form
 * `::ffff:c0a8:010a`.
 */
function ipv4FromMappedIpv6(address: string): string | null {
  if (!IPV4_MAPPED_PREFIX.test(address)) {
    return null;
  }
  const tail = address.replace(IPV4_MAPPED_PREFIX, "");
  if (tail.includes(".")) {
    return tail;
  }
  const groups = tail.split(":");
  if (groups.length !== 2) {
    return null;
  }
  const [high, low] = groups;
  if (high === undefined || low === undefined) {
    return null;
  }
  if (!/^[0-9a-f]{1,4}$/.test(high) || !/^[0-9a-f]{1,4}$/.test(low)) {
    return null;
  }
  const highValue = Number.parseInt(high, 16);
  const lowValue = Number.parseInt(low, 16);
  return [highValue >> 8, highValue & 0xff, lowValue >> 8, lowValue & 0xff].join(".");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return false;
  }
  if (octets.every((octet) => octet === 0)) {
    return true;
  }
  const [first = Number.NaN, second = Number.NaN] = octets;
  if (first === 10 || first === 127) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  // Tailscale hands out 100.64.0.0/10.
  return first === 100 && second >= 64 && second <= 127;
}

function isPrivateIpv6(host: string): boolean {
  const address = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (address === "::1") {
    return true;
  }
  // fc00::/7 covers unique local addresses. fe80::/10 covers link local.
  return /^f[cd][0-9a-f]{0,2}:/.test(address) || /^fe[89ab][0-9a-f]?:/.test(address);
}

/**
 * True when a host belongs to a private network.
 *
 * An empty host counts as private, so a caller that cannot read a host never
 * sends it to a third party.
 */
export function isPrivateHost(host: string): boolean {
  // Drop a trailing DNS root label, so "printer.local." matches ".local".
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0) {
    return true;
  }
  if (normalized === "localhost") {
    return true;
  }
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }
  // A host with no dot and no colon cannot be a public domain.
  if (!normalized.includes(".") && !normalized.includes(":")) {
    return true;
  }
  const bare = normalized.replace(/^\[/, "").replace(/\]$/, "");
  const mapped = ipv4FromMappedIpv6(bare);
  if (mapped !== null) {
    return isPrivateIpv4(mapped);
  }
  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}
