export type PublicEnvironment = Readonly<Record<string, string | undefined>>;

export interface LegalCapability {
  readonly name?: string;
  readonly privacyContact?: string;
  readonly postalAddress?: string;
  readonly jurisdiction?: string;
  readonly waitlistRetentionDays?: number;
  readonly publicationReady: boolean;
}

export type AccessCapability =
  | { readonly kind: "available"; readonly url: string }
  | { readonly kind: "unavailable" };

export type WaitlistCapability =
  | {
      readonly kind: "open";
      readonly endpoint: string;
      readonly controller: string;
      readonly privacyContact: string;
      readonly retentionDays: number;
    }
  | { readonly kind: "closed" };

export interface VerifiedDownload {
  readonly kind: "available";
  readonly url: string;
  readonly fileName: string;
  readonly platform: string;
  readonly version: string;
  readonly sha256: string;
}

export type DownloadCapability = VerifiedDownload | { readonly kind: "unavailable" };

export interface PublicCapabilities {
  readonly canonicalUrl: string;
  readonly legal: LegalCapability;
  readonly access: AccessCapability;
  readonly waitlist: WaitlistCapability;
  readonly download: DownloadCapability;
  readonly primaryAction:
    | { readonly kind: "access"; readonly href: string; readonly label: "Open Auldric" }
    | { readonly kind: "waitlist"; readonly href: "/waitlist"; readonly label: "Join the waitlist" }
    | { readonly kind: "status"; readonly href: "/access"; readonly label: "Check availability" };
}

const downloadPlatforms = {
  "macos-apple-silicon": "macOS · Apple silicon",
  "macos-intel": "macOS · Intel",
  "windows-x64": "Windows · x64",
  "windows-arm64": "Windows · Arm64",
  "linux-x64": "Linux · x64",
} as const;

export interface ReleaseArtifact {
  readonly id: string;
  readonly url: string;
  readonly fileName: string;
  readonly platform: keyof typeof downloadPlatforms;
  readonly version: string;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly artifacts: ReadonlyArray<ReleaseArtifact>;
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseHttpsUrl(value: string | undefined): URL | undefined {
  const candidate = clean(value);
  if (!candidate) return undefined;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function isAuldricHost(hostname: string): boolean {
  return hostname === "auldric.com" || hostname.endsWith(".auldric.com");
}

function isSafeAccessPath(url: URL): boolean {
  return (
    !url.search &&
    !url.hash &&
    !url.pathname.startsWith("//") &&
    !/%(?:2e|2f|5c)/iu.test(url.pathname)
  );
}

function parseEmail(value: string | undefined): string | undefined {
  const candidate = clean(value);
  if (!candidate || candidate.length > 254 || !/^[\x21-\x7e]+$/u.test(candidate)) return undefined;

  const parts = candidate.split("@");
  if (parts.length !== 2) return undefined;
  const [local = "", domain = ""] = parts;
  if (
    local.length === 0 ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9._+-]+$/u.test(local)
  ) {
    return undefined;
  }

  const labels = domain.toLowerCase().split(".");
  const validLabel = (label: string): boolean =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label);
  const topLevelDomain = labels.at(-1) ?? "";
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    !labels.every(validLabel) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/u.test(topLevelDomain)
  ) {
    return undefined;
  }

  return `${local}@${labels.join(".")}`;
}

function parseLegalText(value: string | undefined): string | undefined {
  const candidate = clean(value);
  return candidate &&
    candidate.length >= 2 &&
    candidate.length <= 240 &&
    [...candidate].every((character) => character.charCodeAt(0) >= 32)
    ? candidate
    : undefined;
}

function parseRetentionDays(value: string | undefined): number | undefined {
  const candidate = clean(value);
  if (!candidate || !/^\d+$/u.test(candidate)) return undefined;
  const days = Number(candidate);
  return Number.isSafeInteger(days) && days >= 1 && days <= 730 ? days : undefined;
}

function resolveCanonicalUrl(env: PublicEnvironment): string {
  const configured = parseHttpsUrl(env.PUBLIC_AULDRIC_SITE_URL);
  if (!configured || !isAuldricHost(configured.hostname)) return "https://auldric.com";
  configured.pathname = "/";
  configured.search = "";
  configured.hash = "";
  return configured.toString().replace(/\/$/u, "");
}

function resolveLegal(env: PublicEnvironment, canonicalUrl: string): LegalCapability {
  const name = parseLegalText(env.PUBLIC_AULDRIC_LEGAL_NAME);
  const privacyContact = parseEmail(env.PUBLIC_AULDRIC_PRIVACY_CONTACT);
  const postalAddress = parseLegalText(env.PUBLIC_AULDRIC_LEGAL_ADDRESS);
  const jurisdiction = parseLegalText(env.PUBLIC_AULDRIC_LEGAL_JURISDICTION);
  const waitlistRetentionDays = parseRetentionDays(env.PUBLIC_AULDRIC_WAITLIST_RETENTION_DAYS);
  const canonicalHost = new URL(canonicalUrl).hostname;
  const configuredCanonical = parseHttpsUrl(env.PUBLIC_AULDRIC_SITE_URL);
  const hasExactCanonical = Boolean(
    configuredCanonical &&
    isAuldricHost(configuredCanonical.hostname) &&
    configuredCanonical.origin === new URL(canonicalUrl).origin &&
    configuredCanonical.pathname === "/" &&
    !configuredCanonical.search &&
    !configuredCanonical.hash,
  );

  return {
    ...(name ? { name } : {}),
    ...(privacyContact ? { privacyContact } : {}),
    ...(postalAddress ? { postalAddress } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(waitlistRetentionDays ? { waitlistRetentionDays } : {}),
    publicationReady: Boolean(
      name &&
      privacyContact &&
      postalAddress &&
      jurisdiction &&
      isAuldricHost(canonicalHost) &&
      hasExactCanonical,
    ),
  };
}

function resolveAccess(
  env: PublicEnvironment,
  canonicalUrl: string,
  legal: LegalCapability,
): AccessCapability {
  if (clean(env.PUBLIC_AULDRIC_ACCESS_STATUS) !== "available") {
    return { kind: "unavailable" };
  }

  const accessValue = clean(env.PUBLIC_AULDRIC_ACCESS_URL);
  const url = parseHttpsUrl(accessValue);
  return accessValue &&
    legal.publicationReady &&
    !/%(?:2e|2f|5c)/iu.test(accessValue) &&
    url &&
    isAuldricHost(url.hostname) &&
    url.origin !== new URL(canonicalUrl).origin &&
    isSafeAccessPath(url)
    ? { kind: "available", url: url.toString() }
    : { kind: "unavailable" };
}

function resolveWaitlist(
  env: PublicEnvironment,
  legal: LegalCapability,
  canonicalUrl: string,
): WaitlistCapability {
  if (clean(env.PUBLIC_AULDRIC_WAITLIST_STATUS) !== "open") {
    return { kind: "closed" };
  }

  const endpoint = parseHttpsUrl(env.PUBLIC_AULDRIC_WAITLIST_ENDPOINT);
  if (
    !endpoint ||
    Boolean(endpoint.search) ||
    Boolean(endpoint.hash) ||
    endpoint.origin === new URL(canonicalUrl).origin ||
    !legal.publicationReady ||
    !legal.name ||
    !legal.privacyContact ||
    !legal.waitlistRetentionDays
  ) {
    return { kind: "closed" };
  }

  return {
    kind: "open",
    endpoint: endpoint.toString(),
    controller: legal.name,
    privacyContact: legal.privacyContact,
    retentionDays: legal.waitlistRetentionDays,
  };
}

function resolveDownload(
  env: PublicEnvironment,
  manifest: ReleaseManifest,
  legal: LegalCapability,
): DownloadCapability {
  if (clean(env.PUBLIC_AULDRIC_DOWNLOAD_STATUS) !== "available") {
    return { kind: "unavailable" };
  }

  const artifactId = clean(env.PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID);
  const artifact = manifest.artifacts.find((entry) => entry.id === artifactId);
  const url = parseHttpsUrl(artifact?.url);
  const fileName = clean(artifact?.fileName);
  const platformKey = clean(artifact?.platform);
  const version = clean(artifact?.version);
  const sha256 = clean(artifact?.sha256)?.toLowerCase();
  const expectedPrefix = "/AuldricAI/auldrics/releases/download/";
  const releasePathParts = url?.pathname.slice(expectedPrefix.length).split("/") ?? [];
  let pathFileName = "";
  try {
    pathFileName = url ? decodeURIComponent(url.pathname.split("/").at(-1) ?? "") : "";
  } catch {
    return { kind: "unavailable" };
  }
  const normalizedVersion = version?.startsWith("v") ? version.slice(1) : version;
  const releaseTag = releasePathParts[0];

  if (
    !url ||
    !legal.publicationReady ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(expectedPrefix) ||
    releasePathParts.length !== 2 ||
    releasePathParts.some((part) => part.length === 0) ||
    Boolean(url.search) ||
    Boolean(url.hash) ||
    !fileName ||
    pathFileName !== fileName ||
    !platformKey ||
    !(platformKey in downloadPlatforms) ||
    !version ||
    !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ||
    (releaseTag !== normalizedVersion && releaseTag !== `v${normalizedVersion}`) ||
    !sha256 ||
    !/^[a-f0-9]{64}$/u.test(sha256)
  ) {
    return { kind: "unavailable" };
  }

  return {
    kind: "available",
    url: url.toString(),
    fileName,
    platform: downloadPlatforms[platformKey as keyof typeof downloadPlatforms],
    version,
    sha256,
  };
}

export function resolvePublicCapabilities(
  env: PublicEnvironment,
  manifest: ReleaseManifest = { schemaVersion: 1, artifacts: [] },
): PublicCapabilities {
  const canonicalUrl = resolveCanonicalUrl(env);
  const legal = resolveLegal(env, canonicalUrl);
  const access = resolveAccess(env, canonicalUrl, legal);
  const waitlist = resolveWaitlist(env, legal, canonicalUrl);
  const download = resolveDownload(env, manifest, legal);

  const primaryAction =
    access.kind === "available"
      ? ({ kind: "access", href: access.url, label: "Open Auldric" } as const)
      : waitlist.kind === "open"
        ? ({ kind: "waitlist", href: "/waitlist", label: "Join the waitlist" } as const)
        : ({ kind: "status", href: "/access", label: "Check availability" } as const);

  return { canonicalUrl, legal, access, waitlist, download, primaryAction };
}
