import { existsSync } from "node:fs";
import path from "node:path";

import { isCommandAvailable } from "./open";

export interface CliLaunchSpec {
  readonly command: string;
  readonly argsPrefix: ReadonlyArray<string>;
}

function splitPathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ReadonlyArray<string> {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  if (rawPath.length === 0) {
    return [];
  }

  return rawPath
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter((entry) => entry.length > 0);
}

function resolveGeminiDistFromDirectory(directory: string): string | null {
  const candidate = path.join(directory, "node_modules", "@google", "gemini-cli", "dist", "index.js");
  return existsSync(candidate) ? candidate : null;
}

function resolveGeminiDistFromPath(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  for (const entry of splitPathEntries(env, process.platform)) {
    const candidate = resolveGeminiDistFromDirectory(entry);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function resolveWindowsGeminiDist(env: NodeJS.ProcessEnv): string | null {
  const appDataCandidate = env.APPDATA
    ? path.join(env.APPDATA, "npm", "node_modules", "@google", "gemini-cli", "dist", "index.js")
    : null;
  if (appDataCandidate && existsSync(appDataCandidate)) {
    return appDataCandidate;
  }

  return resolveGeminiDistFromPath(env);
}

function resolveGeminiPackageRootFromDist(distPath: string): string | null {
  const packageRoot = path.dirname(path.dirname(distPath));
  return existsSync(path.join(packageRoot, "package.json")) ? packageRoot : null;
}

export function buildPopupSafeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    NO_BROWSER: baseEnv.NO_BROWSER ?? "true",
    BROWSER: baseEnv.BROWSER ?? "none",
    ...overrides,
  };
}

export function buildNonInteractiveGitEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return buildPopupSafeEnv(baseEnv, {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GCM_MODAL_PROMPT: "false",
    GIT_ASKPASS: "echo",
    SSH_ASKPASS: "echo",
    ...overrides,
  });
}

export function resolveGeminiCliLaunchSpec(env: NodeJS.ProcessEnv = process.env): CliLaunchSpec | null {
  if (process.platform === "win32") {
    const distPath = resolveWindowsGeminiDist(env);
    if (!distPath) {
      return null;
    }
    return {
      command: "node",
      argsPrefix: [distPath],
    };
  }

  if (!isCommandAvailable("gemini", { env, platform: process.platform })) {
    return null;
  }

  return {
    command: "gemini",
    argsPrefix: [],
  };
}

export function resolveGeminiAcpModulePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const launch = resolveGeminiCliLaunchSpec(env);
  const distPath = launch?.argsPrefix[0];
  if (!distPath || !existsSync(distPath)) {
    return null;
  }

  const packageRoot = resolveGeminiPackageRootFromDist(distPath);
  if (!packageRoot) {
    return null;
  }

  const candidate = path.join(
    packageRoot,
    "node_modules",
    "@agentclientprotocol",
    "sdk",
    "dist",
    "acp.js",
  );
  return existsSync(candidate) ? candidate : null;
}

export function isCodexCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCommandAvailable("codex", { env, platform: process.platform });
}

export function isGeminiCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGeminiCliLaunchSpec(env) !== null;
}
