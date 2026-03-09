import { isIP } from "node:net";

const BRACKETED_IPV6_HOST_REGEX = /^\[(.*)]$/;

export const normalizeHost = (host: string): string => {
  const trimmed = host.trim();
  const bracketedMatch = BRACKETED_IPV6_HOST_REGEX.exec(trimmed);
  return bracketedMatch?.[1] ?? trimmed;
};

export const formatHostForUrl = (host: string): string => {
  const normalized = normalizeHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
};

export const isWildcardHost = (host: string | undefined): boolean => {
  if (!host) {
    return false;
  }
  const normalized = normalizeHost(host);
  return normalized === "0.0.0.0" || normalized === "::";
};

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) {
    return false;
  }
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

export const isIpAddressHost = (host: string | undefined): boolean => {
  if (!host) {
    return false;
  }
  return isIP(normalizeHost(host)) !== 0;
};
