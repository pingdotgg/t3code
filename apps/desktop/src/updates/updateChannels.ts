// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

// Local source builds install beside a downloaded app, so they get their own identity and T3 home.
const LOCAL_VERSION_PATTERN = /^[^-+]+-local(?:\.[0-9A-Za-z-]+)*$/;

export function isLocalDesktopVersion(version: string): boolean {
  return LOCAL_VERSION_PATTERN.test(version);
}
