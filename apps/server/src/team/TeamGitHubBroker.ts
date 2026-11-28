// @effect-diagnostics nodeBuiltinImport:off -- Server-owned private Unix socket / loopback broker and helper scripts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  canMemberAccessTeamEnvironment,
  canMemberPostInTeamThread,
  EnvironmentId,
  IsoDateTime,
  RunId,
  TeamGitHubRemoteLeaseIssueResponse as TeamGitHubRemoteLeaseIssueResponseSchema,
  TeamId,
  TeamMemberId,
  ThreadId,
  type AuthSessionId,
  type ProviderSessionId,
  type TeamGitHubAuthMethod,
  type TeamGitHubIdentity,
  type TeamGitHubRemoteLeaseIssueResponse,
  type TeamGitHubRemoteLeaseResolveResponse,
  type TeamGitHubTurnAuthorKind,
} from "@t3tools/contracts";
import {
  TEAM_GITHUB_BROKER_TOKEN_ENV,
  TEAM_GITHUB_SANITIZE_ENV,
} from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as TeamGitHubOAuth from "./TeamGitHubOAuth.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import { localSyncMirroredRunId } from "./TeamLocalSyncService.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

// Stay below macOS's 104-byte and Linux's 108-byte sockaddr_un limits, including NUL.
const UNIX_SOCKET_PATH_BYTES = 100;
const MAX_BROKER_REQUEST_BYTES = 16 * 1024;
const DEFAULT_TURN_LEASE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REMOTE_LEASE_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_REMOTE_LEASE_LIFETIME_MS = 4 * 60 * 60 * 1000;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const TEAM_GH_BROKER_ENDPOINT_ENV = "T3_TEAM_GH_BROKER_ENDPOINT";
const TEAM_GH_BROKER_TOKEN_ENV = TEAM_GITHUB_BROKER_TOKEN_ENV;
const TEAM_GH_BROKER_NODE_ENV = "T3_TEAM_GH_BROKER_NODE";

const encoder = new TextEncoder();

function sha256Hex(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return NodeCrypto.timingSafeEqual(aBytes, bBytes);
}

function normalizeSocketIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = withoutBrackets.split("%")[0] ?? withoutBrackets;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice("::ffff:".length) : withoutZone;
}

function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

function effectiveUrlPort(url: URL): string {
  if (url.port.length > 0) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

/**
 * Derives the exact Git HTTP(S) origin permitted for credentials scoped to `apiBaseUrl`.
 * `https://api.github.com` maps strictly to `https://github.com`; GHE (`https://ghe.corp/api/v3`)
 * and explicitly allowlisted local test servers map strictly to their exact origin.
 */
export function deriveAllowedGitOrigin(apiBaseUrl: string): URL | null {
  try {
    const apiUrl = new URL(apiBaseUrl);
    if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:") {
      return null;
    }
    const hostname = apiUrl.hostname.toLowerCase();
    if (
      apiUrl.protocol === "https:" &&
      (hostname === "api.github.com" || hostname === "github.com") &&
      effectiveUrlPort(apiUrl) === "443"
    ) {
      return new URL("https://github.com");
    }
    return new URL(apiUrl.origin);
  } catch {
    return null;
  }
}

export interface ParsedGitAskpassPrompt {
  readonly kind: "username" | "password";
  readonly targetUrl: URL;
}

export function parseGitAskpassPrompt(prompt: string): ParsedGitAskpassPrompt | null {
  const match =
    /^\s*(username|password)\s+for\s+['"]?([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^'"\s]+)['"]?\s*:?\s*$/i.exec(
      prompt,
    );
  if (!match) return null;
  try {
    const targetUrl = new URL(match[2]!);
    if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
      return null;
    }
    return {
      kind: match[1]!.toLowerCase() === "username" ? "username" : "password",
      targetUrl,
    };
  } catch {
    return null;
  }
}

export function isGitAskpassTargetAllowed(targetUrl: URL, apiBaseUrl: string): boolean {
  const allowed = deriveAllowedGitOrigin(apiBaseUrl);
  if (allowed === null) return false;
  return (
    targetUrl.protocol === allowed.protocol &&
    targetUrl.hostname.toLowerCase() === allowed.hostname.toLowerCase() &&
    effectiveUrlPort(targetUrl) === effectiveUrlPort(allowed)
  );
}

export function resolveAllowedDirectApiTarget(
  endpointPath: string,
  apiBaseUrl: string,
): URL | null {
  const trimmed = endpointPath.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /%2e/i.test(trimmed)
  ) {
    return null;
  }
  let apiBase: URL;
  try {
    apiBase = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  const basePath = apiBase.pathname.replace(/\/+$/, "");
  let target: URL;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      target = new URL(trimmed);
    } else {
      const normalizedRelative = trimmed.replace(/^\/+/, "");
      // Reject relative path traversal segments before URL normalization.
      if (normalizedRelative.split(/[/?#]/).some((seg) => seg === "..")) {
        return null;
      }
      target = new URL(normalizedRelative, `${apiBase.origin}${basePath}/`);
    }
  } catch {
    return null;
  }
  if (
    target.protocol !== apiBase.protocol ||
    target.hostname.toLowerCase() !== apiBase.hostname.toLowerCase() ||
    effectiveUrlPort(target) !== effectiveUrlPort(apiBase)
  ) {
    return null;
  }
  if (
    basePath.length > 0 &&
    target.pathname !== basePath &&
    !target.pathname.startsWith(`${basePath}/`)
  ) {
    return null;
  }
  return target;
}

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildPosixNodeShim(nodeExecPath: string, scriptPath: string): string {
  return `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${posixSingleQuote(nodeExecPath)} ${posixSingleQuote(scriptPath)} "$@"\n`;
}

function buildWindowsNodeCmdShim(nodeExecPath: string, scriptPath: string): string {
  return `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${nodeExecPath}" "${scriptPath}" %*\r\n`;
}

function buildPosixSshGuardScript(): string {
  return `#!/bin/sh\necho "Git SSH transport is disabled in team-isolated sessions to prevent host SSH key fallback. Use an HTTPS remote or a supported GitHub SSH URL (automatically rewritten to broker-authenticated HTTPS)." >&2\nexit 128\n`;
}

function buildWindowsSshGuardScript(): string {
  return `@echo off\r\necho Git SSH transport is disabled in team-isolated sessions to prevent host SSH key fallback. Use an HTTPS remote or a supported GitHub SSH URL (automatically rewritten to broker-authenticated HTTPS). 1>&2\r\nexit /b 128\r\n`;
}

function buildGitWrapperScript(
  wrapperBinDir: string,
  gitHomeDir: string,
  emptyGitConfigPath: string,
): string {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const WRAPPER_BIN_DIR = ${JSON.stringify(wrapperBinDir)};
const GIT_HOME_DIR = ${JSON.stringify(gitHomeDir)};
const EMPTY_GIT_CONFIG_PATH = ${JSON.stringify(emptyGitConfigPath)};
const args = process.argv.slice(2);
const isWin = process.platform === "win32";

function stripEnvKeyCaseInsensitive(env, key) {
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upper) {
      delete env[existing];
    }
  }
}

function sameDir(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return isWin ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function findRealGitBinary() {
  const rawPath = process.env.PATH || "";
  const exeName = isWin ? "git.exe" : "git";
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    if (sameDir(dir, WRAPPER_BIN_DIR)) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function extractGitInvocationInfo(cliArgs) {
  const scopeArgs = [];
  let subcommand = "";
  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (arg === "--") break;
    if ((arg === "-C" || arg === "--git-dir" || arg === "--work-tree") && i + 1 < cliArgs.length) {
      scopeArgs.push(arg, cliArgs[++i]);
      continue;
    }
    if (
      (arg.startsWith("-C") && arg.length > 2) ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=")
    ) {
      scopeArgs.push(arg);
      continue;
    }
    if (
      (arg === "-c" ||
        arg === "--config-env" ||
        arg === "--namespace" ||
        arg === "--super-prefix" ||
        arg === "--attr-source") &&
      i + 1 < cliArgs.length
    ) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      subcommand = arg;
      break;
    }
  }
  return { scopeArgs, subcommand };
}

function appendGitConfigResets(env, keysToReset) {
  if (keysToReset.length === 0) return;
  const rawCount = String(env.GIT_CONFIG_COUNT || "").trim();
  const parsed = /^\\d+$/.test(rawCount) ? Number.parseInt(rawCount, 10) : 0;
  let count = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  for (const key of keysToReset) {
    env["GIT_CONFIG_KEY_" + count] = key;
    env["GIT_CONFIG_VALUE_" + count] = "";
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
}

const realGit = findRealGitBinary();
if (!realGit) {
  process.stderr.write("git binary is not installed on this host.\\n");
  process.exit(127);
}

const childEnv = { ...process.env };
for (const key of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GIT_CONFIG",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "NETRC",
  "CURL_NETRC",
  "CURL_HOME",
  "HOME",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
]) {
  stripEnvKeyCaseInsensitive(childEnv, key);
}
if (isWin) {
  stripEnvKeyCaseInsensitive(childEnv, "USERPROFILE");
  stripEnvKeyCaseInsensitive(childEnv, "HOMEDRIVE");
  stripEnvKeyCaseInsensitive(childEnv, "HOMEPATH");
}
// Isolate HOME/XDG_CONFIG_HOME/NETRC specifically for git subprocesses so libcurl cannot
// read host ~/.netrc and git cannot read host ~/.gitconfig, without disturbing provider HOME.
childEnv.HOME = GIT_HOME_DIR;
if (isWin) {
  childEnv.USERPROFILE = GIT_HOME_DIR;
}
childEnv.XDG_CONFIG_HOME = GIT_HOME_DIR;
childEnv.NETRC = path.join(GIT_HOME_DIR, ".netrc");
childEnv.GIT_CONFIG_NOSYSTEM = "1";
childEnv.GIT_CONFIG_GLOBAL = EMPTY_GIT_CONFIG_PATH;

// Discover effective repository-scoped auth config across .git/config, .git/config.worktree, and
// [include]/[includeIf] files: neutralize http.<url>.(extraHeader|cookieFile) and
// credential.<url>.helper (which outrank origin-level resets), and fail closed on
// credential-bearing or helper-form url.*.(insteadOf|pushInsteadOf) rewrites.
const { scopeArgs: repoScopeArgs, subcommand } = extractGitInvocationInfo(args);
if (subcommand !== "" && subcommand !== "init") {
  const probeEnv = { ...childEnv };
  const safeDirectoryValues = [];
  const rawProbeCount = String(childEnv.GIT_CONFIG_COUNT || "").trim();
  const parsedProbeCount = /^\\d+$/.test(rawProbeCount) ? Number.parseInt(rawProbeCount, 10) : 0;
  if (Number.isSafeInteger(parsedProbeCount) && parsedProbeCount > 0) {
    for (let i = 0; i < parsedProbeCount; i += 1) {
      const k = childEnv["GIT_CONFIG_KEY_" + i];
      const v = childEnv["GIT_CONFIG_VALUE_" + i];
      if (typeof k === "string" && typeof v === "string" && k.trim().toLowerCase() === "safe.directory") {
        safeDirectoryValues.push(v);
      }
    }
  }
  for (const existing of Object.keys(probeEnv)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\\d+|VALUE_\\d+)$/i.test(existing)) {
      delete probeEnv[existing];
    }
  }
  probeEnv.GIT_CONFIG_COUNT = String(safeDirectoryValues.length);
  for (let i = 0; i < safeDirectoryValues.length; i += 1) {
    probeEnv["GIT_CONFIG_KEY_" + i] = "safe.directory";
    probeEnv["GIT_CONFIG_VALUE_" + i] = safeDirectoryValues[i];
  }
  const localAuthKeys = new Set();
  const inspectConfig = (scope) => {
    const probe = spawnSync(
      realGit,
      [
        ...scope,
        "config",
        "--includes",
        "--name-only",
        "--get-regexp",
        "^(http(\\\\..+)?\\\\.(extraheader|cookiefile)|credential(\\\\..+)?\\\\.helper|url\\\\..+\\\\.(insteadof|pushinsteadof))$",
      ],
      { env: probeEnv, encoding: "utf8", timeout: 2000 },
    );
    if (probe.error || (probe.status !== 0 && probe.status !== 1)) {
      const errMsg =
        (typeof probe.stderr === "string" && probe.stderr.trim().length > 0
          ? probe.stderr.trim()
          : "Refused git invocation because effective repository configuration could not be verified.") +
        "\\n";
      process.stderr.write(errMsg);
      process.exit(typeof probe.status === "number" && probe.status > 0 ? probe.status : 128);
    }
    if (probe.status === 0 && typeof probe.stdout === "string") {
      for (const line of probe.stdout.split(/\\r?\\n/)) {
        const key = line.trim();
        if (key.length === 0) continue;
        if (/^url\\..+\\.(?:push)?insteadof$/i.test(key)) {
          const rewriteBase = key
            .replace(/^url\\./i, "")
            .replace(/\\.(?:push)?insteadof$/i, "")
            .trim();
          const strippedBase = rewriteBase.replace(/^(?:[a-z0-9+._-]+::)+/i, "");
          if (
            /^(?:https?|ftps?|ext)::/i.test(rewriteBase) ||
            /^(?:https?|ftps?):\\/\\/[^/]*@/i.test(strippedBase)
          ) {
            process.stderr.write(
              "Refused git invocation because repository configuration contains a credential-bearing or helper-form url.*.insteadOf rewrite.\\n",
            );
            process.exit(128);
          }
          continue;
        }
        localAuthKeys.add(key);
      }
    }
  };
  // Recursively inspect the target repository and all nested submodules (both <git-common-dir>/modules/**
  // and .gitmodules entries, including standalone embedded .git directories and external gitdir pointers)
  // so recursive submodule fetches cannot authenticate using submodule-local headers, cookies,
  // credential helpers, or credential-bearing/helper-form URL rewrites.
  const visitedRepoKeys = new Set();
  const visitedModuleDirs = new Set();
  const repoQueue = [{ scope: repoScopeArgs, workTree: "", depth: 0 }];
  const enqueueGitDir = (gitDirPath, workTree, depth) => {
    if (depth > 8) return;
    let resolved;
    try {
      resolved = fs.realpathSync(gitDirPath);
    } catch {
      resolved = path.resolve(gitDirPath);
    }
    if (visitedRepoKeys.has(resolved)) return;
    visitedRepoKeys.add(resolved);
    repoQueue.push({ scope: ["--git-dir", resolved], workTree, depth });
  };
  const walkModulesDir = (dir, depth) => {
    if (depth > 8) return;
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visitedModuleDirs.has(realDir)) return;
    visitedModuleDirs.add(realDir);
    let entries;
    try {
      entries = fs.readdirSync(realDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const fullPath = path.join(realDir, entry.name);
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (fs.existsSync(path.join(fullPath, "config"))) {
        enqueueGitDir(fullPath, "", depth + 1);
      } else {
        walkModulesDir(fullPath, depth + 1);
      }
    }
  };
  const inspectGitmodulesAt = (toplevel, depth) => {
    if (depth > 8 || toplevel.length === 0) return;
    const gitmodulesPath = path.join(toplevel, ".gitmodules");
    if (!fs.existsSync(gitmodulesPath)) return;
    const subPathsRes = spawnSync(
      realGit,
      ["config", "--file", gitmodulesPath, "--null", "--get-regexp", "^submodule\\\\..*\\\\.path$"],
      { env: probeEnv, encoding: "utf8", timeout: 2000 },
    );
    if (subPathsRes.status !== 0 || typeof subPathsRes.stdout !== "string") return;
    for (const record of subPathsRes.stdout.split("\\0")) {
      if (record.length === 0) continue;
      const nlIdx = record.indexOf("\\n");
      if (nlIdx === -1) continue;
      const relSubPath = record.slice(nlIdx + 1).trim();
      if (relSubPath.length === 0) continue;
      const subWorkTree = path.join(toplevel, relSubPath);
      const subDotGit = path.join(subWorkTree, ".git");
      try {
        const st = fs.statSync(subDotGit);
        if (st.isDirectory()) {
          enqueueGitDir(subDotGit, subWorkTree, depth + 1);
        } else if (st.isFile()) {
          const content = fs.readFileSync(subDotGit, "utf8").trim();
          if (content.startsWith("gitdir:")) {
            const target = content.slice("gitdir:".length).trim();
            const resolvedTarget = path.resolve(path.dirname(subDotGit), target);
            if (fs.existsSync(resolvedTarget)) {
              enqueueGitDir(resolvedTarget, subWorkTree, depth + 1);
            }
          }
        }
      } catch {
        // Submodule not initialized yet
      }
    }
  };
  while (repoQueue.length > 0) {
    const current = repoQueue.shift();
    inspectConfig(current.scope);
    if (current.depth >= 8) continue;
    const commonDirRes = spawnSync(
      realGit,
      [...current.scope, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { env: probeEnv, encoding: "utf8", timeout: 2000 },
    );
    if (commonDirRes.status === 0 && typeof commonDirRes.stdout === "string") {
      const commonDir = commonDirRes.stdout.trim();
      if (commonDir.length > 0) {
        try {
          visitedRepoKeys.add(fs.realpathSync(commonDir));
        } catch {
          visitedRepoKeys.add(path.resolve(commonDir));
        }
        const modulesDir = path.join(commonDir, "modules");
        if (fs.existsSync(modulesDir)) {
          walkModulesDir(modulesDir, current.depth);
        }
      }
    }
    let toplevel = current.workTree;
    if (toplevel.length === 0) {
      const toplevelRes = spawnSync(
        realGit,
        [...current.scope, "rev-parse", "--path-format=absolute", "--show-toplevel"],
        { env: probeEnv, encoding: "utf8", timeout: 2000 },
      );
      if (toplevelRes.status === 0 && typeof toplevelRes.stdout === "string") {
        toplevel = toplevelRes.stdout.trim();
      }
    }
    if (toplevel.length > 0) {
      inspectGitmodulesAt(toplevel, current.depth);
    }
  }
  appendGitConfigResets(childEnv, Array.from(localAuthKeys));
}

const child = spawn(realGit, args, { env: childEnv, stdio: "inherit" });
const forwardSignal = (sig) => {
  try {
    child.kill(sig);
  } catch {
    // ignore
  }
};
process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);
process.on("SIGHUP", forwardSignal);
child.on("error", () => process.exit(1));
child.on("exit", (code, signal) => {
  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);
  process.off("SIGHUP", forwardSignal);
  if (signal) {
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
  }
  process.exit(code === null ? 1 : code);
});
`;
}

const ALLOWED_INHERITED_GIT_CONFIG_KEYS = new Set(["safe.directory"]);

export function buildGitConfigEnv(
  hostEnv: NodeJS.ProcessEnv,
  entries: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): Record<string, string> {
  const rawCount = hostEnv.GIT_CONFIG_COUNT?.trim();
  const parsedCount =
    rawCount !== undefined && /^\d+$/.test(rawCount) ? Number.parseInt(rawCount, 10) : 0;
  const baseCount = Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
  // Emit a self-contained, compacted 0..N-1 sequence retaining only explicitly allowlisted
  // safe inherited keys (e.g. safe.directory) so host include.path, includeIf.*.path,
  // credential-bearing url.*.insteadOf, or auth headers cannot leak into isolated turns.
  const combined: Array<{ readonly key: string; readonly value: string }> = [];
  for (let i = 0; i < baseCount; i += 1) {
    const existingKey = hostEnv[`GIT_CONFIG_KEY_${i}`];
    const existingValue = hostEnv[`GIT_CONFIG_VALUE_${i}`];
    if (existingKey === undefined || existingValue === undefined) continue;
    if (!ALLOWED_INHERITED_GIT_CONFIG_KEYS.has(existingKey.trim().toLowerCase())) continue;
    combined.push({ key: existingKey, value: existingValue });
  }
  for (const entry of entries) {
    combined.push(entry);
  }
  const result: Record<string, string> = {
    GIT_CONFIG_COUNT: String(combined.length),
  };
  for (let i = 0; i < combined.length; i += 1) {
    const entry = combined[i]!;
    result[`GIT_CONFIG_KEY_${i}`] = entry.key;
    result[`GIT_CONFIG_VALUE_${i}`] = entry.value;
  }
  return result;
}

export function isLocalBrokerHttpRequest(
  req: Pick<NodeHttp.IncomingMessage, "headers" | "socket">,
  isUnixSocket: boolean,
): boolean {
  if (
    req.headers["x-forwarded-for"] !== undefined ||
    req.headers.forwarded !== undefined ||
    req.headers["x-real-ip"] !== undefined
  ) {
    return false;
  }
  if (isUnixSocket) {
    return true;
  }
  const remote = normalizeSocketIp(req.socket?.remoteAddress);
  if (remote === null) return false;
  return isLoopbackIp(remote);
}

function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function buildGitAskpassScript(): string {
  return `"use strict";
const http = require("node:http");

const endpoint = process.env.${TEAM_GH_BROKER_ENDPOINT_ENV};
const token = process.env.${TEAM_GH_BROKER_TOKEN_ENV};
const threadId = process.env.T3CODE_THREAD_ID || undefined;
const prompt = process.argv[2] || "";

if (!endpoint || !token) {
  process.exit(1);
}

const body = JSON.stringify({ prompt, ...(threadId ? { threadId } : {}) });
const headers = {
  authorization: "Bearer " + token,
  "content-type": "application/json",
  "content-length": Buffer.byteLength(body),
};

const options = endpoint.startsWith("http://")
  ? (() => {
      const url = new URL(endpoint);
      return {
        hostname: url.hostname,
        port: Number(url.port),
        path: "/v1/git-askpass",
        method: "POST",
        headers,
      };
    })()
  : {
      socketPath: endpoint,
      path: "/v1/git-askpass",
      method: "POST",
      headers,
    };

const req = http.request(options, (res) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    if (res.statusCode !== 200) {
      process.exit(1);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed.value !== "string" || parsed.value.length === 0) {
        process.exit(1);
      }
      process.stdout.write(parsed.value + "\\n");
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
});

req.setTimeout(10000, () => {
  req.destroy();
  process.exit(1);
});
req.on("error", () => process.exit(1));
req.write(body);
req.end();
`;
}

function buildGhWrapperScript(
  wrapperBinDir: string,
  emptyGhConfigDir: string,
  ghRunsDir: string,
): string {
  return `"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WRAPPER_BIN_DIR = ${JSON.stringify(wrapperBinDir)};
const EMPTY_GH_CONFIG_DIR = ${JSON.stringify(emptyGhConfigDir)};
const GH_RUNS_DIR = ${JSON.stringify(ghRunsDir)};
const endpoint = process.env.${TEAM_GH_BROKER_ENDPOINT_ENV};
const brokerToken = process.env.${TEAM_GH_BROKER_TOKEN_ENV};
const threadId = process.env.T3CODE_THREAD_ID || undefined;
const args = process.argv.slice(2);

function effectivePort(url) {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

function resolveAllowedDirectApiTarget(endpointPath, apiBaseUrl) {
  const trimmed = String(endpointPath || "").trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.includes("\\\\") || /%2e/i.test(trimmed)) {
    return null;
  }
  let apiBase;
  try {
    apiBase = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  const basePath = apiBase.pathname.replace(/\\/+$/, "");
  let target;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      target = new URL(trimmed);
    } else {
      const rel = trimmed.replace(/^\\/+/, "");
      if (rel.split(/[/?#]/).some((seg) => seg === "..")) {
        return null;
      }
      target = new URL(rel, apiBase.origin + basePath + "/");
    }
  } catch {
    return null;
  }
  if (
    target.protocol !== apiBase.protocol ||
    target.hostname.toLowerCase() !== apiBase.hostname.toLowerCase() ||
    effectivePort(target) !== effectivePort(apiBase)
  ) {
    return null;
  }
  if (basePath.length > 0 && target.pathname !== basePath && !target.pathname.startsWith(basePath + "/")) {
    return null;
  }
  return target;
}

function extractRepoFlagHost(repoVal) {
  const trimmed = String(repoVal || "").trim();
  if (!trimmed) return null;
  if (/^https?:\\/\\//i.test(trimmed)) {
    try {
      return new URL(trimmed).host.toLowerCase();
    } catch {
      return "__invalid__";
    }
  }
  const parts = trimmed.split("/");
  if (parts.length >= 3 && parts[0]) {
    return parts[0].toLowerCase();
  }
  return null;
}

function extractApiEndpointArg(apiArgs) {
  for (let i = 0; i < apiArgs.length; i += 1) {
    const arg = apiArgs[i];
    if (arg === "--") {
      return apiArgs[i + 1] || "";
    }
    if (
      arg === "-X" ||
      arg === "--method" ||
      arg === "-H" ||
      arg === "--header" ||
      arg === "-f" ||
      arg === "--raw-field" ||
      arg === "-F" ||
      arg === "--field" ||
      arg === "-q" ||
      arg === "--jq" ||
      arg === "-t" ||
      arg === "--template" ||
      arg === "-p" ||
      arg === "--preview" ||
      arg === "--input" ||
      arg === "--cache" ||
      arg === "--hostname"
    ) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return "";
}

function extractRequestedGhHosts(cliArgs) {
  const subcommand = cliArgs[0] || "";
  const hosts = [];
  let afterDoubleDash = false;
  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash) {
      if (arg === "--hostname" && cliArgs[i + 1]) {
        hosts.push(cliArgs[++i].trim().toLowerCase());
        continue;
      }
      if (arg.startsWith("--hostname=")) {
        hosts.push(arg.slice("--hostname=".length).trim().toLowerCase());
        continue;
      }
      if (subcommand === "auth" || subcommand === "config") {
        if (arg === "-h" && cliArgs[i + 1] && !cliArgs[i + 1].startsWith("-")) {
          hosts.push(cliArgs[++i].trim().toLowerCase());
          continue;
        }
        if (arg.startsWith("-h=")) {
          hosts.push(arg.slice("-h=".length).trim().toLowerCase());
          continue;
        }
        if (arg.startsWith("-h") && arg.length > 2) {
          hosts.push(arg.slice(2).trim().toLowerCase());
          continue;
        }
      }
      if ((arg === "-R" || arg === "--repo") && cliArgs[i + 1]) {
        const h = extractRepoFlagHost(cliArgs[++i]);
        if (h) hosts.push(h);
        continue;
      }
      if (arg.startsWith("--repo=")) {
        const h = extractRepoFlagHost(arg.slice("--repo=".length));
        if (h) hosts.push(h);
        continue;
      }
      if (arg.startsWith("-R=")) {
        const h = extractRepoFlagHost(arg.slice("-R=".length));
        if (h) hosts.push(h);
        continue;
      }
      if (arg.startsWith("-R") && arg.length > 2) {
        const h = extractRepoFlagHost(arg.slice(2));
        if (h) hosts.push(h);
        continue;
      }
    }
  }
  return hosts;
}

function stripEnvKeyCaseInsensitive(env, key) {
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upper) {
      delete env[existing];
    }
  }
}

function requestBroker() {
  return new Promise((resolve, reject) => {
    if (!endpoint || !brokerToken) {
      reject(new Error("Missing broker configuration."));
      return;
    }
    const body = JSON.stringify({ args, ...(threadId ? { threadId } : {}) });
    const headers = {
      authorization: "Bearer " + brokerToken,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    const options = endpoint.startsWith("http://")
      ? (() => {
          const url = new URL(endpoint);
          return {
            hostname: url.hostname,
            port: Number(url.port),
            path: "/v1/gh-token",
            method: "POST",
            headers,
          };
        })()
      : {
          socketPath: endpoint,
          path: "/v1/gh-token",
          method: "POST",
          headers,
        };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error("Broker rejected credential request (" + res.statusCode + ")."));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Broker request timed out."));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function findRealGhBinary() {
  const rawPath = process.env.PATH || "";
  const isWin = process.platform === "win32";
  const resolvedWrapperDir = isWin
    ? path.resolve(WRAPPER_BIN_DIR).toLowerCase()
    : path.resolve(WRAPPER_BIN_DIR);
  const exeName = isWin ? "gh.exe" : "gh";
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const resolvedDir = isWin ? path.resolve(dir).toLowerCase() : path.resolve(dir);
    if (resolvedDir === resolvedWrapperDir) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function runDirectApi(lease, apiArgs) {
  return new Promise((resolve) => {
    let method = "GET";
    let methodExplicit = false;
    const extraHeaders = {};
    const fields = {};
    let hasFields = false;
    let endpointPath = "";
    for (let i = 0; i < apiArgs.length; i += 1) {
      const arg = apiArgs[i];
      if ((arg === "-X" || arg === "--method") && apiArgs[i + 1]) {
        method = apiArgs[++i].toUpperCase();
        methodExplicit = true;
      } else if ((arg === "-H" || arg === "--header") && apiArgs[i + 1]) {
        const hdr = apiArgs[++i];
        const idx = hdr.indexOf(":");
        if (idx > 0) {
          extraHeaders[hdr.slice(0, idx).trim().toLowerCase()] = hdr.slice(idx + 1).trim();
        }
      } else if ((arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") && apiArgs[i + 1]) {
        const pair = apiArgs[++i];
        const idx = pair.indexOf("=");
        if (idx > 0) {
          fields[pair.slice(0, idx)] = pair.slice(idx + 1);
          hasFields = true;
        }
      } else if (arg === "--hostname" && apiArgs[i + 1]) {
        i += 1;
      } else if (!arg.startsWith("-") && !endpointPath) {
        endpointPath = arg;
      }
    }
    if (!endpointPath) {
      process.stderr.write("Missing API endpoint path.\\n");
      resolve(1);
      return;
    }
    if (hasFields && !methodExplicit) {
      method = "POST";
    }
    const target = resolveAllowedDirectApiTarget(endpointPath, lease.apiBaseUrl);
    if (!target) {
      process.stderr.write("Refused gh api request outside the configured GitHub API origin.\\n");
      resolve(1);
      return;
    }
    const payload = hasFields ? JSON.stringify(fields) : undefined;
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "t3code-teams-gh",
      ...extraHeaders,
      authorization: "Bearer " + lease.token,
      ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
    };
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const out = Buffer.concat(chunks);
          if (out.length > 0) process.stdout.write(out);
          resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
        });
      },
    );
    req.setTimeout(30000, () => {
      req.destroy();
      process.stderr.write("GitHub API request timed out.\\n");
      resolve(1);
    });
    req.on("error", (err) => {
      process.stderr.write(String(err.message || err) + "\\n");
      resolve(1);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  let lease;
  try {
    lease = await requestBroker();
  } catch {
    process.stderr.write("GitHub credentials are not available for the active turn.\\n");
    process.exit(1);
  }
  if (!lease || typeof lease.token !== "string" || lease.token.length === 0) {
    process.stderr.write("GitHub credentials are not available for the active turn.\\n");
    process.exit(1);
  }
  let apiUrl;
  try {
    apiUrl = new URL(lease.apiBaseUrl || "https://api.github.com");
  } catch {
    process.stderr.write("Configured GitHub API URL is invalid.\\n");
    process.exit(1);
  }
  const isEnterprise =
    apiUrl.hostname.toLowerCase() !== "api.github.com" &&
    apiUrl.hostname.toLowerCase() !== "github.com";
  const expectedHost = isEnterprise ? apiUrl.host.toLowerCase() : "github.com";
  const requestedHosts = extractRequestedGhHosts(args);
  for (const requestedHost of requestedHosts) {
    if (
      requestedHost !== expectedHost &&
      !(isEnterprise && requestedHost === apiUrl.hostname.toLowerCase())
    ) {
      process.stderr.write(
        "Refused GitHub CLI invocation targeting host '" + requestedHost + "' (expected '" + expectedHost + "').\\n",
      );
      process.exit(1);
    }
  }
  if (args[0] === "api") {
    const endpointArg = extractApiEndpointArg(args.slice(1));
    if (endpointArg && !resolveAllowedDirectApiTarget(endpointArg, lease.apiBaseUrl)) {
      process.stderr.write("Refused gh api request outside the configured GitHub API origin.\\n");
      process.exit(1);
    }
  }
  const hasHelpFlag =
    args.includes("--help") ||
    args.some((a, idx) => a === "-h" && (!args[idx + 1] || args[idx + 1].startsWith("-")));
  if (args[0] === "auth" && args[1] === "token" && !hasHelpFlag) {
    process.stdout.write(lease.token + "\\n");
    process.exit(0);
  }
  if (args[0] === "auth" && args[1] === "status" && !hasHelpFlag && apiUrl.protocol === "http:") {
    process.stdout.write("Logged in as " + lease.githubLogin + " (" + lease.apiBaseUrl + ")\\n");
    process.exit(0);
  }
  if (args[0] === "api" && !hasHelpFlag && apiUrl.protocol === "http:") {
    const code = await runDirectApi(lease, args.slice(1));
    process.exit(code);
  }
  const realGh = findRealGhBinary();
  if (!realGh) {
    if (args[0] === "api" && !hasHelpFlag) {
      const code = await runDirectApi(lease, args.slice(1));
      process.exit(code);
    }
    process.stderr.write("gh CLI is not installed on this host.\\n");
    process.exit(127);
  }
  const childEnv = { ...process.env };
  stripEnvKeyCaseInsensitive(childEnv, "GH_TOKEN");
  stripEnvKeyCaseInsensitive(childEnv, "GITHUB_TOKEN");
  stripEnvKeyCaseInsensitive(childEnv, "GH_ENTERPRISE_TOKEN");
  stripEnvKeyCaseInsensitive(childEnv, "GITHUB_ENTERPRISE_TOKEN");
  stripEnvKeyCaseInsensitive(childEnv, "GITHUB_PAT");
  stripEnvKeyCaseInsensitive(childEnv, "GH_HOST");
  stripEnvKeyCaseInsensitive(childEnv, "GH_CONFIG_DIR");
  stripEnvKeyCaseInsensitive(childEnv, "GH_PROMPT_DISABLED");
  childEnv.GH_PROMPT_DISABLED = "1";
  let ephemeralConfigDir = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !ephemeralConfigDir) return;
    cleaned = true;
    try {
      fs.rmSync(ephemeralConfigDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };
  if (hasHelpFlag) {
    childEnv.GH_CONFIG_DIR = EMPTY_GH_CONFIG_DIR;
  } else {
    // Scope credentials strictly to expectedHost via an ephemeral hosts.yml instead of wildcard
    // GH_ENTERPRISE_TOKEN / GH_TOKEN env vars so upstream gh refuses to transmit tokens to any
    // foreign host (whether from positional HOST/OWNER/REPO args or untrusted .git/config remotes).
    // Include both channelHash and threadHash so turn-scoped sweeps on multi-thread sessions
    // never delete a sibling thread's live hosts.yml.
    const channelHash = crypto.createHash("sha256").update(String(brokerToken || "")).digest("hex").slice(0, 12);
    const resolvedThreadId = typeof lease.threadId === "string" && lease.threadId.length > 0 ? lease.threadId : (threadId || "");
    const threadHash = crypto.createHash("sha256").update(String(resolvedThreadId)).digest("hex").slice(0, 12);
    ephemeralConfigDir = fs.mkdtempSync(
      path.join(GH_RUNS_DIR, "run-" + channelHash + "-" + threadHash + "-" + process.pid + "-"),
    );
    process.on("exit", cleanup);
    try {
      if (process.platform !== "win32") {
        fs.chmodSync(ephemeralConfigDir, 0o700);
      }
      const hostsYml =
        JSON.stringify(expectedHost) +
        ":\\n" +
        "  oauth_token: " +
        JSON.stringify(lease.token) +
        "\\n" +
        "  user: " +
        JSON.stringify(lease.githubLogin || "x-access-token") +
        "\\n" +
        "  git_protocol: https\\n";
      fs.writeFileSync(path.join(ephemeralConfigDir, "hosts.yml"), hostsYml, {
        encoding: "utf8",
        mode: 0o600,
      });
      childEnv.GH_CONFIG_DIR = ephemeralConfigDir;
      if (isEnterprise) {
        childEnv.GH_HOST = expectedHost;
      }
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  const exitCode = await new Promise((resolve) => {
    const child = spawn(realGh, args, { env: childEnv, stdio: "inherit" });
    const onSignal = (sig) => {
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
      cleanup();
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGHUP" ? 1 : 15));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    const finish = (code) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      cleanup();
      resolve(code);
    };
    child.on("error", () => finish(1));
    child.on("exit", (code, signal) => {
      if (signal) {
        finish(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
        return;
      }
      finish(code === null ? 1 : code);
    });
  });
  process.exit(exitCode);
})();
`;
}

export interface TeamGitHubBrokerStartErrorCause {
  readonly cause: unknown;
}

export class TeamGitHubBrokerStartError extends Schema.TaggedError<TeamGitHubBrokerStartError>()(
  "TeamGitHubBrokerStartError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not start the local turn-scoped GitHub credential broker.";
  }
}

interface SessionBrokerChannel {
  readonly token: string;
  readonly providerSessionId: ProviderSessionId;
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly credentialGeneration: number;
}

type LocalTurnLeaseSource =
  | {
      readonly kind: "local";
      readonly teamId: TeamId;
      readonly credentialUpdatedAt: string | null;
    }
  | {
      readonly kind: "remote";
      readonly teamServerUrl: string;
      readonly environmentId: EnvironmentId;
      readonly leaseId: string;
      readonly leaseToken: string;
    };

interface ActiveTurnLease {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly providerSessionId: ProviderSessionId | null;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly expiresAtMs: number;
  readonly revoked: boolean;
  readonly source: LocalTurnLeaseSource;
}

interface IssuedRemoteTurnLease {
  readonly leaseId: string;
  readonly leaseTokenHash: string;
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly issuingSessionId: AuthSessionId | null;
  readonly credentialUpdatedAt: string;
  readonly expiresAt: IsoDateTime;
  readonly expiresAtMs: number;
  readonly maxExpiresAtMs: number;
}

interface ResolvedBrokerCredential {
  readonly token: string;
  readonly authMethod: TeamGitHubAuthMethod;
  readonly githubLogin: string;
  readonly githubName: string | null;
  readonly githubEmail: string | null;
  readonly apiBaseUrl: string;
  readonly threadId?: ThreadId;
}

const RemoteLeaseResolveResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.NonEmptyString,
    authMethod: Schema.Literals(["pat", "oauth", "github_app"]),
    githubLogin: Schema.NonEmptyString,
    githubName: Schema.NullOr(Schema.String),
    githubEmail: Schema.NullOr(Schema.String),
    apiBaseUrl: Schema.NonEmptyString,
    expiresAt: Schema.NonEmptyString,
  }),
);
const decodeRemoteResolveResponse = Schema.decodeUnknownOption(RemoteLeaseResolveResponseSchema);

const RemoteLeaseRenewResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    expiresAt: Schema.NonEmptyString,
  }),
);
const decodeRemoteRenewResponse = Schema.decodeUnknownOption(RemoteLeaseRenewResponseSchema);

const decodeRemoteIssueResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(TeamGitHubRemoteLeaseIssueResponseSchema),
);

const BrokerAskpassRequestSchema = Schema.fromJsonString(
  Schema.Struct({
    prompt: Schema.optionalKey(Schema.String),
    threadId: Schema.optionalKey(Schema.String),
  }),
);
const decodeAskpassRequest = Schema.decodeUnknownOption(BrokerAskpassRequestSchema);
const BrokerGhTokenRequestSchema = Schema.fromJsonString(
  Schema.Struct({
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    threadId: Schema.optionalKey(Schema.String),
  }),
);
const decodeGhTokenRequest = Schema.decodeUnknownOption(BrokerGhTokenRequestSchema);
const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function readHttpBody(req: NodeHttp.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BROKER_REQUEST_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

function writeJson(res: NodeHttp.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export interface PrepareGitHubSessionEnvironmentInput {
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly identityOverride?:
    | (Pick<TeamGitHubIdentity, "githubLogin" | "githubName" | "githubEmail"> & {
        readonly apiBaseUrl?: string;
      })
    | null;
}

export interface ActivateLocalTurnLeaseInput {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly providerSessionId: ProviderSessionId | null;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly ttlMs?: number;
}

export interface ActivateRemoteTurnLeaseInput {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly providerSessionId: ProviderSessionId | null;
  readonly environmentId: EnvironmentId;
  readonly teamServerUrl: string;
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly expiresAt: IsoDateTime;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
}

export interface IssueRemoteTurnLeaseInput {
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly issuingSessionId?: AuthSessionId | null;
  readonly ttlMs?: number;
  readonly maxLifetimeMs?: number;
}

export interface ResolveRemoteTurnLeaseInput {
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
}

export interface RequestRemoteTurnLeaseInput {
  readonly teamServerUrl: string;
  readonly memberToken: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly authorKind?: TeamGitHubTurnAuthorKind;
}

export class TeamGitHubBroker extends Context.Service<
  TeamGitHubBroker,
  {
    readonly getEndpoint: () => Effect.Effect<string | null>;
    readonly getCredentialGeneration: (input: {
      readonly authorKind: TeamGitHubTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
    }) => Effect.Effect<number>;
    readonly getSessionCredentialGeneration: (
      providerSessionId: ProviderSessionId,
    ) => Effect.Effect<number | null>;
    readonly prepareSessionEnvironment: (
      input: PrepareGitHubSessionEnvironmentInput,
    ) => Effect.Effect<Readonly<Record<string, string>>, TeamGitHubBrokerStartError>;
    readonly attachThreadToSessionChannel: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly detachThreadFromSessionChannel: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly revokeSessionChannel: (providerSessionId: ProviderSessionId) => Effect.Effect<void>;
    readonly activateLocalTurnLease: (input: ActivateLocalTurnLeaseInput) => Effect.Effect<void>;
    readonly activateRemoteTurnLease: (input: ActivateRemoteTurnLeaseInput) => Effect.Effect<void>;
    readonly requestRemoteTurnLease: (
      input: RequestRemoteTurnLeaseInput,
    ) => Effect.Effect<TeamGitHubRemoteLeaseIssueResponse | null>;
    readonly revokeIssuedRemoteLease: (input: {
      readonly teamServerUrl: string;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly leaseId: string;
      readonly leaseToken: string;
    }) => Effect.Effect<void>;
    readonly revokeTurnLease: (input: {
      readonly threadId: ThreadId;
      readonly turnId?: string | null;
    }) => Effect.Effect<void>;
    readonly renewTurnLease: (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly ttlMs?: number;
    }) => Effect.Effect<boolean>;
    readonly revokeMemberLeases: (memberId: TeamMemberId) => Effect.Effect<void>;
    readonly revokeAutomationLeases: (teamId: TeamId) => Effect.Effect<void>;
    readonly revokeEnvironmentLeases: (input: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly revokedMemberIds?: ReadonlyArray<TeamMemberId>;
    }) => Effect.Effect<void>;
    readonly hasActiveTurnLease: (input: {
      readonly threadId: ThreadId;
      readonly turnId?: string | null;
    }) => Effect.Effect<boolean>;
    readonly issueRemoteTurnLease: (
      input: IssueRemoteTurnLeaseInput,
    ) => Effect.Effect<TeamGitHubRemoteLeaseIssueResponse>;
    readonly resolveRemoteTurnLease: (
      input: ResolveRemoteTurnLeaseInput,
    ) => Effect.Effect<TeamGitHubRemoteLeaseResolveResponse | null>;
    readonly renewRemoteTurnLease: (
      input: ResolveRemoteTurnLeaseInput & { readonly ttlMs?: number },
    ) => Effect.Effect<{ readonly expiresAt: IsoDateTime } | null>;
    readonly revokeRemoteTurnLease: (input: {
      readonly teamId?: TeamId;
      readonly leaseId?: string;
      readonly leaseToken?: string;
      readonly environmentId?: EnvironmentId;
      readonly threadId?: ThreadId;
      readonly turnId?: string;
      readonly authorizedMemberId?: TeamMemberId;
      readonly authorizeLease?: (lease: {
        readonly teamId: TeamId;
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly turnId: string;
        readonly authorKind: TeamGitHubTurnAuthorKind;
        readonly authorMemberId: TeamMemberId | null;
      }) => Effect.Effect<boolean>;
    }) => Effect.Effect<boolean>;
  }
>()("t3/team/TeamGitHubBroker") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const nodeExecPath = yield* HostProcess.ExecutablePath;
  const hostEnv = yield* HostProcess.Environment;
  const secretsOption = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const teamRepoOption = yield* Effect.serviceOption(TeamRepository.TeamRepository);
  const githubRepoOption = yield* Effect.serviceOption(TeamGitHubRepository.TeamGitHubRepository);
  const teamServiceOption = yield* Effect.serviceOption(TeamService.TeamService);
  const httpClientOption = yield* Effect.serviceOption(HttpClient.HttpClient);
  const authSessionsOption = yield* Effect.serviceOption(AuthSessions.AuthSessionRepository);
  const projectionStoreOption = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);

  const isIssuingSessionActive = Effect.fn("TeamGitHubBroker.isIssuingSessionActive")(function* (
    sessionId: AuthSessionId | null,
    authorKind: TeamGitHubTurnAuthorKind,
    nowMs: number,
  ): Effect.fn.Return<boolean> {
    if (sessionId === null) {
      return true;
    }
    if (Option.isNone(authSessionsOption)) {
      return false;
    }
    const sessionOpt = yield* authSessionsOption.value
      .getById({ sessionId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(sessionOpt)) {
      return false;
    }
    const session = sessionOpt.value;
    return (
      session.revokedAt === null &&
      DateTime.toEpochMillis(session.expiresAt) > nowMs &&
      session.scopes.includes(AuthOrchestrationOperateScope) &&
      (authorKind !== "team_automation" || session.scopes.includes(AuthAccessWriteScope))
    );
  });

  const isTurnStillActive = Effect.fn("TeamGitHubBroker.isTurnStillActive")(function* (
    threadId: ThreadId,
    turnId: string,
  ): Effect.fn.Return<boolean> {
    if (Option.isNone(projectionStoreOption)) {
      return true;
    }
    const store = projectionStoreOption.value;
    return yield* Effect.gen(function* () {
      const run =
        (yield* store.getRun(threadId, RunId.make(turnId))) ??
        (yield* store.getRun(threadId, localSyncMirroredRunId(threadId, turnId)));
      return run === undefined || !TERMINAL_RUN_STATUSES.has(run.status);
    }).pipe(
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(true) }),
      Effect.orElseSucceed(() => false),
    );
  });

  const channelsRef = yield* Ref.make<ReadonlyMap<string, SessionBrokerChannel>>(new Map());
  const activeTurnLeasesRef = yield* Ref.make<ReadonlyMap<string, ActiveTurnLease>>(new Map());
  const remoteLeasesRef = yield* Ref.make<ReadonlyMap<string, IssuedRemoteTurnLease>>(new Map());
  const memberCredGenRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const automationCredGenRef = yield* Ref.make<number>(0);

  const canUseRemoteLease = Effect.fnUntraced(function* (
    lease: Pick<
      IssuedRemoteTurnLease,
      | "teamId"
      | "environmentId"
      | "threadId"
      | "turnId"
      | "authorKind"
      | "authorMemberId"
      | "issuingSessionId"
    >,
  ) {
    if (!(yield* isTurnStillActive(lease.threadId, lease.turnId))) return false;
    if (Option.isSome(teamRepoOption)) {
      const repo = teamRepoOption.value;
      const authorized = yield* Effect.gen(function* () {
        const environment = yield* repo.getEnvironmentByEnvironmentId(lease);
        if (Option.isNone(environment)) return false;
        if (lease.authorKind !== "member") return true;
        if (lease.authorMemberId === null) return false;
        const member = yield* repo.getMemberById(lease.authorMemberId);
        if (
          Option.isNone(member) ||
          member.value.teamId !== lease.teamId ||
          !canMemberAccessTeamEnvironment(member.value, environment.value)
        )
          return false;
        const attribution = yield* repo.getThreadAttribution(lease.threadId);
        if (Option.isNone(attribution))
          return !environment.value.isDefault || lease.issuingSessionId === null;
        if (
          attribution.value.teamId !== lease.teamId ||
          (attribution.value.executionEnvironmentId !== null &&
            attribution.value.executionEnvironmentId !== lease.environmentId)
        )
          return false;
        const view = yield* repo.getViewById(attribution.value.viewId);
        return canMemberPostInTeamThread({
          member: member.value,
          attribution: attribution.value,
          view: Option.filter(view, (record) => record.teamId === lease.teamId).pipe(
            Option.getOrNull,
          ),
        });
      }).pipe(Effect.orElseSucceed(() => false));
      if (!authorized) return false;
    }
    const now = yield* Clock.currentTimeMillis;
    return yield* isIssuingSessionActive(lease.issuingSessionId, lease.authorKind, now);
  });

  const removeRemoteLease = (leaseId: string) =>
    Ref.update(remoteLeasesRef, (current) => {
      if (!current.has(leaseId)) return current;
      const next = new Map(current);
      next.delete(leaseId);
      return next;
    });

  const readRemoteLease = Effect.fnUntraced(function* (input: ResolveRemoteTurnLeaseInput) {
    const lease = (yield* Ref.get(remoteLeasesRef)).get(input.leaseId);
    if (
      !lease ||
      lease.environmentId !== input.environmentId ||
      lease.threadId !== input.threadId ||
      lease.turnId !== input.turnId ||
      !timingSafeStringEqual(sha256Hex(input.leaseToken), lease.leaseTokenHash)
    )
      return null;
    const now = yield* Clock.currentTimeMillis;
    if (lease.expiresAtMs <= now || !(yield* canUseRemoteLease(lease))) {
      yield* removeRemoteLease(lease.leaseId);
      return null;
    }
    return lease;
  });

  const turnLeaseKey = (threadId: ThreadId, turnId: string) => `${threadId}::${turnId}`;

  const resolveLocalCredential = Effect.fn("TeamGitHubBroker.resolveLocalCredential")(
    function* (input: {
      readonly teamId: TeamId;
      readonly authorKind: TeamGitHubTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
      readonly expectedUpdatedAt?: string | null;
      readonly enforceDefaultEnvironmentAcl?: boolean;
    }): Effect.fn.Return<ResolvedBrokerCredential | null> {
      if (Option.isNone(secretsOption) || Option.isNone(githubRepoOption)) {
        return null;
      }
      if (input.authorKind === "team_automation") {
        const recordOpt = yield* githubRepoOption.value
          .getAutomationCredential(input.teamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(recordOpt)) {
          // Unconfigured team-automation cleanly receives zero GitHub credentials (never borrows a member's PAT).
          return null;
        }
        if (
          input.expectedUpdatedAt !== undefined &&
          input.expectedUpdatedAt !== null &&
          recordOpt.value.updatedAt !== input.expectedUpdatedAt
        ) {
          return null;
        }
        const secret = yield* TeamGitHubRepository.readTeamGitHubSecret(
          secretsOption.value,
          recordOpt.value.secretKey,
        ).pipe(Effect.orElseSucceed(() => null));
        if (!secret || secret.accessToken.trim().length === 0) return null;
        return {
          token: secret.accessToken,
          authMethod: secret.authMethod,
          githubLogin: recordOpt.value.githubLogin,
          githubName: recordOpt.value.githubName,
          githubEmail: recordOpt.value.githubEmail,
          apiBaseUrl: recordOpt.value.apiBaseUrl,
        };
      }

      if (input.authorMemberId === null) {
        return null;
      }
      if (Option.isSome(teamRepoOption)) {
        const memberOpt = yield* teamRepoOption.value
          .getMemberById(input.authorMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          Option.isNone(memberOpt) ||
          memberOpt.value.teamId !== input.teamId ||
          memberOpt.value.status !== "active"
        ) {
          return null;
        }
        if (input.enforceDefaultEnvironmentAcl === true) {
          const envsOpt = yield* teamRepoOption.value
            .listEnvironments(input.teamId)
            .pipe(Effect.option);
          if (Option.isNone(envsOpt)) {
            return null;
          }
          const defaultEnv = envsOpt.value.find((env) => env.isDefault);
          if (
            defaultEnv !== undefined &&
            !canMemberAccessTeamEnvironment(memberOpt.value, defaultEnv)
          ) {
            return null;
          }
        }
      }
      const resolved = yield* TeamGitHubOAuth.resolveFreshMemberGitHubCredential({
        teamId: input.teamId,
        memberId: input.authorMemberId,
        githubRepo: githubRepoOption.value,
        secrets: secretsOption.value,
        ...(Option.isSome(httpClientOption) ? { httpClient: httpClientOption.value } : {}),
        ...(input.expectedUpdatedAt !== undefined
          ? { expectedUpdatedAt: input.expectedUpdatedAt }
          : {}),
        onIdentityUpdated: (identity) =>
          Option.isSome(teamServiceOption)
            ? teamServiceOption.value.publishMemberGitHubIdentityUpdate({
                memberId: input.authorMemberId!,
                identity,
              })
            : Effect.void,
        onRefreshRevoked: (revokedMemberId) => revokeMemberLeases(revokedMemberId),
      });
      if (resolved === null) {
        return null;
      }
      return {
        token: resolved.token,
        authMethod: resolved.authMethod,
        githubLogin: resolved.githubLogin,
        githubName: resolved.githubName,
        githubEmail: resolved.githubEmail,
        apiBaseUrl: resolved.apiBaseUrl,
      };
    },
  );

  const resolveRemoteLeaseFromServer = Effect.fn("TeamGitHubBroker.resolveRemoteLeaseFromServer")(
    function* (lease: ActiveTurnLease): Effect.fn.Return<ResolvedBrokerCredential | null> {
      if (lease.source.kind !== "remote") return null;
      const client = Option.isSome(httpClientOption)
        ? httpClientOption.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const url = `${lease.source.teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/resolve`;
      const req = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyText(
          encodeJsonUnknown({
            leaseId: lease.source.leaseId,
            leaseToken: lease.source.leaseToken,
            environmentId: lease.source.environmentId,
            threadId: lease.threadId,
            turnId: lease.turnId,
          }),
          "application/json",
        ),
      );
      const res = yield* client
        .execute(req)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("10 seconds"),
          Effect.option,
        );
      if (Option.isNone(res)) return null;
      if (res.value.status === 401 || res.value.status === 403 || res.value.status === 404) {
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          const key = turnLeaseKey(lease.threadId, lease.turnId);
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        return null;
      }
      if (res.value.status < 200 || res.value.status >= 300) return null;
      const text = yield* res.value.text.pipe(Effect.orElseSucceed(() => ""));
      const parsed = decodeRemoteResolveResponse(text);
      if (Option.isNone(parsed)) return null;
      return {
        token: parsed.value.token,
        authMethod: parsed.value.authMethod,
        githubLogin: parsed.value.githubLogin,
        githubName: parsed.value.githubName,
        githubEmail: parsed.value.githubEmail,
        apiBaseUrl: parsed.value.apiBaseUrl,
      };
    },
  );

  const resolveActiveCredentialForChannel = Effect.fn(
    "TeamGitHubBroker.resolveActiveCredentialForChannel",
  )(function* (
    channel: SessionBrokerChannel,
    requestedThreadId?: string,
  ): Effect.fn.Return<ResolvedBrokerCredential | null> {
    const hasExplicitThreadId = requestedThreadId !== undefined && requestedThreadId.length > 0;
    const isMultiThreadChannel = channel.attachedThreadIds.size > 1;
    // On multi-thread sessions (e.g. Codex), strictly require and match the requesting thread's
    // own lease; on single-thread sessions, ignore an unrelated outer T3CODE_THREAD_ID (e.g. nested T3 server).
    if (
      isMultiThreadChannel &&
      (!hasExplicitThreadId || !channel.attachedThreadIds.has(requestedThreadId as ThreadId))
    ) {
      return null;
    }
    const filterThreadId =
      hasExplicitThreadId && channel.attachedThreadIds.has(requestedThreadId as ThreadId)
        ? (requestedThreadId as ThreadId)
        : null;
    const nowMs = yield* Clock.currentTimeMillis;
    const leases = yield* Ref.get(activeTurnLeasesRef);
    let matchedLease: ActiveTurnLease | null = null;
    for (const candidate of leases.values()) {
      if (!channel.attachedThreadIds.has(candidate.threadId)) continue;
      if (filterThreadId !== null && candidate.threadId !== filterThreadId) {
        continue;
      }
      if (candidate.revoked || candidate.expiresAtMs <= nowMs) continue;
      if (
        candidate.authorKind !== channel.authorKind ||
        candidate.authorMemberId !== channel.authorMemberId
      ) {
        continue;
      }
      if (
        candidate.providerSessionId !== null &&
        candidate.providerSessionId !== channel.providerSessionId
      ) {
        continue;
      }
      matchedLease = candidate;
      break;
    }
    if (matchedLease === null) return null;
    const resolved =
      matchedLease.source.kind === "remote"
        ? yield* resolveRemoteLeaseFromServer(matchedLease)
        : yield* resolveLocalCredential({
            teamId: matchedLease.source.teamId,
            authorKind: matchedLease.authorKind,
            authorMemberId: matchedLease.authorMemberId,
            expectedUpdatedAt: matchedLease.source.credentialUpdatedAt,
            enforceDefaultEnvironmentAcl: true,
          });
    if (resolved === null) return null;
    return { ...resolved, threadId: matchedLease.threadId };
  });

  const findChannelByToken = Effect.fn("TeamGitHubBroker.findChannelByToken")(function* (
    presentedToken: string,
  ): Effect.fn.Return<SessionBrokerChannel | null> {
    const channels = yield* Ref.get(channelsRef);
    for (const channel of channels.values()) {
      if (timingSafeStringEqual(presentedToken, channel.token)) {
        return channel;
      }
    }
    return null;
  });

  const revokeRemoteLeaseBestEffort = (lease: ActiveTurnLease) => {
    if (lease.source.kind !== "remote") return Effect.void;
    const { teamServerUrl, leaseId, leaseToken, environmentId } = lease.source;
    return Effect.gen(function* () {
      const client = Option.isSome(httpClientOption)
        ? httpClientOption.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const req = HttpClientRequest.post(
        `${teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/revoke`,
      ).pipe(
        HttpClientRequest.bodyText(
          encodeJsonUnknown({
            leaseId,
            leaseToken,
            environmentId,
            threadId: lease.threadId,
            turnId: lease.turnId,
          }),
          "application/json",
        ),
      );
      yield* client
        .execute(req)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("5 seconds"),
          Effect.ignore,
        );
    }).pipe(Effect.ignore);
  };

  // Start the private local broker listener (Unix socket on POSIX, loopback TCP on Windows).
  const listenerScope = yield* Scope.fork(yield* Effect.scope);
  const acquireListener = Effect.gen(function* () {
    const isUnixSocket = platform !== "win32";
    const owned = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const acquireDir = async (candidate: string) => {
            const parent = await NodeFSP.realpath(candidate);
            const stat = await NodeFSP.lstat(parent);
            if (isUnixSocket && uid !== undefined) {
              if (
                !stat.isDirectory() ||
                stat.isSymbolicLink() ||
                !(
                  (stat.uid === uid && (stat.mode & 0o022) === 0) ||
                  (stat.uid === 0 && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0))
                )
              ) {
                throw new Error("Untrusted IPC parent directory");
              }
            }
            const directory = await NodeFSP.mkdtemp(NodePath.join(parent, "t3-gh-"));
            try {
              if (isUnixSocket) {
                await NodeFSP.chmod(directory, 0o700);
              }
              const socketPath = NodePath.join(directory, "s");
              if (isUnixSocket && Buffer.byteLength(socketPath) > UNIX_SOCKET_PATH_BYTES) {
                throw new Error("Unix socket path exceeds platform limit");
              }
              const binDir = NodePath.join(directory, "bin");
              const ghConfigDir = NodePath.join(directory, "gh-config");
              const ghRunsDir = NodePath.join(directory, "gh-runs");
              const gitHomeDir = NodePath.join(directory, "git-home");
              const emptyGitConfigPath = NodePath.join(directory, "empty-gitconfig");
              const askpassCjsPath = NodePath.join(directory, "t3-git-askpass.cjs");
              const askpassPath = NodePath.join(
                directory,
                platform === "win32" ? "t3-git-askpass.cmd" : "t3-git-askpass",
              );
              const sshGuardPath = NodePath.join(
                directory,
                platform === "win32" ? "t3-git-ssh-guard.cmd" : "t3-git-ssh-guard",
              );
              const ghCjsPath = NodePath.join(binDir, "gh-wrapper.cjs");
              const ghWrapperPath = NodePath.join(binDir, platform === "win32" ? "gh.cmd" : "gh");
              const gitCjsPath = NodePath.join(binDir, "git-wrapper.cjs");
              const gitWrapperPath = NodePath.join(
                binDir,
                platform === "win32" ? "git.cmd" : "git",
              );
              await NodeFSP.mkdir(binDir, { mode: 0o700 });
              await NodeFSP.mkdir(ghConfigDir, { mode: 0o700 });
              await NodeFSP.mkdir(ghRunsDir, { mode: 0o700 });
              await NodeFSP.mkdir(gitHomeDir, { mode: 0o700 });
              await NodeFSP.writeFile(emptyGitConfigPath, "", {
                encoding: "utf8",
                mode: 0o600,
              });
              await NodeFSP.writeFile(askpassCjsPath, buildGitAskpassScript(), {
                encoding: "utf8",
                mode: 0o600,
              });
              await NodeFSP.writeFile(
                ghCjsPath,
                buildGhWrapperScript(binDir, ghConfigDir, ghRunsDir),
                {
                  encoding: "utf8",
                  mode: 0o600,
                },
              );
              await NodeFSP.writeFile(
                gitCjsPath,
                buildGitWrapperScript(binDir, gitHomeDir, emptyGitConfigPath),
                {
                  encoding: "utf8",
                  mode: 0o600,
                },
              );
              if (platform === "win32") {
                await NodeFSP.writeFile(
                  askpassPath,
                  buildWindowsNodeCmdShim(nodeExecPath, askpassCjsPath),
                  { encoding: "utf8" },
                );
                await NodeFSP.writeFile(
                  ghWrapperPath,
                  buildWindowsNodeCmdShim(nodeExecPath, ghCjsPath),
                  { encoding: "utf8" },
                );
                await NodeFSP.writeFile(
                  gitWrapperPath,
                  buildWindowsNodeCmdShim(nodeExecPath, gitCjsPath),
                  { encoding: "utf8" },
                );
                await NodeFSP.writeFile(sshGuardPath, buildWindowsSshGuardScript(), {
                  encoding: "utf8",
                });
              } else {
                await NodeFSP.writeFile(
                  askpassPath,
                  buildPosixNodeShim(nodeExecPath, askpassCjsPath),
                  { encoding: "utf8", mode: 0o700 },
                );
                await NodeFSP.writeFile(
                  ghWrapperPath,
                  buildPosixNodeShim(nodeExecPath, ghCjsPath),
                  { encoding: "utf8", mode: 0o700 },
                );
                await NodeFSP.writeFile(
                  gitWrapperPath,
                  buildPosixNodeShim(nodeExecPath, gitCjsPath),
                  { encoding: "utf8", mode: 0o700 },
                );
                await NodeFSP.writeFile(sshGuardPath, buildPosixSshGuardScript(), {
                  encoding: "utf8",
                  mode: 0o700,
                });
              }
              const sshGuardCommand =
                platform === "win32" ? `"${sshGuardPath}"` : posixSingleQuote(sshGuardPath);
              return {
                directory,
                socketPath,
                binDir,
                ghConfigDir,
                ghRunsDir,
                emptyGitConfigPath,
                askpassPath,
                ghWrapperPath,
                sshGuardCommand,
              };
            } catch (error) {
              await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
              throw error;
            }
          };
          return acquireDir(NodeOS.tmpdir()).catch(() => acquireDir("/tmp"));
        },
        catch: (cause) => new TeamGitHubBrokerStartError({ cause }),
      }),
      (owned) =>
        Effect.promise(async () => {
          await NodeFSP.rm(owned.directory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }),
    );

    const brokerContext = yield* Effect.context<never>();
    const runBrokerEffect = Effect.runPromiseWith(brokerContext);
    const activeSockets = new Set<NodeNet.Socket>();
    const server = NodeHttp.createServer((req, res) => {
      if (!isLocalBrokerHttpRequest(req, isUnixSocket)) {
        writeJson(res, 403, { error: "forbidden_non_local_request" });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const presentedToken = extractBearerToken(req.headers.authorization);
      if (presentedToken === null) {
        writeJson(res, 401, { error: "missing_broker_token" });
        return;
      }
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      if (pathname !== "/v1/git-askpass" && pathname !== "/v1/gh-token") {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      void (async () => {
        const rawBody = await readHttpBody(req);
        if (rawBody === null) {
          writeJson(res, 413, { error: "request_body_too_large" });
          return;
        }
        const channel = await runBrokerEffect(findChannelByToken(presentedToken));
        if (channel === null) {
          writeJson(res, 401, { error: "invalid_broker_token" });
          return;
        }
        if (pathname === "/v1/git-askpass") {
          const parsed = rawBody.trim().length > 0 ? decodeAskpassRequest(rawBody) : Option.none();
          const prompt = Option.isSome(parsed) ? (parsed.value.prompt ?? "") : "";
          const requestedThreadId = Option.isSome(parsed) ? parsed.value.threadId : undefined;
          const parsedPrompt = parseGitAskpassPrompt(prompt);
          if (parsedPrompt === null) {
            writeJson(res, 403, { error: "askpass_prompt_rejected" });
            return;
          }
          const resolved = await runBrokerEffect(
            resolveActiveCredentialForChannel(channel, requestedThreadId),
          );
          if (resolved === null) {
            writeJson(res, 403, { error: "no_active_turn_credential" });
            return;
          }
          if (!isGitAskpassTargetAllowed(parsedPrompt.targetUrl, resolved.apiBaseUrl)) {
            writeJson(res, 403, { error: "askpass_host_mismatch" });
            return;
          }
          const value =
            parsedPrompt.kind === "username"
              ? resolved.githubLogin || "x-access-token"
              : resolved.token;
          writeJson(res, 200, { value });
          return;
        }
        const parsedGh = rawBody.trim().length > 0 ? decodeGhTokenRequest(rawBody) : Option.none();
        const requestedThreadId = Option.isSome(parsedGh) ? parsedGh.value.threadId : undefined;
        const resolved = await runBrokerEffect(
          resolveActiveCredentialForChannel(channel, requestedThreadId),
        );
        if (resolved === null) {
          writeJson(res, 403, { error: "no_active_turn_credential" });
          return;
        }
        writeJson(res, 200, {
          token: resolved.token,
          authMethod: resolved.authMethod,
          githubLogin: resolved.githubLogin,
          githubName: resolved.githubName,
          githubEmail: resolved.githubEmail,
          apiBaseUrl: resolved.apiBaseUrl,
          ...(resolved.threadId !== undefined ? { threadId: resolved.threadId } : {}),
        });
      })().catch(() => {
        if (!res.headersSent) {
          writeJson(res, 500, { error: "broker_internal_error" });
        }
      });
    });

    server.on("connection", (socket) => {
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
    });
    server.on("error", () => {});

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );

    const endpoint = yield* Effect.callback<string, TeamGitHubBrokerStartError>((resume) => {
      const onError = (cause: Error) =>
        resume(Effect.fail(new TeamGitHubBrokerStartError({ cause })));
      server.once("error", onError);
      try {
        if (isUnixSocket) {
          server.listen(owned.socketPath, () => {
            server.off("error", onError);
            resume(Effect.succeed(owned.socketPath));
          });
        } else {
          server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            const addr = server.address();
            const port = typeof addr === "object" && addr !== null ? addr.port : 0;
            resume(Effect.succeed(`http://127.0.0.1:${port}`));
          });
        }
      } catch (cause) {
        server.off("error", onError);
        resume(Effect.fail(new TeamGitHubBrokerStartError({ cause })));
      }
      return Effect.sync(() => server.off("error", onError));
    });

    if (isUnixSocket) {
      yield* Effect.tryPromise({
        try: () => NodeFSP.chmod(owned.socketPath, 0o600),
        catch: (cause) => new TeamGitHubBrokerStartError({ cause }),
      });
    }

    return {
      endpoint,
      askpassPath: owned.askpassPath,
      binDir: owned.binDir,
      ghConfigDir: owned.ghConfigDir,
      ghRunsDir: owned.ghRunsDir,
      emptyGitConfigPath: owned.emptyGitConfigPath,
      sshGuardCommand: owned.sshGuardCommand,
    };
  });

  const listenerResult = yield* acquireListener.pipe(Scope.provide(listenerScope), Effect.result);
  const listenerFailure = listenerResult._tag === "Failure" ? listenerResult.failure : null;
  const listener =
    listenerResult._tag === "Success"
      ? listenerResult.success
      : yield* Effect.logError(
          "TeamGitHubBroker failed to start local listener; team sessions will refuse to start until local GitHub isolation is available.",
          { cause: listenerResult.failure },
        ).pipe(
          Effect.andThen(Scope.close(listenerScope, Exit.fail(listenerResult.failure))),
          Effect.as(null),
        );

  const channelHashForToken = (token: string): string => sha256Hex(token).slice(0, 12);
  const threadHashForId = (threadId: ThreadId): string => sha256Hex(String(threadId)).slice(0, 12);

  const isPidAlive = (pid: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      return code === "EPERM";
    }
  };

  // Sweep ephemeral gh-runs/ hosts.yml dirs matching revoked channels/threads or dead PIDs (e.g. SIGKILL).
  const sweepGhRunDirs = Effect.fn("TeamGitHubBroker.sweepGhRunDirs")(function* (filter?: {
    readonly channelHashes?: ReadonlySet<string>;
    readonly threadHash?: string;
  }) {
    if (listener === null) return;
    yield* Effect.promise(async () => {
      const entries = await NodeFSP.readdir(listener.ghRunsDir).catch(() => [] as Array<string>);
      for (const entry of entries) {
        const match = /^run-([0-9a-f]{12})-([0-9a-f]{12})-(\d+)-/.exec(entry);
        const channelMatched =
          match !== null &&
          filter?.channelHashes !== undefined &&
          filter.channelHashes.has(match[1]!) &&
          (filter.threadHash === undefined || match[2] === filter.threadHash);
        const shouldRemove =
          match === null || channelMatched || !isPidAlive(Number.parseInt(match[3]!, 10));
        if (shouldRemove) {
          await NodeFSP.rm(NodePath.join(listener.ghRunsDir, entry), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
      }
    });
  });

  const collectChannelHashes = (predicate: (channel: SessionBrokerChannel) => boolean) =>
    Ref.get(channelsRef).pipe(
      Effect.map((channels) => {
        const hashes = new Set<string>();
        for (const channel of channels.values()) {
          if (predicate(channel)) {
            hashes.add(channelHashForToken(channel.token));
          }
        }
        return hashes;
      }),
    );

  const revokeTurnLease = Effect.fn("TeamGitHubBroker.revokeTurnLease")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: string | null;
  }) {
    const removedLeases: Array<ActiveTurnLease> = [];
    yield* Ref.update(activeTurnLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, lease] of next) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        next.delete(key);
        removedLeases.push(lease);
        changed = true;
      }
      return changed ? next : current;
    });
    yield* Ref.update(remoteLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [leaseId, lease] of next) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        next.delete(leaseId);
        changed = true;
      }
      return changed ? next : current;
    });
    const sessionIds = new Set(
      removedLeases
        .map((lease) => lease.providerSessionId)
        .filter((id): id is ProviderSessionId => id !== null),
    );
    const channelHashes = yield* collectChannelHashes(
      (channel) =>
        channel.attachedThreadIds.has(input.threadId) || sessionIds.has(channel.providerSessionId),
    );
    yield* sweepGhRunDirs({ channelHashes, threadHash: threadHashForId(input.threadId) });
    if (removedLeases.length > 0) {
      yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
    }
  });

  const revokeMemberLeases = Effect.fn("TeamGitHubBroker.revokeMemberLeases")(function* (
    memberId: TeamMemberId,
  ) {
    yield* Ref.update(memberCredGenRef, (current) => {
      const next = new Map(current);
      next.set(memberId, (next.get(memberId) ?? 0) + 1);
      return next;
    });
    const removedLeases: Array<ActiveTurnLease> = [];
    yield* Ref.update(activeTurnLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, lease] of next) {
        if (lease.authorKind === "member" && lease.authorMemberId === memberId) {
          next.delete(key);
          removedLeases.push(lease);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    yield* Ref.update(remoteLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [leaseId, lease] of next) {
        if (lease.authorKind === "member" && lease.authorMemberId === memberId) {
          next.delete(leaseId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    const channelHashes = yield* collectChannelHashes(
      (channel) => channel.authorKind === "member" && channel.authorMemberId === memberId,
    );
    yield* sweepGhRunDirs({ channelHashes });
    if (removedLeases.length > 0) {
      yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
    }
  });

  const revokeAutomationLeases = Effect.fn("TeamGitHubBroker.revokeAutomationLeases")(function* (
    teamId: TeamId,
  ) {
    yield* Ref.update(automationCredGenRef, (gen) => gen + 1);
    const removedLeases: Array<ActiveTurnLease> = [];
    yield* Ref.update(activeTurnLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, lease] of next) {
        if (
          lease.authorKind === "team_automation" &&
          (lease.source.kind !== "local" || lease.source.teamId === teamId)
        ) {
          next.delete(key);
          removedLeases.push(lease);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    yield* Ref.update(remoteLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [leaseId, lease] of next) {
        if (lease.authorKind === "team_automation" && lease.teamId === teamId) {
          next.delete(leaseId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    const channelHashes = yield* collectChannelHashes(
      (channel) => channel.authorKind === "team_automation",
    );
    yield* sweepGhRunDirs({ channelHashes });
    if (removedLeases.length > 0) {
      yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
    }
  });

  const revokeEnvironmentLeases = Effect.fn("TeamGitHubBroker.revokeEnvironmentLeases")(
    function* (input: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly revokedMemberIds?: ReadonlyArray<TeamMemberId>;
    }) {
      const revokedSet =
        input.revokedMemberIds !== undefined ? new Set(input.revokedMemberIds) : null;
      yield* Ref.update(remoteLeasesRef, (current) => {
        let changed = false;
        const next = new Map(current);
        for (const [leaseId, lease] of next) {
          if (lease.teamId !== input.teamId || lease.environmentId !== input.environmentId) {
            continue;
          }
          if (
            revokedSet !== null &&
            (lease.authorKind !== "member" ||
              lease.authorMemberId === null ||
              !revokedSet.has(lease.authorMemberId))
          ) {
            continue;
          }
          next.delete(leaseId);
          changed = true;
        }
        return changed ? next : current;
      });
      // When the Team Server's default environment ACL changes, also purge affected local leases.
      const envOpt = Option.isSome(teamRepoOption)
        ? yield* teamRepoOption.value
            .getEnvironmentByEnvironmentId({
              teamId: input.teamId,
              environmentId: input.environmentId,
            })
            .pipe(Effect.orElseSucceed(() => Option.none()))
        : Option.none();
      if (Option.isSome(envOpt) && envOpt.value.isDefault) {
        const removedLocal: Array<ActiveTurnLease> = [];
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [key, lease] of next) {
            if (lease.source.kind !== "local" || lease.source.teamId !== input.teamId) continue;
            if (
              revokedSet !== null &&
              (lease.authorKind !== "member" ||
                lease.authorMemberId === null ||
                !revokedSet.has(lease.authorMemberId))
            ) {
              continue;
            }
            next.delete(key);
            removedLocal.push(lease);
            changed = true;
          }
          return changed ? next : current;
        });
        if (removedLocal.length > 0) {
          const affectedMembers = new Set(
            removedLocal
              .map((lease) => lease.authorMemberId)
              .filter((id): id is TeamMemberId => id !== null),
          );
          const channelHashes = yield* collectChannelHashes(
            (channel) =>
              revokedSet === null ||
              (channel.authorKind === "member" &&
                channel.authorMemberId !== null &&
                affectedMembers.has(channel.authorMemberId)),
          );
          yield* sweepGhRunDirs({ channelHashes });
        }
      }
    },
  );

  // Wire directly into Milestone 4's registerTurnInterruptHook for immediate revocation on
  // admin/owner Interrupt and on creator Send now steering a foreign-authored active turn.
  if (Option.isSome(teamServiceOption)) {
    const unregisterInterrupt = yield* teamServiceOption.value.registerTurnInterruptHook(
      (event) => {
        if (event.reason === "promote_to_steer") {
          // Preserve lease only when the creator steers their own active turn;
          // immediately revoke when steering a foreign-authored or automation turn.
          if (
            event.activeTurnAuthorMemberId !== null &&
            event.activeTurnAuthorMemberId === event.actorMemberId
          ) {
            return Effect.void;
          }
          return revokeTurnLease({ threadId: event.threadId, turnId: event.runId });
        }
        return revokeTurnLease({ threadId: event.threadId, turnId: event.runId });
      },
    );
    const unregisterCredentialChange =
      yield* teamServiceOption.value.registerGitHubCredentialChangeHook((event) =>
        event.kind === "member"
          ? revokeMemberLeases(event.memberId)
          : event.kind === "automation"
            ? revokeAutomationLeases(event.teamId)
            : revokeEnvironmentLeases({
                teamId: event.teamId,
                environmentId: event.environmentId,
                ...(event.revokedMemberIds === undefined
                  ? {}
                  : { revokedMemberIds: event.revokedMemberIds }),
              }),
      );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregisterInterrupt();
        unregisterCredentialChange();
      }),
    );
  }

  const getCredentialGeneration = Effect.fn("TeamGitHubBroker.getCredentialGeneration")(
    function* (input: {
      readonly authorKind: TeamGitHubTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
    }) {
      if (input.authorKind === "team_automation") {
        return yield* Ref.get(automationCredGenRef);
      }
      if (input.authorMemberId === null) return 0;
      return (yield* Ref.get(memberCredGenRef)).get(input.authorMemberId) ?? 0;
    },
  );

  return TeamGitHubBroker.of({
    getEndpoint: Effect.fn("TeamGitHubBroker.getEndpoint")(() =>
      Effect.succeed(listener?.endpoint ?? null),
    ),

    getCredentialGeneration,

    getSessionCredentialGeneration: Effect.fn("TeamGitHubBroker.getSessionCredentialGeneration")(
      function* (providerSessionId) {
        const channels = yield* Ref.get(channelsRef);
        for (const channel of channels.values()) {
          if (channel.providerSessionId === providerSessionId) {
            return channel.credentialGeneration;
          }
        }
        return null;
      },
    ),

    prepareSessionEnvironment: Effect.fn("TeamGitHubBroker.prepareSessionEnvironment")(
      function* (input) {
        let identity: Pick<
          TeamGitHubIdentity,
          "githubLogin" | "githubName" | "githubEmail"
        > | null = input.identityOverride ?? null;
        let configuredApiBaseUrl: string | null = input.identityOverride?.apiBaseUrl ?? null;

        if (identity === null && Option.isSome(githubRepoOption) && Option.isSome(teamRepoOption)) {
          const workspaceOpt = yield* teamRepoOption.value
            .getWorkspace()
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(workspaceOpt)) {
            if (input.authorKind === "team_automation") {
              const autoOpt = yield* githubRepoOption.value
                .getAutomationCredential(workspaceOpt.value.id)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(autoOpt)) {
                identity = autoOpt.value;
                configuredApiBaseUrl = autoOpt.value.apiBaseUrl;
              }
            } else if (input.authorMemberId !== null) {
              const memberOpt = yield* teamRepoOption.value
                .getMemberById(input.authorMemberId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(memberOpt) && memberOpt.value.status === "active") {
                const credOpt = yield* githubRepoOption.value
                  .getMemberCredential(input.authorMemberId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                if (
                  Option.isSome(credOpt) &&
                  credOpt.value.teamId === workspaceOpt.value.id &&
                  credOpt.value.needsReconnect !== true
                ) {
                  identity = credOpt.value;
                  configuredApiBaseUrl = credOpt.value.apiBaseUrl;
                }
              }
            }
          }
        }

        // Fail closed if the local broker listener failed to start: refuse session startup rather
        // than running without isolated GH_CONFIG_DIR / GIT_ASKPASS / gh wrappers.
        if (listener === null) {
          return yield* (
            listenerFailure ??
            new TeamGitHubBrokerStartError({
              cause: new Error("Local GitHub credential broker listener is unavailable."),
            })
          );
        }

        const credentialGeneration = yield* getCredentialGeneration({
          authorKind: input.authorKind,
          authorMemberId: input.authorMemberId,
        });
        const brokerToken = `t3ghs_${NodeCrypto.randomBytes(32).toString("base64url")}`;
        yield* Ref.update(channelsRef, (current) => {
          const next = new Map(current);
          for (const [existingToken, existingChannel] of next) {
            if (existingChannel.providerSessionId === input.providerSessionId) {
              next.delete(existingToken);
            }
          }
          next.set(brokerToken, {
            token: brokerToken,
            providerSessionId: input.providerSessionId,
            attachedThreadIds: new Set([input.threadId]),
            authorKind: input.authorKind,
            authorMemberId: input.authorMemberId,
            credentialGeneration,
          });
          return next;
        });

        const isWin = platform === "win32";
        const currentPath = isWin
          ? (Object.entries(hostEnv).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "")
          : (hostEnv.PATH ?? "");
        const resolvedBinDir = isWin
          ? NodePath.resolve(listener.binDir).toLowerCase()
          : NodePath.resolve(listener.binDir);
        const pathEntries = currentPath.split(NodePath.delimiter).filter((entry) => {
          if (entry.length === 0) return false;
          const resolvedEntry = isWin
            ? NodePath.resolve(entry).toLowerCase()
            : NodePath.resolve(entry);
          return resolvedEntry !== resolvedBinDir;
        });
        const mergedPath = [listener.binDir, ...pathEntries].join(NodePath.delimiter);

        // Route standard GitHub (and configured GHE) SSH remotes through broker-authenticated
        // HTTPS, clear inherited/repo HTTP extraHeader overrides, disable host system/global git
        // config, and fail closed via GIT_SSH_COMMAND on any other SSH remote.
        const gitConfigEntries: Array<{ readonly key: string; readonly value: string }> = [
          { key: "credential.helper", value: "" },
          { key: "http.extraHeader", value: "" },
          { key: "http.https://github.com/.extraHeader", value: "" },
          { key: "core.askPass", value: listener.askpassPath },
          { key: "core.sshCommand", value: listener.sshGuardCommand },
          { key: "url.https://github.com/.insteadOf", value: "git@github.com:" },
          { key: "url.https://github.com/.insteadOf", value: "ssh://git@github.com/" },
          { key: "url.https://github.com/.insteadOf", value: "ssh://github.com/" },
        ];
        if (configuredApiBaseUrl !== null) {
          const allowedGitOrigin = deriveAllowedGitOrigin(configuredApiBaseUrl);
          if (
            allowedGitOrigin !== null &&
            allowedGitOrigin.protocol === "https:" &&
            allowedGitOrigin.hostname.toLowerCase() !== "github.com"
          ) {
            const gheHost = allowedGitOrigin.hostname.toLowerCase();
            const gheOriginPrefix = `${allowedGitOrigin.origin}/`;
            gitConfigEntries.push(
              { key: `http.${gheOriginPrefix}.extraHeader`, value: "" },
              { key: `url.${gheOriginPrefix}.insteadOf`, value: `git@${gheHost}:` },
              { key: `url.${gheOriginPrefix}.insteadOf`, value: `ssh://git@${gheHost}/` },
              { key: `url.${gheOriginPrefix}.insteadOf`, value: `ssh://${gheHost}/` },
            );
          }
        }

        const env: Record<string, string> = {
          [TEAM_GITHUB_SANITIZE_ENV]: "1",
          [TEAM_GH_BROKER_ENDPOINT_ENV]: listener.endpoint,
          [TEAM_GH_BROKER_TOKEN_ENV]: brokerToken,
          [TEAM_GH_BROKER_NODE_ENV]: nodeExecPath,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: listener.askpassPath,
          GIT_SSH_COMMAND: listener.sshGuardCommand,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: listener.emptyGitConfigPath,
          ...buildGitConfigEnv(hostEnv, gitConfigEntries),
          GH_CONFIG_DIR: listener.ghConfigDir,
          GH_PROMPT_DISABLED: "1",
          PATH: mergedPath,
        };

        if (identity !== null) {
          const authorName = identity.githubName?.trim() || identity.githubLogin;
          const authorEmail =
            identity.githubEmail?.trim() || `${identity.githubLogin}@users.noreply.github.com`;
          env.GIT_AUTHOR_NAME = authorName;
          env.GIT_AUTHOR_EMAIL = authorEmail;
          env.GIT_COMMITTER_NAME = authorName;
          env.GIT_COMMITTER_EMAIL = authorEmail;
        }

        return env;
      },
    ),

    attachThreadToSessionChannel: Effect.fn("TeamGitHubBroker.attachThreadToSessionChannel")(
      function* (input) {
        yield* Ref.update(channelsRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [token, channel] of next) {
            if (
              channel.providerSessionId === input.providerSessionId &&
              !channel.attachedThreadIds.has(input.threadId)
            ) {
              const attachedThreadIds = new Set(channel.attachedThreadIds);
              attachedThreadIds.add(input.threadId);
              next.set(token, { ...channel, attachedThreadIds });
              changed = true;
            }
          }
          return changed ? next : current;
        });
      },
    ),

    detachThreadFromSessionChannel: Effect.fn("TeamGitHubBroker.detachThreadFromSessionChannel")(
      function* (input) {
        yield* Ref.update(channelsRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [token, channel] of next) {
            if (
              channel.providerSessionId === input.providerSessionId &&
              channel.attachedThreadIds.has(input.threadId)
            ) {
              const attachedThreadIds = new Set(channel.attachedThreadIds);
              attachedThreadIds.delete(input.threadId);
              next.set(token, { ...channel, attachedThreadIds });
              changed = true;
            }
          }
          return changed ? next : current;
        });
      },
    ),

    revokeSessionChannel: Effect.fn("TeamGitHubBroker.revokeSessionChannel")(
      function* (providerSessionId) {
        const revokedHashes = new Set<string>();
        yield* Ref.update(channelsRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [token, channel] of next) {
            if (channel.providerSessionId === providerSessionId) {
              revokedHashes.add(channelHashForToken(channel.token));
              next.delete(token);
              changed = true;
            }
          }
          return changed ? next : current;
        });
        const removedLeases: Array<ActiveTurnLease> = [];
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [key, lease] of next) {
            if (lease.providerSessionId === providerSessionId) {
              next.delete(key);
              removedLeases.push(lease);
              changed = true;
            }
          }
          return changed ? next : current;
        });
        yield* sweepGhRunDirs({ channelHashes: revokedHashes });
        if (removedLeases.length > 0) {
          yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
        }
      },
    ),

    activateLocalTurnLease: Effect.fn("TeamGitHubBroker.activateLocalTurnLease")(function* (input) {
      if (Option.isNone(teamRepoOption)) return;
      const workspaceOpt = yield* teamRepoOption.value
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(workspaceOpt)) return;
      const teamId = workspaceOpt.value.id;

      let credentialUpdatedAt: string | null = null;
      if (Option.isSome(githubRepoOption)) {
        if (input.authorKind === "team_automation") {
          const autoOpt = yield* githubRepoOption.value
            .getAutomationCredential(teamId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          credentialUpdatedAt = Option.isSome(autoOpt) ? autoOpt.value.updatedAt : null;
        } else if (input.authorMemberId !== null) {
          // Proactively refresh expiring GitHub App user-to-server tokens before activating a local turn lease.
          if (Option.isSome(secretsOption)) {
            yield* TeamGitHubOAuth.resolveFreshMemberGitHubCredential({
              teamId,
              memberId: input.authorMemberId,
              githubRepo: githubRepoOption.value,
              secrets: secretsOption.value,
              ...(Option.isSome(httpClientOption) ? { httpClient: httpClientOption.value } : {}),
              onIdentityUpdated: (identity) =>
                Option.isSome(teamServiceOption)
                  ? teamServiceOption.value.publishMemberGitHubIdentityUpdate({
                      memberId: input.authorMemberId!,
                      identity,
                    })
                  : Effect.void,
              onRefreshRevoked: (revokedMemberId) => revokeMemberLeases(revokedMemberId),
            });
          }
          const memberCredOpt = yield* githubRepoOption.value
            .getMemberCredential(input.authorMemberId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          credentialUpdatedAt =
            Option.isSome(memberCredOpt) &&
            memberCredOpt.value.teamId === teamId &&
            memberCredOpt.value.needsReconnect !== true
              ? memberCredOpt.value.updatedAt
              : null;
        }
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const ttlMs = Math.max(1_000, input.ttlMs ?? DEFAULT_TURN_LEASE_TTL_MS);
      const lease: ActiveTurnLease = {
        threadId: input.threadId,
        turnId: input.turnId,
        providerSessionId: input.providerSessionId,
        authorKind: input.authorKind,
        authorMemberId: input.authorMemberId,
        expiresAtMs: nowMs + ttlMs,
        revoked: false,
        source: {
          kind: "local",
          teamId,
          credentialUpdatedAt,
        },
      };

      yield* Ref.update(activeTurnLeasesRef, (current) => {
        const next = new Map(current);
        for (const [key, existing] of next) {
          if (existing.expiresAtMs <= nowMs || existing.threadId === input.threadId) {
            next.delete(key);
          }
        }
        next.set(turnLeaseKey(input.threadId, input.turnId), lease);
        return next;
      });
    }),

    activateRemoteTurnLease: Effect.fn("TeamGitHubBroker.activateRemoteTurnLease")(
      function* (input) {
        const expiresAtMs = Date.parse(input.expiresAt);
        const nowMs = yield* Clock.currentTimeMillis;
        const lease: ActiveTurnLease = {
          threadId: input.threadId,
          turnId: input.turnId,
          providerSessionId: input.providerSessionId,
          authorKind: input.authorKind,
          authorMemberId: input.authorMemberId,
          expiresAtMs: Number.isFinite(expiresAtMs)
            ? expiresAtMs
            : nowMs + DEFAULT_TURN_LEASE_TTL_MS,
          revoked: false,
          source: {
            kind: "remote",
            teamServerUrl: input.teamServerUrl,
            environmentId: input.environmentId,
            leaseId: input.leaseId,
            leaseToken: input.leaseToken,
          },
        };
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          const next = new Map(current);
          for (const [key, existing] of next) {
            if (existing.expiresAtMs <= nowMs || existing.threadId === input.threadId) {
              next.delete(key);
            }
          }
          next.set(turnLeaseKey(input.threadId, input.turnId), lease);
          return next;
        });
      },
    ),

    requestRemoteTurnLease: Effect.fn("TeamGitHubBroker.requestRemoteTurnLease")(function* (input) {
      const client = Option.isSome(httpClientOption)
        ? httpClientOption.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const url = `${input.teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/issue`;
      const req = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.memberToken}`),
        HttpClientRequest.bodyText(
          encodeJsonUnknown({
            environmentId: input.environmentId,
            threadId: input.threadId,
            turnId: input.turnId,
            ...(input.authorKind === undefined ? {} : { authorKind: input.authorKind }),
          }),
          "application/json",
        ),
      );
      const res = yield* client
        .execute(req)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("10 seconds"),
          Effect.option,
        );
      if (Option.isNone(res)) return null;
      if (res.value.status < 200 || res.value.status >= 300) return null;
      const text = yield* res.value.text.pipe(Effect.orElseSucceed(() => ""));
      const parsed = decodeRemoteIssueResponse(text);
      return Option.isSome(parsed) ? parsed.value : null;
    }),

    revokeIssuedRemoteLease: Effect.fn("TeamGitHubBroker.revokeIssuedRemoteLease")(
      function* (input) {
        const client = Option.isSome(httpClientOption)
          ? httpClientOption.value
          : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        const req = HttpClientRequest.post(
          `${input.teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/revoke`,
        ).pipe(
          HttpClientRequest.bodyText(
            encodeJsonUnknown({
              leaseId: input.leaseId,
              leaseToken: input.leaseToken,
              environmentId: input.environmentId,
              threadId: input.threadId,
              turnId: input.turnId,
            }),
            "application/json",
          ),
        );
        yield* client
          .execute(req)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.timeout("5 seconds"),
            Effect.ignore,
          );
      },
    ),

    revokeTurnLease,
    renewTurnLease: Effect.fn("TeamGitHubBroker.renewTurnLease")(function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      const key = turnLeaseKey(input.threadId, input.turnId);
      const lease = (yield* Ref.get(activeTurnLeasesRef)).get(key);
      if (lease === undefined || lease.revoked || lease.expiresAtMs <= nowMs) {
        return false;
      }
      if (lease.source.kind === "remote") {
        const client = Option.isSome(httpClientOption)
          ? httpClientOption.value
          : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        const req = HttpClientRequest.post(
          `${lease.source.teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/renew`,
        ).pipe(
          HttpClientRequest.bodyText(
            encodeJsonUnknown({
              leaseId: lease.source.leaseId,
              leaseToken: lease.source.leaseToken,
              environmentId: lease.source.environmentId,
              threadId: lease.threadId,
              turnId: lease.turnId,
            }),
            "application/json",
          ),
        );
        const res = yield* client
          .execute(req)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.timeout("10 seconds"),
            Effect.option,
          );
        if (Option.isNone(res)) return false;
        if (res.value.status === 401 || res.value.status === 403 || res.value.status === 404) {
          yield* Ref.update(activeTurnLeasesRef, (current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          return false;
        }
        if (res.value.status < 200 || res.value.status >= 300) return false;
        const text = yield* res.value.text.pipe(Effect.orElseSucceed(() => ""));
        const parsed = decodeRemoteRenewResponse(text);
        if (Option.isNone(parsed)) return false;
        const nextExpiresAtMs = Date.parse(parsed.value.expiresAt);
        if (!Number.isFinite(nextExpiresAtMs)) return false;
        return yield* Ref.modify(activeTurnLeasesRef, (current) => {
          const existing = current.get(key);
          if (existing !== lease) return [false, current] as const;
          const next = new Map(current);
          next.set(key, { ...existing, expiresAtMs: nextExpiresAtMs });
          return [true, next] as const;
        });
      }
      // Local lease: re-verify active membership, default-environment ACL, and matching credential generation before extending.
      const resolved = yield* resolveLocalCredential({
        teamId: lease.source.teamId,
        authorKind: lease.authorKind,
        authorMemberId: lease.authorMemberId,
        expectedUpdatedAt: lease.source.credentialUpdatedAt,
        enforceDefaultEnvironmentAcl: true,
      });
      if (resolved === null) {
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        return false;
      }
      const ttlMs = Math.max(1_000, input.ttlMs ?? DEFAULT_TURN_LEASE_TTL_MS);
      const nextExpiresAtMs = (yield* Clock.currentTimeMillis) + ttlMs;
      return yield* Ref.modify(activeTurnLeasesRef, (current) => {
        const existing = current.get(key);
        if (existing !== lease) return [false, current] as const;
        const next = new Map(current);
        next.set(key, { ...existing, expiresAtMs: nextExpiresAtMs });
        return [true, next] as const;
      });
    }),
    revokeMemberLeases,
    revokeAutomationLeases,
    revokeEnvironmentLeases,

    hasActiveTurnLease: Effect.fn("TeamGitHubBroker.hasActiveTurnLease")(function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      const leases = yield* Ref.get(activeTurnLeasesRef);
      for (const lease of leases.values()) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        if (!lease.revoked && lease.expiresAtMs > nowMs) return true;
      }
      const remoteLeases = yield* Ref.get(remoteLeasesRef);
      for (const lease of remoteLeases.values()) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        if (lease.expiresAtMs <= nowMs) {
          continue;
        }
        if (!(yield* canUseRemoteLease(lease))) continue;
        return true;
      }
      return false;
    }),

    issueRemoteTurnLease: Effect.fn("TeamGitHubBroker.issueRemoteTurnLease")(function* (input) {
      if (Option.isNone(githubRepoOption) || Option.isNone(secretsOption)) {
        return {
          hasCredential: false,
          leaseId: null,
          leaseToken: null,
          expiresAt: null,
          identity: null,
        } satisfies TeamGitHubRemoteLeaseIssueResponse;
      }

      let identity: TeamGitHubIdentity | null = null;
      let credentialUpdatedAt: string | null = null;
      if (input.authorKind === "team_automation") {
        const autoOpt = yield* githubRepoOption.value
          .getAutomationCredential(input.teamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(autoOpt)) {
          identity = TeamGitHubRepository.stripAutomationGitHubSecretKey(autoOpt.value);
          credentialUpdatedAt = autoOpt.value.updatedAt;
        }
      } else if (input.authorMemberId !== null) {
        if (Option.isSome(teamRepoOption)) {
          const memberOpt = yield* teamRepoOption.value
            .getMemberById(input.authorMemberId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (
            Option.isNone(memberOpt) ||
            memberOpt.value.teamId !== input.teamId ||
            memberOpt.value.status !== "active"
          ) {
            return {
              hasCredential: false,
              leaseId: null,
              leaseToken: null,
              expiresAt: null,
              identity: null,
            } satisfies TeamGitHubRemoteLeaseIssueResponse;
          }
        }
        // Proactively refresh near-expiry tokens server-side before minting a remote single-turn lease.
        // refresh_token and client_secret stay strictly on the Team Server.
        const freshCred = yield* TeamGitHubOAuth.resolveFreshMemberGitHubCredential({
          teamId: input.teamId,
          memberId: input.authorMemberId,
          githubRepo: githubRepoOption.value,
          secrets: secretsOption.value,
          ...(Option.isSome(httpClientOption) ? { httpClient: httpClientOption.value } : {}),
          onIdentityUpdated: (updatedIdentity) =>
            Option.isSome(teamServiceOption)
              ? teamServiceOption.value.publishMemberGitHubIdentityUpdate({
                  memberId: input.authorMemberId!,
                  identity: updatedIdentity,
                })
              : Effect.void,
          onRefreshRevoked: (revokedMemberId) => revokeMemberLeases(revokedMemberId),
        });
        const memberCredOpt = yield* githubRepoOption.value
          .getMemberCredential(input.authorMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          freshCred !== null &&
          Option.isSome(memberCredOpt) &&
          memberCredOpt.value.teamId === input.teamId &&
          memberCredOpt.value.needsReconnect !== true
        ) {
          identity = TeamGitHubRepository.stripMemberGitHubSecretKey(memberCredOpt.value);
          credentialUpdatedAt = memberCredOpt.value.updatedAt;
        }
      }

      if (
        identity === null ||
        credentialUpdatedAt === null ||
        !(yield* canUseRemoteLease({
          ...input,
          issuingSessionId: input.issuingSessionId ?? null,
        }))
      ) {
        return {
          hasCredential: false,
          leaseId: null,
          leaseToken: null,
          expiresAt: null,
          identity: null,
        } satisfies TeamGitHubRemoteLeaseIssueResponse;
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const ttlMs = Math.max(
        1_000,
        Math.min(input.ttlMs ?? DEFAULT_TURN_LEASE_TTL_MS, 60 * 60 * 1000),
      );
      const maxLifetimeMs = Math.max(
        1_000,
        Math.min(
          input.maxLifetimeMs ?? DEFAULT_REMOTE_LEASE_MAX_LIFETIME_MS,
          MAX_REMOTE_LEASE_LIFETIME_MS,
        ),
      );
      const maxExpiresAtMs = nowMs + maxLifetimeMs;
      const expiresAtMs = Math.min(nowMs + ttlMs, maxExpiresAtMs);
      const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)));
      const leaseId = `ghlease_${NodeCrypto.randomUUID()}`;
      const leaseToken = `t3ghl_${NodeCrypto.randomBytes(32).toString("base64url")}`;

      const record: IssuedRemoteTurnLease = {
        leaseId,
        leaseTokenHash: sha256Hex(leaseToken),
        teamId: input.teamId,
        environmentId: input.environmentId,
        threadId: input.threadId,
        turnId: input.turnId,
        authorKind: input.authorKind,
        authorMemberId: input.authorMemberId,
        issuingSessionId: input.issuingSessionId ?? null,
        credentialUpdatedAt,
        expiresAt,
        expiresAtMs,
        maxExpiresAtMs,
      };

      yield* Ref.update(remoteLeasesRef, (current) => {
        const next = new Map(current);
        for (const [existingId, existing] of next) {
          if (existing.expiresAtMs <= nowMs) {
            next.delete(existingId);
            continue;
          }
          // Scope replacement strictly per (environment, thread, turn, author) so one member
          // can never pre-reserve, block, or clobber another author's remote turn lease.
          if (
            existing.teamId === input.teamId &&
            existing.environmentId === input.environmentId &&
            existing.threadId === input.threadId &&
            existing.turnId === input.turnId &&
            existing.authorKind === input.authorKind &&
            existing.authorMemberId === input.authorMemberId
          ) {
            next.delete(existingId);
          }
        }
        next.set(leaseId, record);
        return next;
      });

      return {
        hasCredential: true,
        leaseId,
        leaseToken,
        expiresAt,
        identity,
      } satisfies TeamGitHubRemoteLeaseIssueResponse;
    }),

    resolveRemoteTurnLease: Effect.fn("TeamGitHubBroker.resolveRemoteTurnLease")(function* (input) {
      const lease = yield* readRemoteLease(input);
      if (lease === null) return null;
      const resolved = yield* resolveLocalCredential({
        teamId: lease.teamId,
        authorKind: lease.authorKind,
        authorMemberId: lease.authorMemberId,
        expectedUpdatedAt: lease.credentialUpdatedAt,
      });
      if (resolved === null || !(yield* canUseRemoteLease(lease))) {
        yield* removeRemoteLease(lease.leaseId);
        return null;
      }
      const now = yield* Clock.currentTimeMillis;
      const current = (yield* Ref.get(remoteLeasesRef)).get(lease.leaseId);
      if (current === undefined || current.expiresAtMs <= now) return null;
      return {
        token: resolved.token,
        authMethod: resolved.authMethod,
        githubLogin: resolved.githubLogin,
        githubName: resolved.githubName,
        githubEmail: resolved.githubEmail,
        apiBaseUrl: resolved.apiBaseUrl,
        expiresAt: current.expiresAt,
      } satisfies TeamGitHubRemoteLeaseResolveResponse;
    }),

    renewRemoteTurnLease: Effect.fn("TeamGitHubBroker.renewRemoteTurnLease")(function* (input) {
      const lease = yield* readRemoteLease(input);
      if (lease === null) return null;
      const resolved = yield* resolveLocalCredential({
        teamId: lease.teamId,
        authorKind: lease.authorKind,
        authorMemberId: lease.authorMemberId,
        expectedUpdatedAt: lease.credentialUpdatedAt,
      });
      if (resolved === null || !(yield* canUseRemoteLease(lease))) {
        yield* removeRemoteLease(lease.leaseId);
        return null;
      }
      const ttlMs = Math.max(
        1_000,
        Math.min(input.ttlMs ?? DEFAULT_TURN_LEASE_TTL_MS, 60 * 60 * 1000),
      );
      const renewNowMs = yield* Clock.currentTimeMillis;
      const nextExpiresAtMs = Math.min(renewNowMs + ttlMs, lease.maxExpiresAtMs);
      const nextExpiresAt = IsoDateTime.make(
        DateTime.formatIso(DateTime.makeUnsafe(nextExpiresAtMs)),
      );
      const updated = yield* Ref.modify(remoteLeasesRef, (current) => {
        const existing = current.get(input.leaseId);
        if (!existing || existing.expiresAtMs <= renewNowMs) return [false, current] as const;
        const next = new Map(current);
        next.set(input.leaseId, {
          ...existing,
          expiresAt: nextExpiresAt,
          expiresAtMs: nextExpiresAtMs,
        });
        return [true, next] as const;
      });
      return updated ? { expiresAt: nextExpiresAt } : null;
    }),

    revokeRemoteTurnLease: Effect.fn("TeamGitHubBroker.revokeRemoteTurnLease")(function* (input) {
      if (
        input.leaseId === undefined &&
        input.environmentId === undefined &&
        input.threadId === undefined &&
        input.turnId === undefined
      ) {
        return false;
      }
      const presentedTokenHash =
        input.leaseToken !== undefined ? sha256Hex(input.leaseToken) : null;
      const snapshot = yield* Ref.get(remoteLeasesRef);
      const candidateIds = new Set<string>();
      for (const [leaseId, lease] of snapshot) {
        if (input.teamId !== undefined && lease.teamId !== input.teamId) continue;
        if (input.leaseId !== undefined && lease.leaseId !== input.leaseId) continue;
        if (input.environmentId !== undefined && lease.environmentId !== input.environmentId)
          continue;
        if (input.threadId !== undefined && lease.threadId !== input.threadId) continue;
        if (input.turnId !== undefined && lease.turnId !== input.turnId) continue;
        if (
          presentedTokenHash !== null &&
          !timingSafeStringEqual(presentedTokenHash, lease.leaseTokenHash)
        ) {
          continue;
        }
        if (
          input.authorizedMemberId !== undefined &&
          (lease.authorKind !== "member" || lease.authorMemberId !== input.authorizedMemberId)
        ) {
          continue;
        }
        if (input.authorizeLease !== undefined) {
          const allowed = yield* input.authorizeLease({
            teamId: lease.teamId,
            environmentId: lease.environmentId,
            threadId: lease.threadId,
            turnId: lease.turnId,
            authorKind: lease.authorKind,
            authorMemberId: lease.authorMemberId,
          });
          if (!allowed) continue;
        }
        candidateIds.add(leaseId);
      }
      if (candidateIds.size === 0) {
        return false;
      }
      let revokedAny = false;
      yield* Ref.update(remoteLeasesRef, (current) => {
        const next = new Map(current);
        for (const leaseId of candidateIds) {
          if (next.delete(leaseId)) {
            revokedAny = true;
          }
        }
        return revokedAny ? next : current;
      });
      return revokedAny;
    }),
  });
});

export const layer = Layer.effect(TeamGitHubBroker, make);
