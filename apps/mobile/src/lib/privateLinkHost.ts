const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".home.arpa", ".ts.net"];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return false;
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
 * True when a link host belongs to a private network.
 *
 * A favicon service cannot resolve such a host, so a request for it always
 * fails. The request also tells that service the private host name.
 */
export function isPrivateLinkHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
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
  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}
