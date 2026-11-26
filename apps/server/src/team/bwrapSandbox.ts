// @effect-diagnostics nodeBuiltinImport:off -- Uses O_NOFOLLOW/lstat/realpath/stat to enforce canonical mount validation and symlink/userdata escape prevention.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProcessSandbox,
  sanitizeHostEnvForSandboxLaunch,
  type ProcessSandboxCommand,
  type ProcessSandboxShape,
  type ProcessSandboxWrapInput,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_BWRAP_RO_SYSTEM_BINDS: ReadonlyArray<string> = ["/usr"];

const DEFAULT_BWRAP_RO_TRY_SYSTEM_BINDS: ReadonlyArray<string> = [
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/lib32",
  "/etc",
  "/opt",
  "/run/systemd/resolve",
  "/run/NetworkManager/resolv.conf",
  "/run/resolvconf",
];

const SYSTEM_RO_COVERED_ROOTS: ReadonlyArray<string> = [
  ...DEFAULT_BWRAP_RO_SYSTEM_BINDS,
  ...DEFAULT_BWRAP_RO_TRY_SYSTEM_BINDS,
];

const DEFAULT_FORBIDDEN_USERDATA_ROOTS: ReadonlyArray<string> = [
  "/var/lib/t3hub",
  "/var/lib/t3hub/userdata",
];

const PROVIDER_PROFILE_ENV_VARS: ReadonlyArray<string> = [
  "GEMINI_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "T3_TEAM_PROFILE_DIR",
];

const TURN_HELPER_RO_ENV_VARS: ReadonlyArray<string> = [
  "GIT_ASKPASS",
  "T3_ACP_MCP_NODE",
  "T3_ACP_MCP_ENTRYPOINT",
];

const TURN_HELPER_RW_ENV_VARS: ReadonlyArray<string> = ["GH_CONFIG_DIR"];

const TURN_SOCKET_ENV_VARS: ReadonlyArray<string> = [
  "T3_GITHUB_BROKER_SOCKET",
  "T3_TEAM_GITHUB_BROKER_SOCKET",
  "T3_TURN_BROKER_SOCKET",
  "T3_CREDENTIAL_BROKER_SOCKET",
  "T3_CODEX_TOKEN_BROKER_SOCKET",
];

const ALLOWED_OWN_STATE_PROFILE_PARENTS = new Set(["team-profiles", "providers"]);
const FORBIDDEN_MOUNT_OVERWRITE_ROOTS = new Set(["/", "/tmp", "/dev", "/proc"]);
const UNSAFE_WIDEN_RO_ROOTS = new Set([
  "/",
  "/tmp",
  "/var",
  "/var/tmp",
  "/home",
  "/root",
  "/dev",
  "/proc",
  "/etc",
  "/run",
  "/srv",
  "/mnt",
  "/media",
  "/data",
]);
const MAX_GITDIR_FILE_BYTES = 8_192;
const MAX_SHEBANG_BYTES = 256;
const SANDBOX_SCRATCH_HOME = "/tmp/t3-home";

export const BwrapUnavailableReason = Schema.Literals([
  "unsupported_platform",
  "binary_not_found",
  "userns_unavailable",
  "probe_failed",
]);
export type BwrapUnavailableReason = typeof BwrapUnavailableReason.Type;

export class BwrapSandboxUnavailableError extends Schema.TaggedError<BwrapSandboxUnavailableError>()(
  "BwrapSandboxUnavailableError",
  {
    reason: BwrapUnavailableReason,
    binaryPath: Schema.optionalKey(Schema.String),
    hint: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.binaryPath === undefined ? "" : ` (${this.binaryPath})`;
    return `Linux bwrap sandbox unavailable [${this.reason}]${location}: ${this.hint}`;
  }
}

export const isBwrapSandboxUnavailableError = Schema.is(BwrapSandboxUnavailableError);

export const BwrapPathErrorReason = Schema.Literals([
  "non_absolute",
  "nul_byte",
  "missing_path",
  "forbidden_userdata_path",
  "invalid_git_worktree",
  "chdir_outside_workspace",
  "invalid_socket",
  "invalid_env",
]);
export type BwrapPathErrorReason = typeof BwrapPathErrorReason.Type;

export const BwrapBindRole = Schema.Literals([
  "cwd",
  "chdir",
  "git_common_dir",
  "provider_profile",
  "tool_cache",
  "socket",
  "helper",
  "extra_rw",
  "extra_ro",
  "executable",
  "sandbox_env",
]);
export type BwrapBindRole = typeof BwrapBindRole.Type;

export class BwrapSandboxPathError extends Schema.TaggedError<BwrapSandboxPathError>()(
  "BwrapSandboxPathError",
  {
    reason: BwrapPathErrorReason,
    role: BwrapBindRole,
    path: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "nul_byte":
        return `Refused bwrap ${this.role} bind path containing a NUL byte or empty value.`;
      case "non_absolute":
        return `Refused non-absolute bwrap ${this.role} bind path: ${this.path}`;
      case "missing_path":
        return `Required bwrap ${this.role} bind path does not exist: ${this.path}`;
      case "forbidden_userdata_path":
        return `Refused to bind forbidden userdata/control-plane path into bwrap sandbox (${this.role}): ${this.path}`;
      case "invalid_git_worktree":
        return `Refused invalid or unsafe git worktree metadata for bwrap sandbox (${this.role}): ${this.path}`;
      case "chdir_outside_workspace":
        return `Refused bwrap chdir outside sandboxed workspace (${this.role}): ${this.path}`;
      case "invalid_socket":
        return `Refused non-socket or symlinked bwrap socket bind (${this.role}): ${this.path}`;
      case "invalid_env":
        return `Refused invalid bwrap sandbox environment entry (${this.role}): ${this.path}`;
    }
  }
}

export const isBwrapSandboxPathError = Schema.is(BwrapSandboxPathError);

export type BwrapSandboxError = BwrapSandboxUnavailableError | BwrapSandboxPathError;

export interface BwrapAvailabilityResult {
  readonly available: true;
  readonly binaryPath: string;
}

export interface BwrapGitWorktreeBinds {
  readonly dotGitFile: string;
  readonly commonDir: string;
  readonly worktreeGitDir: string;
  /** Masked with `--tmpfs` before re-binding `worktreeGitDir` so sibling worktree git dirs stay hidden. */
  readonly maskWorktreesDir: string;
  readonly hooksDir: string;
  readonly configFile: string;
  readonly configFileExists?: boolean | undefined;
  readonly worktreeConfigFile?: string | undefined;
  readonly worktreeConfigFileExists?: boolean | undefined;
}

export interface BwrapRegularGitRepoBinds {
  readonly gitDir: string;
  readonly hooksDir: string;
  readonly configFile: string;
  readonly configFileExists: boolean;
  readonly worktreeConfigFile?: string | undefined;
  readonly worktreeConfigFileExists?: boolean | undefined;
  readonly maskWorktreesDir?: string | undefined;
}

export interface BwrapSandboxPlan {
  readonly bwrapBinaryPath: string;
  readonly cwd: string;
  readonly chdir: string;
  readonly gitWorktree?: BwrapGitWorktreeBinds | undefined;
  readonly gitRepo?: BwrapRegularGitRepoBinds | undefined;
  /** Host-side 0-byte 0444 regular file bound RO over absent git config files so O_WRONLY fails with EROFS. */
  readonly emptyRoFile?: string | undefined;
  readonly roSystemBinds?: ReadonlyArray<string> | undefined;
  readonly roTrySystemBinds?: ReadonlyArray<string> | undefined;
  readonly providerProfileDirs: ReadonlyArray<string>;
  readonly toolCacheDirs: ReadonlyArray<string>;
  readonly extraRwBinds: ReadonlyArray<string>;
  readonly extraRoBinds: ReadonlyArray<string>;
  readonly socketPaths: ReadonlyArray<string>;
  readonly helperPaths: ReadonlyArray<string>;
  readonly sandboxEnv?: Readonly<Record<string, string>> | undefined;
  readonly newSession?: boolean | undefined;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface ExtractedEnvBinds {
  readonly providerProfileDirs: ReadonlyArray<string>;
  readonly helperRoPaths: ReadonlyArray<string>;
  readonly helperRwDirs: ReadonlyArray<string>;
  readonly socketPaths: ReadonlyArray<string>;
}

export interface WrapCommandWithBwrapInput {
  readonly bwrapBinaryPath: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly chdir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Untrusted/per-request env vars applied strictly inside bwrap via `--setenv`. */
  readonly sandboxEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly ownStateDir?: string | undefined;
  readonly forbiddenUserdataDirs?: ReadonlyArray<string> | undefined;
  readonly providerProfileDirs?: ReadonlyArray<string> | undefined;
  readonly toolCacheDirs?: ReadonlyArray<string> | undefined;
  readonly extraRwBinds?: ReadonlyArray<string> | undefined;
  readonly extraRoBinds?: ReadonlyArray<string> | undefined;
  readonly socketPaths?: ReadonlyArray<string> | undefined;
  readonly helperPaths?: ReadonlyArray<string> | undefined;
  readonly newSession?: boolean | undefined;
  readonly allowExternalExecutableBind?: boolean | undefined;
}

export const isTeamBwrapSandboxEnabled = Effect.serviceOption(ServerConfig.ServerConfig).pipe(
  Effect.map((config) => Option.isSome(config) && config.value.teamBwrapSandbox === true),
);

function normalizePosixPath(value: string): string {
  const normalized = NodePath.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePosixPath(candidate);
  const normalizedRoot = normalizePosixPath(root);
  if (normalizedRoot === "/") return true;
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function isSameOrAncestor(candidate: string, target: string): boolean {
  return isSameOrDescendant(target, candidate);
}

function isCoveredBySystemRoBinds(candidate: string): boolean {
  return SYSTEM_RO_COVERED_ROOTS.some((root) => isSameOrDescendant(candidate, root));
}

function isSafePathSegment(segment: string | undefined): segment is string {
  return segment !== undefined && segment.length > 0 && segment !== "." && segment !== "..";
}

function isAllowedOwnStateProfileDir(candidate: string, ownStateDir: string): boolean {
  const normalizedCandidate = normalizePosixPath(candidate);
  const normalizedState = normalizePosixPath(ownStateDir);
  if (!normalizedCandidate.startsWith(`${normalizedState}/`)) {
    return false;
  }
  const relative = normalizedCandidate.slice(normalizedState.length + 1);
  const segments = relative.split("/");
  if (segments.length === 3) {
    const [bucket, driver, profileId] = segments;
    return (
      bucket !== undefined &&
      ALLOWED_OWN_STATE_PROFILE_PARENTS.has(bucket) &&
      isSafePathSegment(driver) &&
      isSafePathSegment(profileId)
    );
  }
  // Managed Codex shadow home layout: <stateDir>/providers/codex/<safeInstanceDir>/shadow
  if (segments.length === 4) {
    const [bucket, driver, instanceDir, leaf] = segments;
    return (
      bucket === "providers" &&
      driver === "codex" &&
      isSafePathSegment(instanceDir) &&
      leaf === "shadow"
    );
  }
  return false;
}

const USERNS_ERROR_PATTERN =
  /operation not permitted|permission denied|eperm|eacces|user namespace|unprivileged_userns|apparmor|no permissions to creating new namespace|setting up uid map|uid map/i;

export function classifyBwrapProbeFailure(stderr: string): "userns_unavailable" | "probe_failed" {
  return USERNS_ERROR_PATTERN.test(stderr) ? "userns_unavailable" : "probe_failed";
}

export function buildBwrapProbeArgs(): ReadonlyArray<string> {
  return [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--",
    "true",
  ];
}

export const checkBwrapAvailability = Effect.fn("bwrapSandbox.checkAvailability")(
  function* (options?: {
    readonly bwrapBinaryPath?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  }) {
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux") {
      return yield* new BwrapSandboxUnavailableError({
        reason: "unsupported_platform",
        hint: "--team-bwrap-sandbox requires Linux (bubblewrap namespaces are Linux-only). Disable --team-bwrap-sandbox / T3CODE_TEAM_BWRAP_SANDBOX on non-Linux hosts.",
      });
    }

    const hostEnvironment = yield* HostProcess.Environment;
    const env = options?.env ?? hostEnvironment;
    const requestedBinary = options?.bwrapBinaryPath?.trim() || "bwrap";
    const resolvedBinary = yield* resolveCommandPath(requestedBinary, { env });
    if (resolvedBinary === null) {
      return yield* new BwrapSandboxUnavailableError({
        reason: "binary_not_found",
        binaryPath: requestedBinary,
        hint: "Install bubblewrap (e.g. 'sudo apt-get install -y bubblewrap') or ensure 'bwrap' is in PATH.",
      });
    }

    const runner = yield* ProcessRunner.ProcessRunner;
    const probeResult = yield* runner
      .run({
        command: resolvedBinary,
        args: buildBwrapProbeArgs(),
        timeout: "5 seconds",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BwrapSandboxUnavailableError({
              reason: "probe_failed",
              binaryPath: resolvedBinary,
              hint: "Failed to execute bwrap preflight probe; verify bubblewrap is executable and unprivileged user namespaces are enabled.",
              cause,
            }),
        ),
      );

    if (probeResult.timedOut || Number(probeResult.code) !== 0) {
      const reason = classifyBwrapProbeFailure(probeResult.stderr);
      return yield* new BwrapSandboxUnavailableError({
        reason,
        binaryPath: resolvedBinary,
        hint:
          reason === "userns_unavailable"
            ? "Unprivileged user namespaces appear restricted (check kernel.unprivileged_userns_clone=1 and Ubuntu 24.04 AppArmor profile for /usr/bin/bwrap; see docs/teams/hub-runner-deployment.md)."
            : "bubblewrap preflight probe exited non-zero; verify bwrap can create PID/IPC/UTS/mount namespaces as this OS user.",
      });
    }

    return {
      available: true,
      binaryPath: resolvedBinary,
    } satisfies BwrapAvailabilityResult;
  },
);

async function tryRealpath(targetPath: string): Promise<string | undefined> {
  try {
    return normalizePosixPath(await NodeFSP.realpath(targetPath));
  } catch {
    return undefined;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readRegularFileNoFollow(filePath: string, maxBytes: number): Promise<string> {
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Expected a regular file");
    }
    if (stat.size > maxBytes) {
      throw new Error("File exceeds maximum allowed size");
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function expandForbiddenRoots(
  ownStateDir: string | undefined,
  extraForbiddenDirs: ReadonlyArray<string> | undefined,
): Promise<{
  readonly ownStateRoots: ReadonlyArray<string>;
  readonly foreignForbiddenRoots: ReadonlyArray<string>;
}> {
  const ownStateRoots = new Set<string>();
  if (
    ownStateDir !== undefined &&
    ownStateDir.trim().length > 0 &&
    NodePath.posix.isAbsolute(ownStateDir)
  ) {
    ownStateRoots.add(normalizePosixPath(ownStateDir));
    const resolved = await tryRealpath(ownStateDir);
    if (resolved !== undefined) ownStateRoots.add(resolved);
  }

  const foreignForbiddenRoots = new Set<string>();
  const rawForeign = [...DEFAULT_FORBIDDEN_USERDATA_ROOTS, ...(extraForbiddenDirs ?? [])];
  for (const raw of rawForeign) {
    if (raw.trim().length === 0 || !NodePath.posix.isAbsolute(raw)) continue;
    const normalized = normalizePosixPath(raw);
    if (!ownStateRoots.has(normalized)) {
      foreignForbiddenRoots.add(normalized);
    }
    const resolved = await tryRealpath(normalized);
    if (resolved !== undefined && !ownStateRoots.has(resolved)) {
      foreignForbiddenRoots.add(resolved);
    }
  }

  return {
    ownStateRoots: [...ownStateRoots],
    foreignForbiddenRoots: [...foreignForbiddenRoots],
  };
}

async function expandHomeRoots(envHome: string | undefined): Promise<ReadonlyArray<string>> {
  const roots = new Set<string>();
  const rawCandidates = [envHome, HostProcess.HomeDirectory.defaultValue()];
  for (const raw of rawCandidates) {
    if (raw === undefined || raw.trim().length === 0 || !NodePath.posix.isAbsolute(raw)) continue;
    const normalized = normalizePosixPath(raw);
    if (normalized !== "/") {
      roots.add(normalized);
    }
    const resolved = await tryRealpath(normalized);
    if (resolved !== undefined && resolved !== "/") {
      roots.add(resolved);
    }
  }
  return [...roots];
}

/**
 * Ensures a host-side 0-byte 0444 regular file exists for locking absent git config files.
 * Unlike `/dev/null` (a char device where O_WRONLY bypasses MS_RDONLY), a regular file enforces EROFS.
 */
async function ensureEmptyRoFilePath(ownStateDir: string | undefined): Promise<string> {
  const uid = HostProcess.UserId.defaultValue() ?? 0;
  let containerDir: string;
  if (
    ownStateDir !== undefined &&
    ownStateDir.trim().length > 0 &&
    NodePath.posix.isAbsolute(ownStateDir) &&
    (await pathExists(ownStateDir))
  ) {
    containerDir = normalizePosixPath(ownStateDir);
  } else {
    containerDir = NodePath.posix.join(
      normalizePosixPath(NodeOS.tmpdir()),
      `t3-bwrap-empty-${uid}`,
    );
    await NodeFSP.mkdir(containerDir, { recursive: true, mode: 0o700 });
    const dirStat = await NodeFSP.lstat(containerDir);
    if (
      dirStat.isSymbolicLink() ||
      !dirStat.isDirectory() ||
      dirStat.uid !== uid ||
      (dirStat.mode & 0o022) !== 0
    ) {
      throw new Error(`Unsafe empty-ro container directory: ${containerDir}`);
    }
  }
  const filePath = NodePath.posix.join(containerDir, ".bwrap-empty-ro");
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_CREAT | NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    0o444,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 0) {
      throw new Error(`Unexpected empty-ro stub file state: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
  return normalizePosixPath(await NodeFSP.realpath(filePath));
}

function assertLexicalPathNotForbidden(input: {
  readonly candidate: string;
  readonly role: BwrapBindRole;
  readonly ownStateRoots: ReadonlyArray<string>;
  readonly foreignForbiddenRoots: ReadonlyArray<string>;
  readonly homeRoots?: ReadonlyArray<string> | undefined;
  readonly isDirectory?: boolean | undefined;
}): BwrapSandboxPathError | undefined {
  const { candidate, role, ownStateRoots, foreignForbiddenRoots } = input;
  if (
    FORBIDDEN_MOUNT_OVERWRITE_ROOTS.has(candidate) ||
    isSameOrAncestor(candidate, SANDBOX_SCRATCH_HOME)
  ) {
    return new BwrapSandboxPathError({
      reason: "forbidden_userdata_path",
      role,
      path: candidate,
    });
  }

  // Never allow binding broad system/shared/home directories into the sandbox.
  if (input.isDirectory === true) {
    if (UNSAFE_WIDEN_RO_ROOTS.has(candidate)) {
      return new BwrapSandboxPathError({
        reason: "forbidden_userdata_path",
        role,
        path: candidate,
      });
    }
    for (const homeRoot of input.homeRoots ?? []) {
      if (isSameOrAncestor(candidate, homeRoot)) {
        return new BwrapSandboxPathError({
          reason: "forbidden_userdata_path",
          role,
          path: candidate,
        });
      }
    }
  }

  const baseName = NodePath.posix.basename(candidate);
  if (baseName.startsWith("statev2.sqlite") || baseName === "ServerSecretStore") {
    return new BwrapSandboxPathError({
      reason: "forbidden_userdata_path",
      role,
      path: candidate,
    });
  }

  // Never allow binding any ancestor of a forbidden userdata directory (such as /var/lib/t3runner or /var/lib/t3hub).
  for (const root of [...ownStateRoots, ...foreignForbiddenRoots]) {
    if (isSameOrAncestor(candidate, root)) {
      return new BwrapSandboxPathError({
        reason: "forbidden_userdata_path",
        role,
        path: candidate,
      });
    }
  }

  // Never allow binding anything inside a foreign/hub userdata root.
  for (const foreignRoot of foreignForbiddenRoots) {
    if (isSameOrDescendant(candidate, foreignRoot)) {
      return new BwrapSandboxPathError({
        reason: "forbidden_userdata_path",
        role,
        path: candidate,
      });
    }
  }

  // Within our own runner's stateDir, only isolated leaf provider profiles are permitted—and strictly for provider_profile binds.
  for (const ownRoot of ownStateRoots) {
    if (isSameOrDescendant(candidate, ownRoot)) {
      if (role !== "provider_profile" || !isAllowedOwnStateProfileDir(candidate, ownRoot)) {
        return new BwrapSandboxPathError({
          reason: "forbidden_userdata_path",
          role,
          path: candidate,
        });
      }
    }
  }

  return undefined;
}

const canonicalizeAndValidateBindPath = Effect.fn("bwrapSandbox.validateBindPath")(
  function* (input: {
    readonly rawPath: string;
    readonly role: BwrapBindRole;
    readonly ownStateRoots: ReadonlyArray<string>;
    readonly foreignForbiddenRoots: ReadonlyArray<string>;
    readonly homeRoots?: ReadonlyArray<string> | undefined;
    readonly expectedType?: "directory" | "file" | "socket" | "any" | undefined;
  }): Effect.fn.Return<string, BwrapSandboxPathError> {
    const { rawPath, role, ownStateRoots, foreignForbiddenRoots, homeRoots } = input;
    if (rawPath.length === 0 || rawPath.includes("\0")) {
      return yield* new BwrapSandboxPathError({
        reason: "nul_byte",
        role,
        path: rawPath.replaceAll("\0", "<NUL>"),
      });
    }
    if (!NodePath.posix.isAbsolute(rawPath)) {
      return yield* new BwrapSandboxPathError({
        reason: "non_absolute",
        role,
        path: rawPath,
      });
    }

    const expectedType = input.expectedType ?? "any";

    const canonical = yield* Effect.tryPromise({
      try: async () => {
        const linkStat = await NodeFSP.lstat(rawPath);
        const resolved = normalizePosixPath(await NodeFSP.realpath(rawPath));
        const stat = await NodeFSP.stat(resolved);
        return { resolved, stat, linkStat };
      },
      catch: (cause) =>
        new BwrapSandboxPathError({
          reason: "missing_path",
          role,
          path: rawPath,
          cause,
        }),
    });

    if (expectedType === "socket") {
      if (canonical.linkStat.isSymbolicLink() || !canonical.stat.isSocket()) {
        return yield* new BwrapSandboxPathError({
          reason: "invalid_socket",
          role,
          path: canonical.resolved,
        });
      }
    } else if (expectedType === "directory" && !canonical.stat.isDirectory()) {
      return yield* new BwrapSandboxPathError({
        reason: "missing_path",
        role,
        path: canonical.resolved,
      });
    } else if (expectedType === "file" && !canonical.stat.isFile()) {
      return yield* new BwrapSandboxPathError({
        reason: "missing_path",
        role,
        path: canonical.resolved,
      });
    }

    const candidate = canonical.resolved;
    const lexicalError = assertLexicalPathNotForbidden({
      candidate,
      role,
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
      isDirectory: canonical.stat.isDirectory(),
    });
    if (lexicalError !== undefined) {
      return yield* lexicalError;
    }

    // Defense-in-depth: refuse binding any directory that directly houses a T3 SQLite database.
    if (canonical.stat.isDirectory()) {
      const hasStateDb = yield* Effect.promise(async () => {
        if (await pathExists(NodePath.posix.join(candidate, "statev2.sqlite"))) return true;
        if (await pathExists(NodePath.posix.join(candidate, "userdata", "statev2.sqlite")))
          return true;
        return false;
      });
      if (hasStateDb) {
        return yield* new BwrapSandboxPathError({
          reason: "forbidden_userdata_path",
          role,
          path: candidate,
        });
      }
    }

    return candidate;
  },
);

type BwrapGitMetadataResolution =
  | { readonly kind: "linked_worktree"; readonly binds: BwrapGitWorktreeBinds }
  | { readonly kind: "regular_repo"; readonly binds: BwrapRegularGitRepoBinds };

const inspectOptionalGitRegularFile = Effect.fn("bwrapSandbox.inspectOptionalGitRegularFile")(
  function* (filePath: string): Effect.fn.Return<boolean, BwrapSandboxPathError> {
    const stat = yield* Effect.promise(async () => {
      try {
        return await NodeFSP.lstat(filePath);
      } catch {
        return undefined;
      }
    });
    if (stat === undefined) return false;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return yield* new BwrapSandboxPathError({
        reason: "invalid_git_worktree",
        role: "git_common_dir",
        path: filePath,
      });
    }
    return true;
  },
);

const inspectOptionalGitSubdir = Effect.fn("bwrapSandbox.inspectOptionalGitSubdir")(function* (
  dirPath: string,
): Effect.fn.Return<boolean, BwrapSandboxPathError> {
  const stat = yield* Effect.promise(async () => {
    try {
      return await NodeFSP.lstat(dirPath);
    } catch {
      return undefined;
    }
  });
  if (stat === undefined) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: dirPath,
    });
  }
  return true;
});

async function collectNonSystemSymlinkHops(
  rawPath: string,
  maxHops = 8,
): Promise<ReadonlyArray<string>> {
  const hops: Array<string> = [];
  const seen = new Set<string>();
  let current = normalizePosixPath(rawPath);
  for (let i = 0; i < maxHops; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    try {
      const stat = await NodeFSP.lstat(current);
      if (!stat.isSymbolicLink()) break;
      if (!isCoveredBySystemRoBinds(current)) {
        hops.push(current);
      }
      const linkTarget = await NodeFSP.readlink(current);
      current = normalizePosixPath(
        NodePath.posix.isAbsolute(linkTarget)
          ? linkTarget
          : NodePath.posix.resolve(NodePath.posix.dirname(current), linkTarget),
      );
    } catch {
      break;
    }
  }
  return hops;
}

/**
 * Resolves git metadata locks for both regular `.git/` repositories and linked git worktrees
 * (O_NOFOLLOW + bidirectional `gitdir` verification) so hooks, configs, and sibling worktrees stay locked.
 */
const resolveGitMetadata = Effect.fn("bwrapSandbox.resolveGitMetadata")(function* (input: {
  readonly canonicalCwd: string;
  readonly ownStateRoots: ReadonlyArray<string>;
  readonly foreignForbiddenRoots: ReadonlyArray<string>;
  readonly homeRoots: ReadonlyArray<string>;
}): Effect.fn.Return<BwrapGitMetadataResolution | undefined, BwrapSandboxPathError> {
  const dotGitPath = NodePath.posix.join(input.canonicalCwd, ".git");
  const dotGitStat = yield* Effect.promise(async () => {
    try {
      return await NodeFSP.lstat(dotGitPath);
    } catch {
      return undefined;
    }
  });

  if (dotGitStat === undefined) {
    return undefined;
  }

  if (dotGitStat.isSymbolicLink()) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: dotGitPath,
    });
  }

  if (dotGitStat.isDirectory()) {
    const canonicalGitDir = yield* Effect.promise(() => tryRealpath(dotGitPath));
    if (canonicalGitDir === undefined) {
      return yield* new BwrapSandboxPathError({
        reason: "invalid_git_worktree",
        role: "git_common_dir",
        path: dotGitPath,
      });
    }
    const hooksDir = NodePath.posix.join(canonicalGitDir, "hooks");
    const configFile = NodePath.posix.join(canonicalGitDir, "config");
    const worktreeConfigFile = NodePath.posix.join(canonicalGitDir, "config.worktree");
    const worktreesDir = NodePath.posix.join(canonicalGitDir, "worktrees");
    yield* inspectOptionalGitSubdir(hooksDir);
    const configFileExists = yield* inspectOptionalGitRegularFile(configFile);
    const worktreeConfigFileExists = yield* inspectOptionalGitRegularFile(worktreeConfigFile);
    yield* inspectOptionalGitSubdir(worktreesDir);
    return {
      kind: "regular_repo",
      binds: {
        gitDir: canonicalGitDir,
        hooksDir,
        configFile,
        configFileExists,
        worktreeConfigFile,
        worktreeConfigFileExists,
        // Always mask `<gitDir>/worktrees` so sibling worktrees created later stay hidden too.
        maskWorktreesDir: worktreesDir,
      },
    };
  }

  if (!dotGitStat.isFile()) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: dotGitPath,
    });
  }

  const rawGitFile = yield* Effect.tryPromise({
    try: () => readRegularFileNoFollow(dotGitPath, MAX_GITDIR_FILE_BYTES),
    catch: (cause) =>
      new BwrapSandboxPathError({
        reason: "invalid_git_worktree",
        role: "git_common_dir",
        path: dotGitPath,
        cause,
      }),
  });

  const firstLine = rawGitFile.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^gitdir:\s*(.+)$/.exec(firstLine);
  const rawGitDirTarget = match?.[1]?.trim();
  if (
    rawGitDirTarget === undefined ||
    rawGitDirTarget.length === 0 ||
    rawGitDirTarget.includes("\0")
  ) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: dotGitPath,
    });
  }

  const resolvedGitDirInput = NodePath.posix.isAbsolute(rawGitDirTarget)
    ? rawGitDirTarget
    : NodePath.posix.resolve(input.canonicalCwd, rawGitDirTarget);

  const worktreeGitDir = yield* canonicalizeAndValidateBindPath({
    rawPath: resolvedGitDirInput,
    role: "git_common_dir",
    ownStateRoots: input.ownStateRoots,
    foreignForbiddenRoots: input.foreignForbiddenRoots,
    homeRoots: input.homeRoots,
    expectedType: "directory",
  });

  // Linked worktrees must have a non-symlink commondir file pointing to the shared `.git` directory.
  const commonDirFile = NodePath.posix.join(worktreeGitDir, "commondir");
  const rawCommonDir = yield* Effect.tryPromise({
    try: async () => (await readRegularFileNoFollow(commonDirFile, MAX_GITDIR_FILE_BYTES)).trim(),
    catch: (cause) =>
      new BwrapSandboxPathError({
        reason: "invalid_git_worktree",
        role: "git_common_dir",
        path: commonDirFile,
        cause,
      }),
  });
  if (rawCommonDir.length === 0 || rawCommonDir.includes("\0")) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: commonDirFile,
    });
  }

  const resolvedCommonInput = NodePath.posix.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : NodePath.posix.resolve(worktreeGitDir, rawCommonDir);
  const commonDir = yield* canonicalizeAndValidateBindPath({
    rawPath: resolvedCommonInput,
    role: "git_common_dir",
    ownStateRoots: input.ownStateRoots,
    foreignForbiddenRoots: input.foreignForbiddenRoots,
    homeRoots: input.homeRoots,
    expectedType: "directory",
  });

  // Require worktreeGitDir to be a direct child of `<commonDir>/worktrees/` (never commonDir itself).
  const worktreesParent = NodePath.posix.join(commonDir, "worktrees");
  if (worktreeGitDir === commonDir || NodePath.posix.dirname(worktreeGitDir) !== worktreesParent) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: worktreeGitDir,
    });
  }

  // Bidirectional check: `<worktreeGitDir>/gitdir` must point back to `<canonicalCwd>/.git`.
  const backPointerFile = NodePath.posix.join(worktreeGitDir, "gitdir");
  const rawBackPointer = yield* Effect.tryPromise({
    try: async () => (await readRegularFileNoFollow(backPointerFile, MAX_GITDIR_FILE_BYTES)).trim(),
    catch: (cause) =>
      new BwrapSandboxPathError({
        reason: "invalid_git_worktree",
        role: "git_common_dir",
        path: backPointerFile,
        cause,
      }),
  });
  if (rawBackPointer.length === 0 || rawBackPointer.includes("\0")) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: backPointerFile,
    });
  }
  const resolvedBackPointerInput = NodePath.posix.isAbsolute(rawBackPointer)
    ? rawBackPointer
    : NodePath.posix.resolve(worktreeGitDir, rawBackPointer);
  const resolvedBackPointer = yield* Effect.promise(() => tryRealpath(resolvedBackPointerInput));
  const canonicalDotGit = yield* Effect.promise(() => tryRealpath(dotGitPath));
  if (
    resolvedBackPointer === undefined ||
    canonicalDotGit === undefined ||
    resolvedBackPointer !== canonicalDotGit
  ) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: backPointerFile,
    });
  }

  // Confirm commonDir is a genuine git metadata directory (contains HEAD + objects/), never a working tree.
  const isGitMetadataDir = yield* Effect.promise(async () => {
    try {
      const [headStat, objectsStat] = await Promise.all([
        NodeFSP.stat(NodePath.posix.join(commonDir, "HEAD")),
        NodeFSP.stat(NodePath.posix.join(commonDir, "objects")),
      ]);
      return headStat.isFile() && objectsStat.isDirectory();
    } catch {
      return false;
    }
  });
  if (!isGitMetadataDir) {
    return yield* new BwrapSandboxPathError({
      reason: "invalid_git_worktree",
      role: "git_common_dir",
      path: commonDir,
    });
  }

  const hooksDir = NodePath.posix.join(commonDir, "hooks");
  const configFile = NodePath.posix.join(commonDir, "config");
  const worktreeConfigFile = NodePath.posix.join(worktreeGitDir, "config.worktree");
  yield* inspectOptionalGitSubdir(hooksDir);
  const configFileExists = yield* inspectOptionalGitRegularFile(configFile);
  const worktreeConfigFileExists = yield* inspectOptionalGitRegularFile(worktreeConfigFile);

  return {
    kind: "linked_worktree",
    binds: {
      dotGitFile: canonicalDotGit,
      commonDir,
      worktreeGitDir,
      maskWorktreesDir: worktreesParent,
      hooksDir,
      configFile,
      configFileExists,
      worktreeConfigFile,
      worktreeConfigFileExists,
    },
  };
});

function isSafeExternalRoDir(input: {
  readonly dir: string;
  readonly canonicalCwd: string;
  readonly homeRoots: ReadonlyArray<string>;
  readonly ownStateRoots: ReadonlyArray<string>;
  readonly foreignForbiddenRoots: ReadonlyArray<string>;
}): boolean {
  const normalized = normalizePosixPath(input.dir);
  if (UNSAFE_WIDEN_RO_ROOTS.has(normalized)) return false;
  if (isCoveredBySystemRoBinds(normalized)) return false;
  if (input.homeRoots.some((homeRoot) => isSameOrAncestor(normalized, homeRoot))) return false;
  if (
    isSameOrAncestor(normalized, input.canonicalCwd) ||
    isSameOrDescendant(normalized, input.canonicalCwd)
  ) {
    return false;
  }
  return (
    assertLexicalPathNotForbidden({
      candidate: normalized,
      role: "executable",
      ownStateRoots: input.ownStateRoots,
      foreignForbiddenRoots: input.foreignForbiddenRoots,
      homeRoots: input.homeRoots,
      isDirectory: true,
    }) === undefined
  );
}

async function readShebangInterpreterPath(
  executablePath: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  try {
    const handle = await NodeFSP.open(executablePath, NodeFS.constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(MAX_SHEBANG_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_SHEBANG_BYTES, 0);
      const header = buffer.subarray(0, bytesRead).toString("utf8");
      if (!header.startsWith("#!")) return undefined;
      const line = header.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (line.length === 0) return undefined;
      const tokens = line.split(/\s+/).filter((token) => token.length > 0);
      const first = tokens[0];
      if (first === undefined) return undefined;
      if (first === "/usr/bin/env" || first === "/bin/env") {
        const prog = tokens
          .slice(1)
          .find((token) => !token.startsWith("-") && !token.includes("="));
        if (prog === undefined) return undefined;
        if (NodePath.posix.isAbsolute(prog)) return prog;
        const pathEntries = (env?.PATH ?? "").split(":").filter((entry) => entry.length > 0);
        for (const entry of pathEntries) {
          if (!NodePath.posix.isAbsolute(entry)) continue;
          const candidate = NodePath.posix.join(entry, prog);
          try {
            const stat = await NodeFSP.stat(candidate);
            if (stat.isFile()) return candidate;
          } catch {
            // Try next PATH entry.
          }
        }
        return undefined;
      }
      return NodePath.posix.isAbsolute(first) ? first : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function discoverExternalExecutablePackageDir(input: {
  readonly canonicalExecutable: string;
  readonly canonicalCwd: string;
  readonly homeRoots: ReadonlyArray<string>;
  readonly ownStateRoots: ReadonlyArray<string>;
  readonly foreignForbiddenRoots: ReadonlyArray<string>;
}): Promise<string | undefined> {
  let cursor = NodePath.posix.dirname(input.canonicalExecutable);
  let packageDir: string | undefined;
  for (let depth = 0; depth < 4; depth += 1) {
    if (UNSAFE_WIDEN_RO_ROOTS.has(cursor)) break;
    if (await pathExists(NodePath.posix.join(cursor, "package.json"))) {
      packageDir = cursor;
      break;
    }
    const parent = NodePath.posix.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (packageDir === undefined) return undefined;

  // Prefer the enclosing `node_modules` tree when a CLI script lives inside a package installation.
  let candidate = packageDir;
  const pkgParent = NodePath.posix.dirname(packageDir);
  let nodeModulesDir: string | undefined;
  if (NodePath.posix.basename(pkgParent) === "node_modules") {
    nodeModulesDir = pkgParent;
  } else if (
    NodePath.posix.basename(pkgParent).startsWith("@") &&
    NodePath.posix.basename(NodePath.posix.dirname(pkgParent)) === "node_modules"
  ) {
    nodeModulesDir = NodePath.posix.dirname(pkgParent);
  }
  if (nodeModulesDir !== undefined) {
    const maybePnpmPkg = NodePath.posix.dirname(nodeModulesDir);
    const maybePnpmDir = NodePath.posix.dirname(maybePnpmPkg);
    const maybeOuterNm = NodePath.posix.dirname(maybePnpmDir);
    const bestNm =
      NodePath.posix.basename(maybePnpmDir) === ".pnpm" &&
      NodePath.posix.basename(maybeOuterNm) === "node_modules"
        ? maybeOuterNm
        : nodeModulesDir;
    if (
      isSafeExternalRoDir({
        dir: bestNm,
        canonicalCwd: input.canonicalCwd,
        homeRoots: input.homeRoots,
        ownStateRoots: input.ownStateRoots,
        foreignForbiddenRoots: input.foreignForbiddenRoots,
      })
    ) {
      candidate = bestNm;
    } else if (
      bestNm !== nodeModulesDir &&
      isSafeExternalRoDir({
        dir: nodeModulesDir,
        canonicalCwd: input.canonicalCwd,
        homeRoots: input.homeRoots,
        ownStateRoots: input.ownStateRoots,
        foreignForbiddenRoots: input.foreignForbiddenRoots,
      })
    ) {
      candidate = nodeModulesDir;
    }
  }

  return isSafeExternalRoDir({
    dir: candidate,
    canonicalCwd: input.canonicalCwd,
    homeRoots: input.homeRoots,
    ownStateRoots: input.ownStateRoots,
    foreignForbiddenRoots: input.foreignForbiddenRoots,
  })
    ? candidate
    : undefined;
}

/**
 * Extracts explicit mount candidates solely from server-trusted environment variables.
 * Never scans process arguments or untrusted per-request env vars for mount authority.
 */
export function extractSandboxBindsFromEnv(env: NodeJS.ProcessEnv | undefined): ExtractedEnvBinds {
  const providerProfileDirs: Array<string> = [];
  const helperRoPaths: Array<string> = [];
  const helperRwDirs: Array<string> = [];
  const socketPaths: Array<string> = [];

  if (env !== undefined) {
    for (const key of PROVIDER_PROFILE_ENV_VARS) {
      const value = env[key]?.trim();
      if (value !== undefined && value.length > 0) {
        providerProfileDirs.push(value);
      }
    }
    for (const key of TURN_HELPER_RO_ENV_VARS) {
      const value = env[key]?.trim();
      if (value !== undefined && value.length > 0) {
        helperRoPaths.push(value);
      }
    }
    for (const key of TURN_HELPER_RW_ENV_VARS) {
      const value = env[key]?.trim();
      if (value !== undefined && value.length > 0) {
        helperRwDirs.push(value);
      }
    }
    for (const key of TURN_SOCKET_ENV_VARS) {
      const value = env[key]?.trim();
      if (value !== undefined && value.length > 0) {
        socketPaths.push(value);
      }
    }
  }

  return {
    providerProfileDirs,
    helperRoPaths,
    helperRwDirs,
    socketPaths,
  };
}

function validateSandboxEnvEntries(
  sandboxEnv: Readonly<Record<string, string | undefined>> | undefined,
): Effect.Effect<Readonly<Record<string, string>> | undefined, BwrapSandboxPathError> {
  if (sandboxEnv === undefined) return Effect.undefined;
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(sandboxEnv)) {
    if (value === undefined) continue;
    if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      return Effect.fail(
        new BwrapSandboxPathError({
          reason: "invalid_env",
          role: "sandbox_env",
          path: key.replaceAll("\0", "<NUL>"),
        }),
      );
    }
    validated[key] = value;
  }
  return Effect.succeed(Object.keys(validated).length > 0 ? validated : undefined);
}

/**
 * Builds the bubblewrap (`bwrap`) flag prefix up to and including `--`, without trailing command/args.
 * Ordering matters: `--tmpfs /tmp` and the private scratch `$HOME` under `/tmp/t3-home` are mounted
 * before workspace, profile, socket, and helper binds so paths under `/tmp` (such as turn-scoped
 * Unix sockets or test worktrees) are selectively mounted without exposing sibling turns.
 */
function buildBwrapPrefixArgs(
  plan: Omit<BwrapSandboxPlan, "command" | "args">,
): ReadonlyArray<string> {
  const args: Array<string> = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
  ];
  if (plan.newSession !== false) {
    args.push("--new-session");
  }

  for (const dir of plan.roSystemBinds ?? DEFAULT_BWRAP_RO_SYSTEM_BINDS) {
    args.push("--ro-bind", dir, dir);
  }
  for (const dir of plan.roTrySystemBinds ?? DEFAULT_BWRAP_RO_TRY_SYSTEM_BINDS) {
    args.push("--ro-bind-try", dir, dir);
  }

  args.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--dir",
    SANDBOX_SCRATCH_HOME,
    "--dir",
    `${SANDBOX_SCRATCH_HOME}/.cache`,
    "--dir",
    `${SANDBOX_SCRATCH_HOME}/.config`,
    "--dir",
    `${SANDBOX_SCRATCH_HOME}/.local`,
    "--dir",
    `${SANDBOX_SCRATCH_HOME}/.local/share`,
    "--dir",
    `${SANDBOX_SCRATCH_HOME}/.local/state`,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "HOME",
    SANDBOX_SCRATCH_HOME,
    "--setenv",
    "XDG_CACHE_HOME",
    `${SANDBOX_SCRATCH_HOME}/.cache`,
    "--setenv",
    "XDG_CONFIG_HOME",
    `${SANDBOX_SCRATCH_HOME}/.config`,
    "--setenv",
    "XDG_DATA_HOME",
    `${SANDBOX_SCRATCH_HOME}/.local/share`,
    "--setenv",
    "XDG_STATE_HOME",
    `${SANDBOX_SCRATCH_HOME}/.local/state`,
  );

  const mountedRw = new Set<string>();
  const mountedRo = new Set<string>();

  const pushRo = (target: string) => {
    const normalized = normalizePosixPath(target);
    if (isCoveredBySystemRoBinds(normalized)) return;
    if (mountedRo.has(normalized) || mountedRw.has(normalized)) return;
    mountedRo.add(normalized);
    args.push("--ro-bind", normalized, normalized);
  };

  const pushRw = (target: string) => {
    const normalized = normalizePosixPath(target);
    if (mountedRw.has(normalized)) return;
    mountedRw.add(normalized);
    args.push("--bind", normalized, normalized);
  };

  for (const roPath of plan.extraRoBinds) {
    pushRo(roPath);
  }

  // Thread workspace / worktree (always RW).
  pushRw(plan.cwd);

  const emptyConfigLockSource =
    plan.emptyRoFile !== undefined ? normalizePosixPath(plan.emptyRoFile) : "/dev/null";

  // Linked git worktree common-dir: lock down `.git` pointer, shared hooks, shared/worktree configs, and sibling worktree dirs.
  if (plan.gitWorktree !== undefined) {
    const dotGit = normalizePosixPath(plan.gitWorktree.dotGitFile);
    const commonDir = normalizePosixPath(plan.gitWorktree.commonDir);
    const maskDir = normalizePosixPath(plan.gitWorktree.maskWorktreesDir);
    const wtGitDir = normalizePosixPath(plan.gitWorktree.worktreeGitDir);
    const hooksDir = normalizePosixPath(plan.gitWorktree.hooksDir);
    const configFile = normalizePosixPath(plan.gitWorktree.configFile);
    const wtConfigFile = normalizePosixPath(
      plan.gitWorktree.worktreeConfigFile ?? NodePath.posix.join(wtGitDir, "config.worktree"),
    );

    args.push("--ro-bind", dotGit, dotGit);
    pushRw(commonDir);
    // Isolate shared hooks on a private ephemeral tmpfs so writes never affect host or sibling worktrees.
    args.push("--tmpfs", hooksDir);
    // Lock shared git config (or bind empty 0444 file when absent) so core.fsmonitor/hooksPath cannot be modified or created.
    if (plan.gitWorktree.configFileExists === false) {
      args.push("--ro-bind", emptyConfigLockSource, configFile);
    } else {
      args.push("--ro-bind", configFile, configFile);
    }
    // Hide all sibling `.git/worktrees/*` entries, then re-bind strictly this worktree's metadata dir.
    args.push("--tmpfs", maskDir);
    mountedRw.add(wtGitDir);
    args.push("--bind", wtGitDir, wtGitDir);
    args.push(
      "--ro-bind",
      NodePath.posix.join(wtGitDir, "gitdir"),
      NodePath.posix.join(wtGitDir, "gitdir"),
      "--ro-bind",
      NodePath.posix.join(wtGitDir, "commondir"),
      NodePath.posix.join(wtGitDir, "commondir"),
    );
    if (plan.gitWorktree.worktreeConfigFileExists === true) {
      args.push("--ro-bind", wtConfigFile, wtConfigFile);
    } else {
      args.push("--ro-bind", emptyConfigLockSource, wtConfigFile);
    }
  }

  // Ordinary `.git/` repository: make `.git` itself a mountpoint (blocking `mv .git`), lock hooks/configs, and mask sibling worktrees.
  if (plan.gitRepo !== undefined) {
    const gitDir = normalizePosixPath(plan.gitRepo.gitDir);
    const hooksDir = normalizePosixPath(plan.gitRepo.hooksDir);
    const configFile = normalizePosixPath(plan.gitRepo.configFile);
    const wtConfigFile = normalizePosixPath(
      plan.gitRepo.worktreeConfigFile ?? NodePath.posix.join(gitDir, "config.worktree"),
    );
    mountedRw.add(gitDir);
    args.push("--bind", gitDir, gitDir);
    args.push("--tmpfs", hooksDir);
    if (plan.gitRepo.configFileExists) {
      args.push("--ro-bind", configFile, configFile);
    } else {
      args.push("--ro-bind", emptyConfigLockSource, configFile);
    }
    if (plan.gitRepo.worktreeConfigFileExists === true) {
      args.push("--ro-bind", wtConfigFile, wtConfigFile);
    } else {
      args.push("--ro-bind", emptyConfigLockSource, wtConfigFile);
    }
    if (plan.gitRepo.maskWorktreesDir !== undefined) {
      args.push("--tmpfs", normalizePosixPath(plan.gitRepo.maskWorktreesDir));
    }
  }

  for (const profileDir of plan.providerProfileDirs) {
    pushRw(profileDir);
  }
  for (const cacheDir of plan.toolCacheDirs) {
    pushRw(cacheDir);
  }
  for (const extraRw of plan.extraRwBinds) {
    pushRw(extraRw);
  }
  for (const socketPath of plan.socketPaths) {
    pushRw(socketPath);
  }
  for (const helperPath of plan.helperPaths) {
    pushRo(helperPath);
  }

  // Apply untrusted per-request env vars strictly inside the sandbox (never on the host bwrap process).
  if (plan.sandboxEnv !== undefined) {
    for (const [key, value] of Object.entries(plan.sandboxEnv)) {
      args.push("--setenv", key, value);
    }
  }

  args.push("--chdir", normalizePosixPath(plan.chdir), "--");
  return args;
}

export function buildBwrapArgs(plan: BwrapSandboxPlan): ReadonlyArray<string> {
  return [...buildBwrapPrefixArgs(plan), plan.command, ...plan.args];
}

export const wrapCommandWithBwrap = Effect.fn("bwrapSandbox.wrapCommand")(function* (
  input: WrapCommandWithBwrapInput,
): Effect.fn.Return<ProcessSandboxCommand, BwrapSandboxError> {
  if (input.cwd === undefined) {
    return yield* new BwrapSandboxPathError({
      reason: "non_absolute",
      role: "cwd",
      path: "<missing>",
    });
  }

  const validatedSandboxEnv = yield* validateSandboxEnvEntries(input.sandboxEnv);

  const { ownStateRoots, foreignForbiddenRoots } = yield* Effect.promise(() =>
    expandForbiddenRoots(input.ownStateDir, input.forbiddenUserdataDirs),
  );
  const homeRoots = yield* Effect.promise(() => expandHomeRoots(input.env?.HOME));

  const canonicalCwd = yield* canonicalizeAndValidateBindPath({
    rawPath: input.cwd,
    role: "cwd",
    ownStateRoots,
    foreignForbiddenRoots,
    homeRoots,
    expectedType: "directory",
  });

  let canonicalChdir = canonicalCwd;
  if (input.chdir !== undefined && input.chdir !== input.cwd) {
    canonicalChdir = yield* canonicalizeAndValidateBindPath({
      rawPath: input.chdir,
      role: "chdir",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
      expectedType: "directory",
    });
    if (!isSameOrDescendant(canonicalChdir, canonicalCwd)) {
      return yield* new BwrapSandboxPathError({
        reason: "chdir_outside_workspace",
        role: "chdir",
        path: canonicalChdir,
      });
    }
  }

  const gitMetadata = yield* resolveGitMetadata({
    canonicalCwd,
    ownStateRoots,
    foreignForbiddenRoots,
    homeRoots,
  });
  const gitWorktree = gitMetadata?.kind === "linked_worktree" ? gitMetadata.binds : undefined;
  const gitRepo = gitMetadata?.kind === "regular_repo" ? gitMetadata.binds : undefined;

  const needsEmptyRoFile =
    (gitWorktree !== undefined &&
      (gitWorktree.configFileExists === false || gitWorktree.worktreeConfigFileExists !== true)) ||
    (gitRepo !== undefined &&
      (!gitRepo.configFileExists || gitRepo.worktreeConfigFileExists !== true));
  const emptyRoFile = needsEmptyRoFile
    ? yield* Effect.tryPromise({
        try: () => ensureEmptyRoFilePath(input.ownStateDir),
        catch: (cause) =>
          new BwrapSandboxPathError({
            reason: "invalid_git_worktree",
            role: "git_common_dir",
            path: input.ownStateDir ?? NodeOS.tmpdir(),
            cause,
          }),
      })
    : undefined;

  const extracted = extractSandboxBindsFromEnv(input.env);

  const providerProfileDirs: Array<string> = [];
  for (const raw of [...extracted.providerProfileDirs, ...(input.providerProfileDirs ?? [])]) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "provider_profile",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
      expectedType: "directory",
    });
    providerProfileDirs.push(validated);
  }

  const toolCacheDirs: Array<string> = [];
  for (const raw of input.toolCacheDirs ?? []) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "tool_cache",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
      expectedType: "directory",
    });
    toolCacheDirs.push(validated);
  }

  const extraRwBinds: Array<string> = [];
  for (const raw of [...extracted.helperRwDirs, ...(input.extraRwBinds ?? [])]) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "extra_rw",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
    });
    extraRwBinds.push(validated);
  }

  const extraRoBinds: Array<string> = [];
  for (const raw of input.extraRoBinds ?? []) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "extra_ro",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
    });
    extraRoBinds.push(validated);
  }

  const socketPaths: Array<string> = [];
  for (const raw of [...extracted.socketPaths, ...(input.socketPaths ?? [])]) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "socket",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
      expectedType: "socket",
    });
    socketPaths.push(validated);
  }

  const helperPaths: Array<string> = [];
  for (const raw of [...extracted.helperRoPaths, ...(input.helperPaths ?? [])]) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "helper",
      ownStateRoots,
      foreignForbiddenRoots,
      homeRoots,
    });
    helperPaths.push(validated);
  }

  // Bind trusted absolute executables outside OS RO binds (including system-dir symlinks targeting
  // external installs), plus their safe package/node_modules dir and any non-system shebang interpreter.
  if (
    input.allowExternalExecutableBind !== false &&
    NodePath.posix.isAbsolute(input.command) &&
    !isSameOrDescendant(input.command, canonicalCwd)
  ) {
    const lexicalInSystemRo = isCoveredBySystemRoBinds(input.command);
    const systemCommandExists = lexicalInSystemRo
      ? yield* Effect.promise(() => pathExists(input.command))
      : true;
    if (systemCommandExists) {
      const validatedExecutable = yield* canonicalizeAndValidateBindPath({
        rawPath: input.command,
        role: "executable",
        ownStateRoots,
        foreignForbiddenRoots,
        homeRoots,
        expectedType: "file",
      });
      const executableOutsideSystemRo =
        !lexicalInSystemRo || !isCoveredBySystemRoBinds(validatedExecutable);
      if (executableOutsideSystemRo) {
        if (!isCoveredBySystemRoBinds(validatedExecutable)) {
          extraRoBinds.push(validatedExecutable);
        }
        const cmdHops = yield* Effect.promise(() => collectNonSystemSymlinkHops(input.command));
        for (const hop of cmdHops) {
          if (hop === validatedExecutable || isCoveredBySystemRoBinds(hop)) continue;
          const lexicalHopError = assertLexicalPathNotForbidden({
            candidate: hop,
            role: "executable",
            ownStateRoots,
            foreignForbiddenRoots,
            homeRoots,
          });
          if (lexicalHopError !== undefined) {
            return yield* lexicalHopError;
          }
          extraRoBinds.push(hop);
        }

        const packageRoDir = yield* Effect.promise(() =>
          discoverExternalExecutablePackageDir({
            canonicalExecutable: validatedExecutable,
            canonicalCwd,
            homeRoots,
            ownStateRoots,
            foreignForbiddenRoots,
          }),
        );
        if (packageRoDir !== undefined) {
          const validatedPkgDir = yield* canonicalizeAndValidateBindPath({
            rawPath: packageRoDir,
            role: "executable",
            ownStateRoots,
            foreignForbiddenRoots,
            homeRoots,
            expectedType: "directory",
          });
          if (!isCoveredBySystemRoBinds(validatedPkgDir)) {
            extraRoBinds.push(validatedPkgDir);
          }
        }
      }

      const shebangInterpreter = yield* Effect.promise(() =>
        readShebangInterpreterPath(validatedExecutable, input.env),
      );
      if (
        shebangInterpreter !== undefined &&
        !isSameOrDescendant(shebangInterpreter, canonicalCwd)
      ) {
        // Resolve symlinks even when lexically inside system dirs (e.g. /usr/local/bin/node -> /srv/node/bin/node).
        const lexicalInterpInSystemRo = isCoveredBySystemRoBinds(shebangInterpreter);
        const interpExists = lexicalInterpInSystemRo
          ? yield* Effect.promise(() => pathExists(shebangInterpreter))
          : true;
        if (interpExists) {
          const validatedInterpreter = yield* canonicalizeAndValidateBindPath({
            rawPath: shebangInterpreter,
            role: "executable",
            ownStateRoots,
            foreignForbiddenRoots,
            homeRoots,
            expectedType: "file",
          }).pipe(
            Effect.catchIf(
              (err) => err.reason === "missing_path",
              () => Effect.undefined,
            ),
          );
          if (validatedInterpreter !== undefined) {
            if (!isCoveredBySystemRoBinds(validatedInterpreter)) {
              extraRoBinds.push(validatedInterpreter);
            }
            const interpHops = yield* Effect.promise(() =>
              collectNonSystemSymlinkHops(shebangInterpreter),
            );
            for (const hop of interpHops) {
              if (hop === validatedInterpreter || isCoveredBySystemRoBinds(hop)) continue;
              const lexicalHopError = assertLexicalPathNotForbidden({
                candidate: hop,
                role: "executable",
                ownStateRoots,
                foreignForbiddenRoots,
                homeRoots,
              });
              if (lexicalHopError !== undefined) {
                return yield* lexicalHopError;
              }
              extraRoBinds.push(hop);
            }
          }
        }
      }
    }
  }

  const prefixArgs = buildBwrapPrefixArgs({
    bwrapBinaryPath: input.bwrapBinaryPath,
    cwd: canonicalCwd,
    chdir: canonicalChdir,
    ...(gitWorktree === undefined ? {} : { gitWorktree }),
    ...(gitRepo === undefined ? {} : { gitRepo }),
    ...(emptyRoFile === undefined ? {} : { emptyRoFile }),
    providerProfileDirs,
    toolCacheDirs,
    extraRwBinds,
    extraRoBinds,
    socketPaths,
    helperPaths,
    ...(validatedSandboxEnv === undefined ? {} : { sandboxEnv: validatedSandboxEnv }),
    ...(input.newSession === undefined ? {} : { newSession: input.newSession }),
  });

  return {
    command: input.bwrapBinaryPath,
    args: [...prefixArgs, input.command, ...input.args],
    prefixArgs,
    hostEnv: sanitizeHostEnvForSandboxLaunch(input.env),
  };
});

export const make = Effect.gen(function* () {
  const serverConfigOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const enabled =
    Option.isSome(serverConfigOption) && serverConfigOption.value.teamBwrapSandbox === true;
  if (!enabled) {
    return ProcessSandbox.defaultValue();
  }

  const serverConfig = serverConfigOption.value;
  const hostEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const availability = yield* checkBwrapAvailability();

  yield* Effect.logInfo("Linux bwrap worktree sandbox enabled", {
    binaryPath: availability.binaryPath,
  });

  const wrap = Effect.fn("bwrapSandbox.wrap")(function* (
    input: ProcessSandboxWrapInput,
  ): Effect.fn.Return<ProcessSandboxCommand, Error> {
    const effectiveEnv = input.env ?? hostEnvironment;
    const resolvedCommand = NodePath.posix.isAbsolute(input.command)
      ? input.command
      : ((yield* resolveCommandPath(input.command, { env: effectiveEnv }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
        )) ?? input.command);

    return yield* wrapCommandWithBwrap({
      bwrapBinaryPath: availability.binaryPath,
      command: resolvedCommand,
      args: input.args,
      cwd: input.cwd,
      ...(input.chdir === undefined ? {} : { chdir: input.chdir }),
      env: effectiveEnv,
      ...(input.sandboxEnv === undefined ? {} : { sandboxEnv: input.sandboxEnv }),
      ownStateDir: serverConfig.stateDir,
      ...(input.newSession === undefined ? {} : { newSession: input.newSession }),
      ...(input.allowExternalExecutableBind === undefined
        ? {}
        : { allowExternalExecutableBind: input.allowExternalExecutableBind }),
      ...(input.extraProviderProfileDirs === undefined
        ? {}
        : { providerProfileDirs: input.extraProviderProfileDirs }),
      ...(input.extraSocketPaths === undefined ? {} : { socketPaths: input.extraSocketPaths }),
      ...(input.extraHelperPaths === undefined ? {} : { helperPaths: input.extraHelperPaths }),
      ...(input.extraRoBinds === undefined ? {} : { extraRoBinds: input.extraRoBinds }),
      ...(input.extraRwBinds === undefined ? {} : { extraRwBinds: input.extraRwBinds }),
    });
  });

  return {
    enabled: true,
    wrap,
  } satisfies ProcessSandboxShape;
});

export const layer = Layer.effect(ProcessSandbox, make).pipe(Layer.provide(ProcessRunner.layer));
