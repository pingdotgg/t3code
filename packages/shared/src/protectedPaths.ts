import nodePath from "node:path";

const DARWIN_HOME_DIRECTORY_NAMES = [
  "Music",
  "Pictures",
  "Movies",
  "Downloads",
  "Desktop",
  "Documents",
  "Public",
  "Applications",
  "Library",
] as const;

const DARWIN_LIBRARY_PATHS = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
] as const;

const DARWIN_ROOT_PATHS = [
  "/.DocumentRevisions-V100",
  "/.Spotlight-V100",
  "/.Trashes",
  "/.fseventsd",
] as const;

const WIN32_HOME_DIRECTORY_NAMES = [
  "AppData",
  "Downloads",
  "Desktop",
  "Documents",
  "Pictures",
  "Music",
  "Videos",
  "OneDrive",
] as const;

export function getProtectedDirectoryNames(
  platform: NodeJS.Platform,
  _homeDir: string,
): ReadonlySet<string> {
  if (platform === "darwin") return new Set(DARWIN_HOME_DIRECTORY_NAMES);
  if (platform === "win32") return new Set(WIN32_HOME_DIRECTORY_NAMES);
  return new Set();
}

export function getProtectedAbsolutePaths(
  platform: NodeJS.Platform,
  homeDir: string,
): readonly string[] {
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  if (platform === "darwin") {
    return [
      ...DARWIN_HOME_DIRECTORY_NAMES.map((name) => path.resolve(homeDir, name)),
      ...DARWIN_LIBRARY_PATHS.map((name) => path.resolve(homeDir, "Library", name)),
      ...DARWIN_ROOT_PATHS,
    ];
  }
  if (platform === "win32") {
    return WIN32_HOME_DIRECTORY_NAMES.map((name) => path.resolve(homeDir, name));
  }
  return [];
}

function normalizeAbsolutePath(input: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const resolved = path.resolve(input);
  if (resolved.length > 1) return resolved.replace(/[\\/]+$/, "");
  return resolved;
}

function isSameOrChildPath(
  candidate: string,
  protectedPath: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedCandidate = normalizeAbsolutePath(candidate, platform);
  const normalizedProtectedPath = normalizeAbsolutePath(protectedPath, platform);
  if (platform === "win32") {
    const left = normalizedCandidate.toLowerCase();
    const right = normalizedProtectedPath.toLowerCase();
    return left === right || left.startsWith(`${right}\\`) || left.startsWith(`${right}/`);
  }
  return (
    normalizedCandidate === normalizedProtectedPath ||
    normalizedCandidate.startsWith(`${normalizedProtectedPath}/`) ||
    normalizedCandidate.startsWith(`${normalizedProtectedPath}\\`)
  );
}

export function isProtectedPath(input: {
  path: string;
  platform: NodeJS.Platform;
  homeDir: string;
}): boolean {
  return getProtectedAbsolutePaths(input.platform, input.homeDir).some((protectedPath) =>
    isSameOrChildPath(input.path, protectedPath, input.platform),
  );
}
