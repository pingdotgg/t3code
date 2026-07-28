import type * as Path from "effect/Path";

export const LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_PARTS = ["t3code", "servers"] as const;
export const LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE = 0o700;
export const LOCAL_SERVER_ADVERTISEMENT_FILE_MODE = 0o600;
export const LOCAL_SERVER_ADVERTISEMENT_MAX_BYTES = 64 * 1024;

export const LOCAL_SERVER_CHALLENGE_DIRECTORY_PARTS = ["t3code", "challenges"] as const;
export const LOCAL_SERVER_CHALLENGE_MAX_BYTES = 4 * 1024;
// 256 bits of entropy, hex encoded. Long enough that a caller who cannot read
// the challenge file cannot guess its contents.
export const LOCAL_SERVER_CHALLENGE_NONCE_BYTES = 32;

function resolveRuntimeSubdirectory(
  input: {
    readonly platform: NodeJS.Platform;
    readonly xdgRuntimeDirectory: string | undefined;
    readonly path: Path.Path;
  },
  parts: readonly string[],
): string | null {
  if (input.platform !== "linux") {
    return null;
  }
  const runtimeDirectory = input.xdgRuntimeDirectory?.trim();
  if (!runtimeDirectory || !input.path.isAbsolute(runtimeDirectory)) {
    return null;
  }
  return input.path.join(runtimeDirectory, ...parts);
}

export function resolveLocalServerAdvertisementDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly xdgRuntimeDirectory: string | undefined;
  readonly path: Path.Path;
}): string | null {
  return resolveRuntimeSubdirectory(input, LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_PARTS);
}

/**
 * Directory a pairing client writes its challenge nonce into. Separate from the
 * advertisement directory so the server never reads a caller-named path out of
 * the directory it publishes into.
 */
export function resolveLocalServerChallengeDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly xdgRuntimeDirectory: string | undefined;
  readonly path: Path.Path;
}): string | null {
  return resolveRuntimeSubdirectory(input, LOCAL_SERVER_CHALLENGE_DIRECTORY_PARTS);
}

/**
 * Confirm a caller-supplied challenge path resolves inside the challenge
 * directory. Callers must pass already-canonicalized paths (realPath on both)
 * so a symlink cannot escape the directory. This is the only thing standing
 * between `/api/auth/local-pair` and an arbitrary-file read, so it fails closed.
 */
export function isContainedChallengePath(input: {
  readonly canonicalChallengePath: string;
  readonly canonicalChallengeDirectory: string;
  readonly path: Path.Path;
}): boolean {
  if (
    !input.path.isAbsolute(input.canonicalChallengePath) ||
    !input.path.isAbsolute(input.canonicalChallengeDirectory)
  ) {
    return false;
  }
  return input.path.dirname(input.canonicalChallengePath) === input.canonicalChallengeDirectory;
}

export function isCanonicalLoopbackHostname(hostname: string): boolean {
  // `URL.hostname` keeps the brackets on IPv6 hosts, so "[::1]" is the live
  // branch and the bare "::1" form is only accepted for direct callers.
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
    // Security check, not tidiness: `readHostedPairingRequest` reads a `host`
    // query parameter and would retarget pairing at an arbitrary remote host.
    // Rejecting any query string keeps a discovered link pinned to loopback.
    pairingUrl.search === "" &&
    token !== undefined &&
    token.length > 0
  );
}
