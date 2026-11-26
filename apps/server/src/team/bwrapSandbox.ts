// @effect-diagnostics nodeBuiltinImport:off -- Uses lstat/realpath/stat to enforce canonical mount validation and symlink/userdata escape prevention.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ProcessSandbox,
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
const MAX_GITDIR_FILE_BYTES = 8_192;

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
  readonly commonDir: string;
  readonly worktreeGitDir: string;
  /** When set, mounted as tmpfs before re-binding `worktreeGitDir` so sibling worktree git dirs stay hidden. */
  readonly maskWorktreesDir?: string | undefined;
}

export interface BwrapSandboxPlan {
  readonly bwrapBinaryPath: string;
  readonly cwd: string;
  readonly chdir: string;
  readonly gitWorktree?: BwrapGitWorktreeBinds | undefined;
  readonly roSystemBinds?: ReadonlyArray<string> | undefined;
  readonly roTrySystemBinds?: ReadonlyArray<string> | undefined;
  readonly providerProfileDirs: ReadonlyArray<string>;
  readonly toolCacheDirs: ReadonlyArray<string>;
  readonly extraRwBinds: ReadonlyArray<string>;
  readonly extraRoBinds: ReadonlyArray<string>;
  readonly socketPaths: ReadonlyArray<string>;
  readonly helperPaths: ReadonlyArray<string>;
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
  readonly ownStateDir?: string | undefined;
  readonly forbiddenUserdataDirs?: ReadonlyArray<string> | undefined;
  readonly providerProfileDirs?: ReadonlyArray<string> | undefined;
  readonly toolCacheDirs?: ReadonlyArray<string> | undefined;
  readonly extraRwBinds?: ReadonlyArray<string> | undefined;
  readonly extraRoBinds?: ReadonlyArray<string> | undefined;
  readonly socketPaths?: ReadonlyArray<string> | undefined;
  readonly helperPaths?: ReadonlyArray<string> | undefined;
  readonly newSession?: boolean | undefined;
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

function isAllowedOwnStateProfileDir(candidate: string, ownStateDir: string): boolean {
  const normalizedCandidate = normalizePosixPath(candidate);
  const normalizedState = normalizePosixPath(ownStateDir);
  if (!normalizedCandidate.startsWith(`${normalizedState}/`)) {
    return false;
  }
  const relative = normalizedCandidate.slice(normalizedState.length + 1);
  const segments = relative.split("/");
  if (segments.length !== 3) {
    return false;
  }
  const [bucket, driver, profileId] = segments;
  if (
    bucket === undefined ||
    driver === undefined ||
    profileId === undefined ||
    !ALLOWED_OWN_STATE_PROFILE_PARENTS.has(bucket)
  ) {
    return false;
  }
  return (
    driver.length > 0 &&
    driver !== "." &&
    driver !== ".." &&
    profileId.length > 0 &&
    profileId !== "." &&
    profileId !== ".."
  );
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
    };
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

const canonicalizeAndValidateBindPath = Effect.fn("bwrapSandbox.validateBindPath")(
  function* (input: {
    readonly rawPath: string;
    readonly role: BwrapBindRole;
    readonly ownStateRoots: ReadonlyArray<string>;
    readonly foreignForbiddenRoots: ReadonlyArray<string>;
    readonly requireExists?: boolean | undefined;
    readonly expectedType?: "directory" | "file" | "any" | undefined;
  }): Effect.fn.Return<string, BwrapSandboxPathError> {
    const { rawPath, role, ownStateRoots, foreignForbiddenRoots } = input;
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

    const requireExists = input.requireExists ?? true;
    const expectedType = input.expectedType ?? "any";

    const canonical = yield* Effect.tryPromise({
      try: async () => {
        try {
          const resolved = normalizePosixPath(await NodeFSP.realpath(rawPath));
          const stat = await NodeFSP.stat(resolved);
          return { resolved, stat };
        } catch (error) {
          if (!requireExists) {
            return { resolved: normalizePosixPath(rawPath), stat: undefined };
          }
          throw error;
        }
      },
      catch: (cause) =>
        new BwrapSandboxPathError({
          reason: "missing_path",
          role,
          path: rawPath,
          cause,
        }),
    });

    if (canonical.stat !== undefined) {
      if (expectedType === "directory" && !canonical.stat.isDirectory()) {
        return yield* new BwrapSandboxPathError({
          reason: "missing_path",
          role,
          path: canonical.resolved,
        });
      }
      if (expectedType === "file" && !canonical.stat.isFile()) {
        return yield* new BwrapSandboxPathError({
          reason: "missing_path",
          role,
          path: canonical.resolved,
        });
      }
    }

    const candidate = canonical.resolved;
    if (candidate === "/") {
      return yield* new BwrapSandboxPathError({
        reason: "forbidden_userdata_path",
        role,
        path: candidate,
      });
    }

    const baseName = NodePath.posix.basename(candidate);
    if (baseName.startsWith("statev2.sqlite") || baseName === "ServerSecretStore") {
      return yield* new BwrapSandboxPathError({
        reason: "forbidden_userdata_path",
        role,
        path: candidate,
      });
    }

    // Never allow binding any ancestor of a forbidden userdata directory (such as /var/lib/t3runner or /var/lib/t3hub).
    for (const root of [...ownStateRoots, ...foreignForbiddenRoots]) {
      if (isSameOrAncestor(candidate, root)) {
        return yield* new BwrapSandboxPathError({
          reason: "forbidden_userdata_path",
          role,
          path: candidate,
        });
      }
    }

    // Never allow binding anything inside a foreign/hub userdata root.
    for (const foreignRoot of foreignForbiddenRoots) {
      if (isSameOrDescendant(candidate, foreignRoot)) {
        return yield* new BwrapSandboxPathError({
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
          return yield* new BwrapSandboxPathError({
            reason: "forbidden_userdata_path",
            role,
            path: candidate,
          });
        }
      }
    }

    // Defense-in-depth: refuse binding any directory that directly houses a T3 SQLite database.
    if (canonical.stat?.isDirectory()) {
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

const resolveGitWorktreeCommonDir = Effect.fn("bwrapSandbox.resolveGitWorktreeCommonDir")(
  function* (input: {
    readonly canonicalCwd: string;
    readonly ownStateRoots: ReadonlyArray<string>;
    readonly foreignForbiddenRoots: ReadonlyArray<string>;
  }): Effect.fn.Return<BwrapGitWorktreeBinds | undefined, BwrapSandboxPathError> {
    const dotGitPath = NodePath.posix.join(input.canonicalCwd, ".git");
    const dotGitStat = yield* Effect.promise(async () => {
      try {
        return await NodeFSP.lstat(dotGitPath);
      } catch {
        return undefined;
      }
    });

    if (dotGitStat === undefined || dotGitStat.isDirectory()) {
      return undefined;
    }

    if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) {
      return yield* new BwrapSandboxPathError({
        reason: "invalid_git_worktree",
        role: "git_common_dir",
        path: dotGitPath,
      });
    }

    const rawGitFile = yield* Effect.tryPromise({
      try: async () => {
        if (dotGitStat.size > MAX_GITDIR_FILE_BYTES) {
          throw new Error("gitdir pointer file exceeds maximum size");
        }
        return await NodeFSP.readFile(dotGitPath, "utf8");
      },
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
      requireExists: true,
      expectedType: "directory",
    });

    // Resolve commondir if present (standard for `git worktree add`).
    const commonDirFile = NodePath.posix.join(worktreeGitDir, "commondir");
    const commonDirStat = yield* Effect.promise(async () => {
      try {
        return await NodeFSP.lstat(commonDirFile);
      } catch {
        return undefined;
      }
    });

    let commonDir = worktreeGitDir;
    if (commonDirStat !== undefined) {
      if (commonDirStat.isSymbolicLink() || !commonDirStat.isFile()) {
        return yield* new BwrapSandboxPathError({
          reason: "invalid_git_worktree",
          role: "git_common_dir",
          path: commonDirFile,
        });
      }
      const rawCommonDir = yield* Effect.tryPromise({
        try: async () => {
          if (commonDirStat.size > MAX_GITDIR_FILE_BYTES) {
            throw new Error("commondir file exceeds maximum size");
          }
          return (await NodeFSP.readFile(commonDirFile, "utf8")).trim();
        },
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
      commonDir = yield* canonicalizeAndValidateBindPath({
        rawPath: resolvedCommonInput,
        role: "git_common_dir",
        ownStateRoots: input.ownStateRoots,
        foreignForbiddenRoots: input.foreignForbiddenRoots,
        requireExists: true,
        expectedType: "directory",
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

    const worktreesParent = NodePath.posix.join(commonDir, "worktrees");
    const maskWorktreesDir =
      worktreeGitDir !== commonDir && NodePath.posix.dirname(worktreeGitDir) === worktreesParent
        ? worktreesParent
        : undefined;

    return {
      commonDir,
      worktreeGitDir,
      ...(maskWorktreesDir === undefined ? {} : { maskWorktreesDir }),
    };
  },
);

const MANAGED_TOKEN_SOCKET_REGEX = /"__managed-chatgpt-token"\s*,\s*"([^"]+)"/;

export function extractSandboxBindsFromEnvAndArgs(
  env: NodeJS.ProcessEnv | undefined,
  args: ReadonlyArray<string> | undefined,
): ExtractedEnvBinds {
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

  if (args !== undefined) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === undefined) continue;
      if (arg === "__managed-chatgpt-token") {
        const next = args[index + 1]?.trim();
        if (next !== undefined && next.length > 0) {
          socketPaths.push(next);
        }
        continue;
      }
      const embedded = MANAGED_TOKEN_SOCKET_REGEX.exec(arg);
      if (embedded?.[1] !== undefined && embedded[1].trim().length > 0) {
        socketPaths.push(embedded[1].trim());
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

/**
 * Pure builder for the bubblewrap (`bwrap`) argument vector.
 * Ordering matters: `--tmpfs /tmp` is mounted before workspace, profile, socket, and helper binds
 * so paths under `/tmp` (such as turn-scoped Unix sockets or test worktrees) are selectively
 * mounted into an otherwise private `/tmp` without exposing sibling turns.
 */
export function buildBwrapArgs(plan: BwrapSandboxPlan): ReadonlyArray<string> {
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

  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--setenv", "TMPDIR", "/tmp");

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

  // Linked git worktree common-dir (strictly masking sibling `.git/worktrees/*` when present).
  if (plan.gitWorktree !== undefined) {
    pushRw(plan.gitWorktree.commonDir);
    if (plan.gitWorktree.maskWorktreesDir !== undefined) {
      const maskDir = normalizePosixPath(plan.gitWorktree.maskWorktreesDir);
      args.push("--tmpfs", maskDir);
      const wtGitDir = normalizePosixPath(plan.gitWorktree.worktreeGitDir);
      mountedRw.add(wtGitDir);
      args.push("--bind", wtGitDir, wtGitDir);
    } else if (plan.gitWorktree.worktreeGitDir !== plan.gitWorktree.commonDir) {
      pushRw(plan.gitWorktree.worktreeGitDir);
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

  args.push("--chdir", normalizePosixPath(plan.chdir), "--", plan.command, ...plan.args);
  return args;
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

  const { ownStateRoots, foreignForbiddenRoots } = yield* Effect.promise(() =>
    expandForbiddenRoots(input.ownStateDir, input.forbiddenUserdataDirs),
  );

  const canonicalCwd = yield* canonicalizeAndValidateBindPath({
    rawPath: input.cwd,
    role: "cwd",
    ownStateRoots,
    foreignForbiddenRoots,
    requireExists: true,
    expectedType: "directory",
  });

  let canonicalChdir = canonicalCwd;
  if (input.chdir !== undefined && input.chdir !== input.cwd) {
    canonicalChdir = yield* canonicalizeAndValidateBindPath({
      rawPath: input.chdir,
      role: "chdir",
      ownStateRoots,
      foreignForbiddenRoots,
      requireExists: true,
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

  const gitWorktree = yield* resolveGitWorktreeCommonDir({
    canonicalCwd,
    ownStateRoots,
    foreignForbiddenRoots,
  });

  const extracted = extractSandboxBindsFromEnvAndArgs(input.env, input.args);

  const providerProfileDirs: Array<string> = [];
  for (const raw of [...extracted.providerProfileDirs, ...(input.providerProfileDirs ?? [])]) {
    const validated = yield* canonicalizeAndValidateBindPath({
      rawPath: raw,
      role: "provider_profile",
      ownStateRoots,
      foreignForbiddenRoots,
      requireExists: true,
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
      requireExists: true,
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
      requireExists: true,
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
      requireExists: true,
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
      requireExists: true,
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
      requireExists: true,
    });
    helperPaths.push(validated);
  }

  // If the target executable is an absolute path outside standard OS RO binds and outside cwd, bind it read-only.
  if (
    NodePath.posix.isAbsolute(input.command) &&
    !isCoveredBySystemRoBinds(input.command) &&
    !isSameOrDescendant(input.command, canonicalCwd)
  ) {
    const validatedExecutable = yield* canonicalizeAndValidateBindPath({
      rawPath: input.command,
      role: "executable",
      ownStateRoots,
      foreignForbiddenRoots,
      requireExists: true,
      expectedType: "file",
    });
    if (!isCoveredBySystemRoBinds(validatedExecutable)) {
      extraRoBinds.push(validatedExecutable);
    }
    const normalizedCmd = normalizePosixPath(input.command);
    if (normalizedCmd !== validatedExecutable && !isCoveredBySystemRoBinds(normalizedCmd)) {
      // Preserve symlink path when the command path differs from its realpath.
      extraRoBinds.push(normalizedCmd);
    }
  }

  const bwrapArgs = buildBwrapArgs({
    bwrapBinaryPath: input.bwrapBinaryPath,
    cwd: canonicalCwd,
    chdir: canonicalChdir,
    ...(gitWorktree === undefined ? {} : { gitWorktree }),
    providerProfileDirs,
    toolCacheDirs,
    extraRwBinds,
    extraRoBinds,
    socketPaths,
    helperPaths,
    ...(input.newSession === undefined ? {} : { newSession: input.newSession }),
    command: input.command,
    args: input.args,
  });

  return {
    command: input.bwrapBinaryPath,
    args: bwrapArgs,
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
      ownStateDir: serverConfig.stateDir,
      ...(input.extraSocketPaths === undefined ? {} : { socketPaths: input.extraSocketPaths }),
      ...(input.extraHelperPaths === undefined ? {} : { helperPaths: input.extraHelperPaths }),
    });
  });

  return {
    enabled: true,
    wrap,
  } satisfies ProcessSandboxShape;
});

export const layer = Layer.effect(ProcessSandbox, make).pipe(Layer.provide(ProcessRunner.layer));
