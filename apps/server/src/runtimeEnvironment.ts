import os from "node:os";

import type { ServerRuntimeEnvironment } from "@t3tools/contracts";

interface DetectServerRuntimeEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly osRelease?: string;
}

function normalizePlatform(platform: NodeJS.Platform): ServerRuntimeEnvironment["platform"] {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

function detectWsl(options: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly osRelease: string;
}): boolean {
  if (options.platform !== "linux") {
    return false;
  }

  if (options.env.WSL_DISTRO_NAME || options.env.WSL_INTEROP) {
    return true;
  }

  return options.osRelease.toLowerCase().includes("microsoft");
}

export function detectServerRuntimeEnvironment(
  options: DetectServerRuntimeEnvironmentOptions = {},
): ServerRuntimeEnvironment {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const osRelease = options.osRelease ?? os.release();
  const normalizedPlatform = normalizePlatform(platform);
  const isWsl = detectWsl({ platform, env, osRelease });

  return {
    platform: normalizedPlatform,
    pathStyle: normalizedPlatform === "windows" ? "windows" : "posix",
    isWsl,
    windowsInteropMode: normalizedPlatform === "windows" ? "windows-native" : isWsl ? "wsl-hosted" : null,
    wslDistroName: isWsl ? env.WSL_DISTRO_NAME?.trim() || null : null,
  };
}
