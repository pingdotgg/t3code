import type * as Path from "effect/Path";

export const LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_PARTS = ["t3code", "servers"] as const;
export const LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE = 0o700;
export const LOCAL_SERVER_ADVERTISEMENT_FILE_MODE = 0o600;
export const LOCAL_SERVER_ADVERTISEMENT_MAX_BYTES = 64 * 1024;

export function resolveLocalServerAdvertisementDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly xdgRuntimeDirectory: string | undefined;
  readonly path: Path.Path;
}): string | null {
  if (input.platform !== "linux") {
    return null;
  }
  const runtimeDirectory = input.xdgRuntimeDirectory?.trim();
  if (!runtimeDirectory || !input.path.isAbsolute(runtimeDirectory)) {
    return null;
  }
  return input.path.join(runtimeDirectory, ...LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_PARTS);
}

export function isCanonicalLoopbackHostname(hostname: string): boolean {
  if (hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255 && String(value) === octet;
  });
}

export function parseCanonicalLoopbackHttpBaseUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    !isCanonicalLoopbackHostname(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port === "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    return null;
  }
  return url;
}

export function isValidLocalServerPairingUrl(input: {
  readonly pairingUrl: string;
  readonly httpBaseUrl: URL;
}): boolean {
  let pairingUrl: URL;
  try {
    pairingUrl = new URL(input.pairingUrl);
  } catch {
    return false;
  }
  const token = new URLSearchParams(pairingUrl.hash.slice(1)).get("token")?.trim();
  return (
    pairingUrl.origin === input.httpBaseUrl.origin &&
    pairingUrl.username === "" &&
    pairingUrl.password === "" &&
    pairingUrl.pathname === "/pair" &&
    pairingUrl.search === "" &&
    token !== undefined &&
    token.length > 0
  );
}
