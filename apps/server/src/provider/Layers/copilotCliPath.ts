import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const GITHUB_SCOPE_DIR = "@github";
const COPILOT_NPM_LOADER = "npm-loader.js";
const COPILOT_PATHLESS_COMMAND_PATTERN = /^copilot(?:\.(?:exe|cmd|bat))?$/i;

function dedupePaths(paths: ReadonlyArray<string | undefined>): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    resolved.push(candidate);
  }

  return resolved;
}

function resolveSdkEntrypoint(): string | undefined {
  try {
    return require.resolve("@github/copilot-sdk");
  } catch {
    return undefined;
  }
}

function resolveProcessResourcesPath(): string | undefined {
  const processWithResourcesPath = process as NodeJS.Process & {
    readonly resourcesPath?: string;
  };
  return processWithResourcesPath.resourcesPath;
}

function resolveGithubScopeDirFromSdkEntrypoint(
  sdkEntrypoint: string | undefined,
): string | undefined {
  if (!sdkEntrypoint) {
    return undefined;
  }
  return join(dirname(dirname(sdkEntrypoint)), "..");
}

function resolveNodeModulesRoots(input: {
  currentDir: string;
  resourcesPath?: string;
  sdkEntrypoint?: string;
}): string[] {
  const githubScopeDir = resolveGithubScopeDirFromSdkEntrypoint(input.sdkEntrypoint);
  return dedupePaths([
    input.resourcesPath ? join(input.resourcesPath, "app.asar.unpacked/node_modules") : undefined,
    input.resourcesPath ? join(input.resourcesPath, "node_modules") : undefined,
    join(input.currentDir, "../../../node_modules"),
    join(input.currentDir, "../../../../../node_modules"),
    githubScopeDir ? join(githubScopeDir, "..") : undefined,
  ]);
}

function getCopilotPlatformBinaryName(platform: string): string {
  return platform === "win32" ? "copilot.exe" : "copilot";
}

export function normalizeCopilotCliPathOverride(
  value: string | null | undefined,
): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    COPILOT_PATHLESS_COMMAND_PATTERN.test(trimmed)
  ) {
    return undefined;
  }

  return trimmed;
}

export function getBundledCopilotPlatformPackages(
  platform: string = process.platform,
  arch: string = process.arch,
): ReadonlyArray<string> {
  if (platform === "darwin" && arch === "arm64") {
    return ["copilot-darwin-arm64"];
  }
  if (platform === "darwin" && arch === "x64") {
    return ["copilot-darwin-x64"];
  }
  if (platform === "linux" && arch === "arm64") {
    return ["copilot-linux-arm64"];
  }
  if (platform === "linux" && arch === "x64") {
    return ["copilot-linux-x64"];
  }
  if (platform === "win32" && arch === "arm64") {
    return ["copilot-win32-arm64"];
  }
  if (platform === "win32" && arch === "x64") {
    return ["copilot-win32-x64"];
  }

  return [];
}

export function resolveBundledCopilotCliPathFrom(input: {
  currentDir: string;
  resourcesPath?: string;
  sdkEntrypoint?: string;
  platform?: string;
  arch?: string;
  exists?: (path: string) => boolean;
}): string | undefined {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const exists = input.exists ?? existsSync;
  const nodeModulesRoots = resolveNodeModulesRoots({
    currentDir: input.currentDir,
    ...(input.resourcesPath ? { resourcesPath: input.resourcesPath } : {}),
    ...(input.sdkEntrypoint ? { sdkEntrypoint: input.sdkEntrypoint } : {}),
  });
  const binaryName = getCopilotPlatformBinaryName(platform);
  const platformPackages = getBundledCopilotPlatformPackages(platform, arch);

  const binaryCandidates = nodeModulesRoots.flatMap((root) =>
    platformPackages.map((packageName) => join(root, GITHUB_SCOPE_DIR, packageName, binaryName)),
  );
  const npmLoaderCandidates = nodeModulesRoots.map((root) =>
    join(root, GITHUB_SCOPE_DIR, "copilot", COPILOT_NPM_LOADER),
  );
  for (const candidate of dedupePaths([...binaryCandidates, ...npmLoaderCandidates])) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  const githubScopeDir = resolveGithubScopeDirFromSdkEntrypoint(input.sdkEntrypoint);
  if (!githubScopeDir) {
    return undefined;
  }

  const sdkSiblingBinaryCandidates = platformPackages.map((packageName) =>
    join(githubScopeDir, packageName, binaryName),
  );
  const sdkSiblingLoaderPath = join(githubScopeDir, "copilot", COPILOT_NPM_LOADER);
  for (const candidate of dedupePaths([...sdkSiblingBinaryCandidates, sdkSiblingLoaderPath])) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveBundledCopilotCliPath(): string | undefined {
  const sdkEntrypoint = resolveSdkEntrypoint();
  const resourcesPath = resolveProcessResourcesPath();
  return resolveBundledCopilotCliPathFrom({
    currentDir: CURRENT_DIR,
    ...(resourcesPath ? { resourcesPath } : {}),
    ...(sdkEntrypoint ? { sdkEntrypoint } : {}),
  });
}
