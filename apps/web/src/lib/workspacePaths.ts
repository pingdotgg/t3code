export type WorkspaceComparisonPlatform = "darwin" | "linux" | "win32";

function detectWorkspaceComparisonPlatform(): WorkspaceComparisonPlatform {
  if (typeof navigator === "undefined") {
    return "linux";
  }

  const navigatorWithPlatformData = navigator as Navigator & {
    readonly userAgentData?: {
      readonly platform?: string;
    };
  };
  const rawPlatform =
    navigatorWithPlatformData.userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    "";
  const normalizedPlatform = rawPlatform.toLowerCase();
  if (normalizedPlatform.includes("mac")) {
    return "darwin";
  }
  if (normalizedPlatform.includes("win")) {
    return "win32";
  }
  return "linux";
}

function trimTrailingSeparators(path: string): string {
  const slashNormalized = path.replace(/\\/g, "/");
  if (slashNormalized === "/") {
    return slashNormalized;
  }
  if (/^[a-z]:\/+$/i.test(slashNormalized)) {
    return slashNormalized.slice(0, 3);
  }
  return slashNormalized.replace(/\/+$/g, "");
}

export function normalizeWorkspacePathForComparison(
  rawPath: string,
  platform: WorkspaceComparisonPlatform = detectWorkspaceComparisonPlatform(),
): string {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.length === 0) {
    return "";
  }

  const normalizedPath = trimTrailingSeparators(trimmedPath);
  return platform === "darwin" || platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

export function workspacePathsMatch(
  left: string,
  right: string,
  platform?: WorkspaceComparisonPlatform,
): boolean {
  return (
    normalizeWorkspacePathForComparison(left, platform) ===
    normalizeWorkspacePathForComparison(right, platform)
  );
}
