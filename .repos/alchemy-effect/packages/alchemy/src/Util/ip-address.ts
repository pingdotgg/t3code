/**
 * Canonicalizes an IPv4 or IPv6 CIDR to its network address.
 * Invalid input is returned unchanged; this function is not a validator.
 */
export const canonicalCidr = (cidr: string | undefined): string | undefined => {
  if (cidr === undefined) return undefined;
  if (/\s/.test(cidr)) return cidr;
  const [address, prefixText, extra] = cidr.split("/");
  if (!address || prefixText === undefined || extra !== undefined) return cidr;
  if (!/^\d+$/.test(prefixText)) return cidr;

  const ipv6 = address.includes(":");
  const width = ipv6 ? 128 : 32;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix > width) return cidr;
  const value = ipv6 ? parseIpv6(address) : parseIpv4(address);
  if (value === undefined) return cidr;

  const hostBits = BigInt(width - prefix);
  const network = (value >> hostBits) << hostBits;
  return `${ipv6 ? formatIpv6(network) : formatIpv4(network)}/${prefix}`;
};

const parseIpv4 = (address: string): bigint | undefined => {
  const octets = address.split(".");
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^(0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255)
  )
    return undefined;
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
};

const parseIpv6 = (address: string): bigint | undefined => {
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = parseIpv4(address.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;
    address = `${address.slice(0, lastColon + 1)}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const count = left.length + right.length;
  if (halves.length === 1 ? count !== 8 : count >= 8) return undefined;
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) {
    return undefined;
  }

  // A double colon must replace at least one 16-bit word.
  const words =
    halves.length === 1 ? left : [...left, ...Array<string>(8 - count).fill("0"), ...right];
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
};

const formatIpv4 = (address: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => Number((address >> shift) & 255n)).join(".");

const formatIpv6 = (address: bigint): string => {
  const words = Array.from({ length: 8 }, (_, index) =>
    ((address >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  let longestStart = -1;
  let longestLength = 1;
  for (let index = 0; index < words.length; index++) {
    if (words[index] !== "0") continue;
    let end = index + 1;
    while (end < words.length && words[end] === "0") end++;
    // Compress the first longest run; never compress a single zero word.
    if (end - index > longestLength) {
      longestStart = index;
      longestLength = end - index;
    }
    index = end - 1;
  }
  return longestStart < 0
    ? words.join(":")
    : `${words.slice(0, longestStart).join(":")}::${words.slice(longestStart + longestLength).join(":")}`;
};
