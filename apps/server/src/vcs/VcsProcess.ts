// @effect-diagnostics nodeBuiltinImport:off -- Checks enclosing .git markers and resolves repo roots safely for sandboxed host Git calls.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import {
  type VcsError,
  type VcsProcessErrorContext,
  VcsProcessExitError,
  type VcsProcessExitFailureKind,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { ProcessSandbox } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";

import * as ServerConfig from "../config.ts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly onSpawn?: () => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: ProcessRunner.ProcessRunInput["outputMode"];
  readonly appendTruncationMarker?: boolean;
  readonly classifyFailure?: SourceControlProcessInput["classifyFailure"];
  readonly notFoundDetail?: string;
  readonly concurrency?: SourceControlProcessInput["concurrency"];
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}

export class VcsProcess extends Context.Service<
  VcsProcess,
  {
    readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
  }
>()("t3/vcs/VcsProcess") {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const VCS_PROCESS_CONCURRENCY = 8;
// Forge CLIs can take seconds per call; cap them together so git, checkpoints included, keeps slots.
const NON_GIT_PROCESS_CONCURRENCY = VCS_PROCESS_CONCURRENCY / 2;

/** Background non-git calls, such as the pull request sync sweep's, leave one slot for the rest. */
export const Background = Context.Reference<boolean>("t3/vcs/VcsProcess/Background", {
  defaultValue: () => false,
});

/** Shown to users when a Git command fails because another process holds the index lock. */
export const GIT_INDEX_LOCKED_DETAIL =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";

export const CHECKPOINT_CAPTURE_OPERATION = "GitVcsDriver.checkpoints.captureCheckpoint";

// Caller operations are diagnostic strings; only known labels may become metric attributes.
const gitMetricOperations = new Set([
  CHECKPOINT_CAPTURE_OPERATION,
  "GitVcsDriver.checkpoints.deleteCheckpointRefs",
  "GitVcsDriver.checkpoints.diffCheckpoints",
  "GitVcsDriver.checkpoints.hasHeadCommit",
  "GitVcsDriver.checkpoints.listAuthoredPaths",
  "GitVcsDriver.checkpoints.resolveCheckpointCommit",
  "GitVcsDriver.checkpoints.resolveGitCommonDir",
  "GitVcsDriver.checkpoints.resolveHeadCommit",
  "GitVcsDriver.checkpoints.restoreCheckpoint",
  "GitVcsDriver.detectRepository",
  "GitVcsDriver.filterIgnoredPaths",
  "GitVcsDriver.initRepository",
  "GitVcsDriver.isInsideWorkTree",
  "GitVcsDriver.listRemotes",
  "GitVcsDriver.listWorkspaceFiles",
  "GitVcsDriver.resolveGitCommonDir",
]);

/**
 * Append after inherited entries without changing argv or the user's config.
 * Windows env keys ignore case: read the last spelling of the count so command overrides win,
 * then update every spelling because Node may keep any one.
 * Leave invalid counts untouched so Git reports them.
 */
export const gitConfigEnv = (
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const countKeys = Object.keys(env).filter((name) =>
    platform === "win32" ? name.toUpperCase() === "GIT_CONFIG_COUNT" : name === "GIT_CONFIG_COUNT",
  );
  const countKey = countKeys.at(-1) ?? "GIT_CONFIG_COUNT";
  const inherited = env[countKey];
  if (
    inherited !== undefined &&
    inherited !== "" &&
    // Match Git's strtoul count syntax, including whitespace, signs and non-negative -0.
    /^[ \t\r\n\v\f]*(?:\+?\d+|-0+)/.exec(inherited)?.[0] !== inherited
  ) {
    return {};
  }
  const count = inherited === undefined || inherited === "" ? 0 : Number.parseInt(inherited, 10);
  return {
    ...Object.fromEntries([...countKeys, countKey].map((name) => [name, String(count + 1)])),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: value,
  };
};

/**
 * A project can contain a fake bare repository whose config runs commands such as `core.fsmonitor`.
 * Require `--git-dir` or `GIT_DIR` to open bare repositories; Git before 2.38 ignores this setting.
 */
export const explicitBareRepositoryEnv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  gitConfigEnv(env, "safe.bareRepository", "explicit", platform);

// A failing `gc --auto` (say, missing objects) reruns after every fetch and strands a full-size
// `tmp_pack_*` each time, so T3's frequent background Git calls could fill the disk.
const SERVER_GIT_CONFIG = [
  ["safe.bareRepository", "explicit"],
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
] as const;

export const serverGitConfigEnv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  const added: NodeJS.ProcessEnv = {};
  for (const [key, value] of SERVER_GIT_CONFIG) {
    Object.assign(added, gitConfigEnv({ ...env, ...added }, key, value, platform));
  }
  return added;
};

const SANDBOX_SAFE_FIXED_GIT_CONFIG = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["protocol.ext.allow", "never"],
  ["diff.external", ""],
  ["core.gitProxy", ""],
  ["core.askPass", ""],
  ["core.pager", "cat"],
  ["core.editor", "false"],
  ["sequence.editor", "false"],
  ["core.alternateRefsCommand", ""],
  ["uploadpack.packObjectsHook", ""],
  ["gpg.program", "false"],
  ["gpg.openpgp.program", "false"],
  ["gpg.ssh.program", "false"],
  ["gpg.x509.program", "false"],
  ["gpg.ssh.defaultKeyCommand", ""],
] as const;

const SANDBOX_GIT_DANGEROUS_KEY_REGEX =
  "^(filter\\.|diff\\..+\\.(textconv|command)$|merge\\..+\\.driver$|credential(\\..+)?\\.helper$|remote\\..+\\.(uploadpack|receivepack|proxy)$|difftool\\..+\\.cmd$|mergetool\\..+\\.cmd$|gpg(\\..+)?\\.(program|defaultkeycommand)$|submodule\\..+\\.update$|core\\.(sshcommand|gitproxy)$|hook\\..+\\.(command|event|enabled)$|include\\.path$|includeif\\..+\\.path$)";

const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  "-c",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

// Strictly read-only, index-only, and checkpoint Git subcommands that never write `.git/config`
// and never require host `~/.gitconfig` author identity (unlike `config`, `branch`, `checkout`, `commit`, `stash`, `tag`).
const SANDBOXABLE_WORKSPACE_GIT_SUBCOMMANDS = new Set([
  "add",
  "apply",
  "cat-file",
  "check-attr",
  "check-ignore",
  "commit-tree",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "hash-object",
  "index-pack",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "read-tree",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "rm",
  "show",
  "show-ref",
  "status",
  "symbolic-ref",
  "unpack-objects",
  "update-index",
  "update-ref",
  "write-tree",
]);

class SandboxGitConfigError extends Schema.TaggedError<SandboxGitConfigError>()(
  "SandboxGitConfigError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

interface GitParsedGlobalOptions {
  readonly locationArgs: ReadonlyArray<string>;
  readonly gitDirArg?: string | undefined;
  readonly workTreeArg?: string | undefined;
  readonly subcommand?: string | undefined;
}

function parseGitGlobalOptions(args: ReadonlyArray<string> | undefined): GitParsedGlobalOptions {
  if (args === undefined || args.length === 0) {
    return { locationArgs: [] };
  }
  const locationArgs: Array<string> = [];
  let gitDirArg: string | undefined;
  let workTreeArg: string | undefined;
  let subcommand: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-C" && i + 1 < args.length) {
      locationArgs.push("-C", args[i + 1]!);
      i += 1;
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      locationArgs.push(arg);
      continue;
    }
    if (arg === "--git-dir" && i + 1 < args.length) {
      gitDirArg = args[i + 1]!;
      locationArgs.push("--git-dir", gitDirArg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=")) {
      gitDirArg = arg.slice("--git-dir=".length);
      locationArgs.push(arg);
      continue;
    }
    if (arg === "--work-tree" && i + 1 < args.length) {
      workTreeArg = args[i + 1]!;
      i += 1;
      continue;
    }
    if (arg.startsWith("--work-tree=")) {
      workTreeArg = arg.slice("--work-tree=".length);
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(arg) && i + 1 < args.length) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      subcommand = arg;
      break;
    }
  }
  return {
    locationArgs,
    ...(gitDirArg === undefined ? {} : { gitDirArg }),
    ...(workTreeArg === undefined ? {} : { workTreeArg }),
    ...(subcommand === undefined ? {} : { subcommand }),
  };
}

function isSameOrInsideDir(candidate: string, root: string): boolean {
  const normCandidate = NodePath.resolve(candidate);
  const normRoot = NodePath.resolve(root);
  return normCandidate === normRoot || normCandidate.startsWith(`${normRoot}${NodePath.sep}`);
}

function tryRealpathSync(target: string): string {
  try {
    return NodeFS.realpathSync(target);
  } catch {
    return NodePath.resolve(target);
  }
}

function findEnclosingGitRoot(cwd: string): string | undefined {
  let cursor = NodePath.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (NodeFS.existsSync(NodePath.join(cursor, ".git"))) return cursor;
    const parent = NodePath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

export function canRunHostGitInWorkspaceSandbox(input: {
  readonly processSandboxEnabled: boolean;
  readonly cwd: string | undefined;
  readonly args: ReadonlyArray<string> | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly ownStateDir: string | undefined;
}):
  | { readonly eligible: false }
  | {
      readonly eligible: true;
      readonly sandboxCwd: string;
      readonly sandboxChdir: string;
      readonly sandboxArgs: ReadonlyArray<string>;
      readonly extraRwBinds: ReadonlyArray<string>;
      readonly extraRoBinds: ReadonlyArray<string>;
    } {
  if (
    !input.processSandboxEnabled ||
    input.cwd === undefined ||
    !NodePath.isAbsolute(input.cwd) ||
    !NodeFS.existsSync(input.cwd)
  ) {
    return { eligible: false };
  }
  const parsed = parseGitGlobalOptions(input.args);
  if (
    parsed.subcommand === undefined ||
    !SANDBOXABLE_WORKSPACE_GIT_SUBCOMMANDS.has(parsed.subcommand)
  ) {
    return { eligible: false };
  }
  // Reject explicit `--git-dir`/`--work-tree` and repo selector env vars.
  if (
    parsed.gitDirArg !== undefined ||
    parsed.workTreeArg !== undefined ||
    input.env.GIT_DIR?.trim() ||
    input.env.GIT_WORK_TREE?.trim() ||
    input.env.GIT_COMMON_DIR?.trim()
  ) {
    return { eligible: false };
  }

  const realCwd = tryRealpathSync(input.cwd);
  // Allow a single redundant leading `-C <dir>` pointing at the same canonical cwd (used by
  // GitVcsDriver.runGit) and strip it since bwrap already `--chdir`s to `realCwd`.
  let sandboxArgs: ReadonlyArray<string> = input.args ?? [];
  if (parsed.locationArgs.length > 0) {
    let redundantCDir: string | undefined;
    let stripCount = 0;
    if (
      parsed.locationArgs.length === 2 &&
      parsed.locationArgs[0] === "-C" &&
      input.args?.[0] === "-C" &&
      input.args[1] === parsed.locationArgs[1]
    ) {
      redundantCDir = parsed.locationArgs[1]!;
      stripCount = 2;
    } else if (
      parsed.locationArgs.length === 1 &&
      parsed.locationArgs[0]!.startsWith("-C") &&
      parsed.locationArgs[0]!.length > 2 &&
      input.args?.[0] === parsed.locationArgs[0]
    ) {
      redundantCDir = parsed.locationArgs[0]!.slice(2);
      stripCount = 1;
    }
    if (
      redundantCDir === undefined ||
      !NodePath.isAbsolute(redundantCDir) ||
      !NodeFS.existsSync(redundantCDir) ||
      tryRealpathSync(redundantCDir) !== realCwd
    ) {
      return { eligible: false };
    }
    sandboxArgs = (input.args ?? []).slice(stripCount);
  }

  const enclosingRoot = findEnclosingGitRoot(input.cwd);
  const mountRoot = enclosingRoot ?? input.cwd;
  const realMountRoot = tryRealpathSync(mountRoot);
  const realStateDir =
    input.ownStateDir !== undefined ? tryRealpathSync(input.ownStateDir) : undefined;
  const unsafeRoots = new Set([
    "/",
    "/tmp",
    "/dev",
    "/proc",
    "/sys",
    "/var",
    "/var/tmp",
    "/home",
    "/root",
    "/usr",
    "/etc",
    "/opt",
    "/run",
    "/mnt",
    "/media",
    "/srv",
  ]);
  const homeRoots: Array<string> = [];
  for (const rawHome of [input.env.HOME, HostProcess.HomeDirectory.defaultValue()]) {
    if (rawHome !== undefined && rawHome.trim().length > 0 && NodePath.isAbsolute(rawHome)) {
      const realHome = tryRealpathSync(rawHome);
      if (realHome !== "/") homeRoots.push(realHome);
    }
  }
  const isForbiddenSandboxTarget = (realPath: string) => {
    if (unsafeRoots.has(realPath)) return true;
    if (
      realStateDir !== undefined &&
      (isSameOrInsideDir(realPath, realStateDir) || isSameOrInsideDir(realStateDir, realPath))
    ) {
      return true;
    }
    for (const homeRoot of homeRoots) {
      if (isSameOrInsideDir(homeRoot, realPath)) return true;
    }
    return false;
  };
  if (isForbiddenSandboxTarget(realMountRoot) || isForbiddenSandboxTarget(realCwd)) {
    return { eligible: false };
  }
  if (!isSameOrInsideDir(realCwd, realMountRoot)) {
    return { eligible: false };
  }

  const extraRw = new Set<string>();
  const extraRo = new Set<string>();
  const registerDirIfSafe = (dirPath: string, targetSet: Set<string>) => {
    if (!NodePath.isAbsolute(dirPath) || !NodeFS.existsSync(dirPath)) return false;
    const real = tryRealpathSync(dirPath);
    if (isForbiddenSandboxTarget(real)) return false;
    try {
      if (!NodeFS.statSync(real).isDirectory()) return false;
    } catch {
      return false;
    }
    if (!isSameOrInsideDir(real, realMountRoot)) {
      targetSet.add(real);
    }
    return true;
  };
  const registerFileIfSafe = (filePath: string) => {
    if (!NodePath.isAbsolute(filePath) || !NodeFS.existsSync(filePath)) return false;
    const real = tryRealpathSync(filePath);
    if (isForbiddenSandboxTarget(real)) return false;
    try {
      if (!NodeFS.statSync(real).isFile()) return false;
    } catch {
      return false;
    }
    if (!isSameOrInsideDir(real, realMountRoot)) {
      extraRw.add(real);
    }
    return true;
  };

  for (const dirKey of ["GIT_OBJECT_DIRECTORY", "GIT_QUARANTINE_PATH"] as const) {
    const value = input.env[dirKey]?.trim();
    if (value && !registerDirIfSafe(value, extraRw)) return { eligible: false };
  }
  const altObjects = input.env.GIT_ALTERNATE_OBJECT_DIRECTORIES?.trim();
  if (altObjects) {
    // Reject multi-entry / escaped lists we cannot parse unambiguously, or bind single existing dirs RO.
    const unquoted =
      altObjects.startsWith('"') && altObjects.endsWith('"')
        ? altObjects.slice(1, -1).replace(/\\(.)/g, "$1")
        : altObjects;
    if (unquoted.includes(NodePath.delimiter) || !registerDirIfSafe(unquoted, extraRo)) {
      return { eligible: false };
    }
  }
  const indexFile = input.env.GIT_INDEX_FILE?.trim();
  if (indexFile) {
    if (
      !NodePath.isAbsolute(indexFile) ||
      !registerDirIfSafe(NodePath.dirname(indexFile), extraRw)
    ) {
      return { eligible: false };
    }
  }
  const trace2 = input.env.GIT_TRACE2_EVENT?.trim();
  if (trace2 && !registerFileIfSafe(trace2)) {
    return { eligible: false };
  }
  // Checkpoints may also inject `lfs.storage` into a scoped temp directory via GIT_CONFIG_*
  // (created lazily inside an existing private objects dir when git-lfs runs).
  const cfgCount = Number.parseInt(input.env.GIT_CONFIG_COUNT ?? "0", 10);
  if (Number.isFinite(cfgCount) && cfgCount > 0) {
    for (let i = 0; i < cfgCount; i += 1) {
      if (input.env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === "lfs.storage") {
        const storageVal = input.env[`GIT_CONFIG_VALUE_${i}`]?.trim();
        if (storageVal) {
          if (!NodePath.isAbsolute(storageVal)) return { eligible: false };
          const targetDir = NodeFS.existsSync(storageVal)
            ? storageVal
            : NodePath.dirname(storageVal);
          if (!registerDirIfSafe(targetDir, extraRw)) {
            return { eligible: false };
          }
        }
      }
    }
  }

  return {
    eligible: true,
    sandboxCwd: realMountRoot,
    sandboxChdir: realCwd,
    sandboxArgs,
    extraRwBinds: [...extraRw],
    extraRoBinds: [...extraRo],
  };
}

function hasEnclosingGitMarker(cwd: string): boolean {
  return findEnclosingGitRoot(cwd) !== undefined;
}

interface SandboxGitConfigProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
}

function parseScopedGitConfigProbeOutput(
  stdout: string,
  allowWorkspaceIncludes: boolean,
  options?: { readonly preserveHooksConfig?: boolean },
): Effect.Effect<
  {
    readonly configOverrides: ReadonlyArray<readonly [string, string]>;
    readonly disableGitProxyEnv: boolean;
  },
  SandboxGitConfigError
> {
  const filters = new Set<string>();
  const diffs = new Set<string>();
  const merges = new Set<string>();
  const credentialKeys = new Set<string>();
  const remoteUploadPacks = new Set<string>();
  const remoteReceivePacks = new Set<string>();
  const remoteProxies = new Set<string>();
  const diffToolCmds = new Set<string>();
  const mergeToolCmds = new Set<string>();
  const gpgProgramKeys = new Set<string>();
  const gpgDefaultKeyCmdKeys = new Set<string>();
  const submoduleUpdates = new Set<string>();
  const configuredHooks = new Set<string>();
  let hasSshCommand = false;
  let hasGitProxy = false;

  const tokens = stdout.split("\0");
  // `--show-scope --null --get-regexp` emits 2 NUL-terminated tokens per match:
  // [scope, "key\nvalue"] (followed by one trailing empty token).
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i]!;
    const keyVal = tokens[i + 1]!;
    const nlIdx = keyVal.indexOf("\n");
    const rawKey = nlIdx === -1 ? keyVal : keyVal.slice(0, nlIdx);
    const rawVal = nlIdx === -1 ? "" : keyVal.slice(nlIdx + 1);
    if (rawKey.length === 0) continue;

    // Neutralize Git 2.54+ configured hooks across all scopes unless the caller explicitly preserves hooks.
    if (options?.preserveHooksConfig !== true && rawKey.startsWith("hook.")) {
      const hookMatch = /^hook\.(.+)\.(command|event|enabled)$/.exec(rawKey);
      if (hookMatch !== null) {
        configuredHooks.add(hookMatch[1]!);
      }
    }

    if (scope !== "local" && scope !== "worktree") continue;

    // Refuse unsandboxed host Git whenever repo-local/worktree config uses include.path or
    // includeIf (eliminates TOCTOU symlink/file swaps between inspection and execution).
    if (
      !allowWorkspaceIncludes &&
      (rawKey === "include.path" ||
        (rawKey.startsWith("includeif.") && rawKey.endsWith(".path"))) &&
      rawVal.trim().length > 0
    ) {
      return Effect.fail(
        new SandboxGitConfigError({
          detail:
            "Refused unsandboxed host Git execution: repository-local config uses include.path or includeIf.",
        }),
      );
    }

    const firstDot = rawKey.indexOf(".");
    const lastDot = rawKey.lastIndexOf(".");
    if (firstDot <= 0 || lastDot <= firstDot) {
      if (rawKey === "core.sshcommand") {
        hasSshCommand = true;
      } else if (rawKey === "core.gitproxy") {
        hasGitProxy = true;
      } else if (rawKey === "credential.helper") {
        credentialKeys.add("credential.helper");
      }
      continue;
    }

    const section = rawKey.slice(0, firstDot);
    const subsection = rawKey.slice(firstDot + 1, lastDot);
    const variable = rawKey.slice(lastDot + 1);
    if (section === "filter") {
      filters.add(subsection);
    } else if (section === "diff" && (variable === "textconv" || variable === "command")) {
      diffs.add(subsection);
    } else if (section === "merge" && variable === "driver") {
      merges.add(subsection);
    } else if (section === "credential" && variable === "helper") {
      credentialKeys.add(`credential.${subsection}.helper`);
    } else if (section === "remote") {
      if (variable === "uploadpack") remoteUploadPacks.add(subsection);
      else if (variable === "receivepack") remoteReceivePacks.add(subsection);
      else if (variable === "proxy") remoteProxies.add(subsection);
    } else if (section === "difftool" && variable === "cmd") {
      diffToolCmds.add(subsection);
    } else if (section === "mergetool" && variable === "cmd") {
      mergeToolCmds.add(subsection);
    } else if (section === "gpg") {
      if (variable === "program") gpgProgramKeys.add(`gpg.${subsection}.program`);
      else if (variable === "defaultkeycommand")
        gpgDefaultKeyCmdKeys.add(`gpg.${subsection}.defaultkeycommand`);
    } else if (section === "submodule" && variable === "update") {
      submoduleUpdates.add(subsection);
    }
  }

  const configOverrides: Array<readonly [string, string]> = [];
  for (const name of filters) {
    configOverrides.push(
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
    );
  }
  for (const name of diffs) {
    configOverrides.push([`diff.${name}.textconv`, ""], [`diff.${name}.command`, ""]);
  }
  for (const name of merges) {
    configOverrides.push([`merge.${name}.driver`, ""]);
  }
  for (const key of credentialKeys) {
    configOverrides.push([key, ""]);
  }
  for (const name of remoteUploadPacks) {
    configOverrides.push([`remote.${name}.uploadpack`, "git-upload-pack"]);
  }
  for (const name of remoteReceivePacks) {
    configOverrides.push([`remote.${name}.receivepack`, "git-receive-pack"]);
  }
  for (const name of remoteProxies) {
    configOverrides.push([`remote.${name}.proxy`, ""]);
  }
  for (const name of diffToolCmds) {
    configOverrides.push([`difftool.${name}.cmd`, ""]);
  }
  for (const name of mergeToolCmds) {
    configOverrides.push([`mergetool.${name}.cmd`, ""]);
  }
  for (const key of gpgProgramKeys) {
    configOverrides.push([key, "false"]);
  }
  for (const key of gpgDefaultKeyCmdKeys) {
    configOverrides.push([key, ""]);
  }
  for (const name of submoduleUpdates) {
    configOverrides.push([`submodule.${name}.update`, "none"]);
  }
  for (const name of configuredHooks) {
    configOverrides.push([`hook.${name}.enabled`, "false"]);
  }
  if (hasSshCommand) {
    configOverrides.push(["core.sshCommand", "false"]);
  }
  return Effect.succeed({ configOverrides, disableGitProxyEnv: hasGitProxy });
}

/**
 * Asynchronously inspects the exact effective Git config context (`--show-scope --includes --null
 * --get-regexp`), fails closed on probe errors/truncation or repo-local includes for unsandboxed
 * host Git, and returns `GIT_CONFIG_*` / `GIT_PROXY_COMMAND` overrides neutralizing exec keys.
 */
export const resolveSandboxSafeGitConfigEnv = Effect.fn(
  "VcsProcess.resolveSandboxSafeGitConfigEnv",
)(function* <E = never>(input: {
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly allowWorkspaceIncludes: boolean;
  readonly preserveHooksConfig?: boolean;
  readonly runProbe: (probe: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
    readonly env: NodeJS.ProcessEnv;
  }) => Effect.Effect<SandboxGitConfigProbeResult, E>;
}): Effect.fn.Return<NodeJS.ProcessEnv, SandboxGitConfigError> {
  const parsed = parseGitGlobalOptions(input.args);
  const envGitDir = input.env.GIT_DIR?.trim();
  const hasExplicitGitLocation =
    parsed.locationArgs.length > 0 || (envGitDir !== undefined && envGitDir.length > 0);
  const shouldProbe =
    hasExplicitGitLocation ||
    (input.cwd !== undefined && input.cwd.trim().length > 0 && hasEnclosingGitMarker(input.cwd));

  let dynamicOverrides: ReadonlyArray<readonly [string, string]> = [];
  let disableGitProxyEnv = false;
  if (shouldProbe) {
    const probeArgs = [
      ...parsed.locationArgs,
      "-c",
      "safe.directory=*",
      "config",
      "--show-scope",
      "--includes",
      "--null",
      "--get-regexp",
      SANDBOX_GIT_DANGEROUS_KEY_REGEX,
    ];
    // Preserve global/system/env config so `includeIf "hasconfig:..."` matches execution 1:1.
    const probeEnv: NodeJS.ProcessEnv = {
      ...input.env,
      GIT_OPTIONAL_LOCKS: "0",
    };
    const probeResult = yield* input
      .runProbe({
        args: probeArgs,
        cwd: input.cwd,
        env: probeEnv,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SandboxGitConfigError({
              detail: "Refused host Git execution because sandbox Git config inspection failed.",
              cause,
            }),
        ),
      );
    if (probeResult.timedOut || probeResult.stdoutTruncated) {
      return yield* new SandboxGitConfigError({
        detail:
          "Refused host Git execution because sandbox Git config inspection timed out or exceeded output limits.",
      });
    }
    if (probeResult.exitCode === 0) {
      const parsedProbe = yield* parseScopedGitConfigProbeOutput(
        probeResult.stdout,
        input.allowWorkspaceIncludes,
        { preserveHooksConfig: input.preserveHooksConfig === true },
      );
      dynamicOverrides = parsedProbe.configOverrides;
      disableGitProxyEnv = parsedProbe.disableGitProxyEnv;
    } else if (probeResult.exitCode !== 1) {
      return yield* new SandboxGitConfigError({
        detail: `Refused host Git execution because sandbox Git config inspection exited with code ${String(probeResult.exitCode)}.`,
      });
    }
  }

  const fixedOverrides =
    input.preserveHooksConfig === true
      ? SANDBOX_SAFE_FIXED_GIT_CONFIG.filter(([key]) => key !== "core.hooksPath")
      : SANDBOX_SAFE_FIXED_GIT_CONFIG;
  const added: NodeJS.ProcessEnv = {};
  for (const [key, value] of [...fixedOverrides, ...dynamicOverrides]) {
    Object.assign(added, gitConfigEnv({ ...input.env, ...added }, key, value, input.platform));
  }
  if (disableGitProxyEnv) {
    // core.gitProxy is first-match multi-valued; GIT_PROXY_COMMAND overrides all entries.
    added.GIT_PROXY_COMMAND = "false";
  }
  return added;
});

const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

/**
 * Unsets repository selectors the server inherited, such as a Git hook's `GIT_DIR`, so Git finds
 * the repository from cwd. Spread it before a command's own env, which may still set them.
 */
export const unsetInheritedRepositoryEnv = (
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.keys(inherited)
      .filter((name) => REPOSITORY_SELECTORS.has(platform === "win32" ? name.toUpperCase() : name))
      .map((name) => [name, undefined]),
  );

const classifyNonZeroExit = (
  stderr: string,
  classifyFailure: VcsProcessInput["classifyFailure"],
): VcsProcessExitFailureKind => {
  const normalized = stderr.toLowerCase();
  const commandKind = classifyFailure?.(stderr) ?? null;

  if (
    commandKind === "authentication" ||
    normalized.includes("authentication failed") ||
    normalized.includes("not logged in") ||
    normalized.includes("no oauth token") ||
    normalized.includes("unauthorized")
  ) {
    return "authentication";
  }

  if (
    commandKind === "rate-limited" ||
    normalized.includes("api rate limit") ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429")
  ) {
    return "rate-limited";
  }

  return commandKind ?? "command-failed";
};

// Classify before discarding stderr; keep paths and process output out of errors.
const isTransientGitExit = (stderr: string) =>
  /unable to create [^\n]*\.lock['"]?: file exists/i.test(stderr) ||
  /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(stderr);

// On macOS, Git's fsync uses F_FULLFSYNC; writeout-only still uses fsync(2).
// Network mounts can reject F_FULLFSYNC. Ref writes omit errno, so retry their
// bare write error too; explicit unrelated errors remain failures.
// Linux writeout-only only starts writeback, so it must not use this fallback.
const FULL_FSYNC_ARG = "core.fsyncMethod=fsync";
const BATCH_FSYNC_ARG = "core.fsyncMethod=batch";
const WRITEOUT_ONLY_FSYNC_ARG = "core.fsyncMethod=writeout-only";
const canRetryFullFsync = (stderr: string) =>
  /fsync error on [^\r\n]+: operation not supported\r?$/im.test(stderr) ||
  /cannot update ref [^\r\n]+: couldn't write '[^\r\n]+\.lock'\r?$/im.test(stderr);

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcess.Platform;
  const processSandbox = yield* ProcessSandbox;
  const serverConfigOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const teamBwrapSandbox =
    Option.isSome(serverConfigOption) && serverConfigOption.value.teamBwrapSandbox === true;
  const ownStateDir = Option.isSome(serverConfigOption)
    ? serverConfigOption.value.stateDir
    : undefined;
  const vcsProcesses = yield* Semaphore.make(VCS_PROCESS_CONCURRENCY);
  const nonGitProcesses = yield* Semaphore.make(NON_GIT_PROCESS_CONCURRENCY);
  const backgroundProcesses = yield* Semaphore.make(NON_GIT_PROCESS_CONCURRENCY - 1);
  const keyedProcesses = new Map<string, Semaphore.Semaphore>();
  const keyedPermit = (concurrency: NonNullable<VcsProcessInput["concurrency"]>) => {
    let semaphore = keyedProcesses.get(concurrency.key);
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(concurrency.limit);
      keyedProcesses.set(concurrency.key, semaphore);
    }
    return semaphore.withPermits(1);
  };

  const spawn = Effect.fn("VcsProcess.spawn")(function* (
    input: VcsProcessInput,
    baseError: VcsProcessErrorContext,
  ) {
    let failedExit = false;
    const baseEnv: NodeJS.ProcessEnv = {
      ...(input.command === "git" ? unsetInheritedRepositoryEnv(process.env, hostPlatform) : {}),
      // Failures are read by English patterns; without LANG, macOS Git follows the system language.
      // LANGUAGE leaves LC_CTYPE, which hooks inherit, alone.
      ...(input.command === "git" ? { LANGUAGE: "C" } : {}),
      ...input.env,
    };
    const withServerGitConfig: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...serverGitConfigEnv({ ...process.env, ...baseEnv }, hostPlatform),
    };
    let finalEnv: NodeJS.ProcessEnv = withServerGitConfig;
    let launchCommand = input.command;
    let launchArgs = input.args;
    let extendEnvOption: boolean | undefined;

    if (input.command === "git" && teamBwrapSandbox) {
      const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...withServerGitConfig };
      const sandboxCheck = canRunHostGitInWorkspaceSandbox({
        processSandboxEnabled: processSandbox.enabled,
        cwd: input.cwd,
        args: input.args,
        env: mergedEnv,
        ownStateDir,
      });
      const safeOverrides = yield* resolveSandboxSafeGitConfigEnv({
        cwd: input.cwd,
        env: mergedEnv,
        platform: hostPlatform,
        args: input.args,
        allowWorkspaceIncludes: sandboxCheck.eligible,
        runProbe: ({ args: probeArgs, cwd: probeCwd, env: probeEnv }) =>
          processRunner
            .run({
              command: "git",
              args: probeArgs,
              ...(probeCwd !== undefined ? { cwd: probeCwd } : {}),
              env: probeEnv,
              timeout: 5_000,
              maxOutputBytes: 4 * 1024 * 1024,
              outputMode: "truncate",
              timeoutBehavior: "timedOutResult",
            })
            .pipe(
              Effect.map((res) => ({
                exitCode: res.code === null ? null : Number(res.code),
                stdout: res.stdout,
                timedOut: res.timedOut,
                stdoutTruncated: res.stdoutTruncated,
              })),
            ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessSpawnError({
              ...baseError,
              cause,
            }),
        ),
      );
      finalEnv = { ...withServerGitConfig, ...safeOverrides };
      if (sandboxCheck.eligible) {
        const wrapped = yield* processSandbox
          .wrap({
            command: "git",
            args: sandboxCheck.sandboxArgs,
            cwd: sandboxCheck.sandboxCwd,
            chdir: sandboxCheck.sandboxChdir,
            env: { ...process.env, ...finalEnv },
            ...(sandboxCheck.extraRwBinds.length > 0
              ? { extraRwBinds: sandboxCheck.extraRwBinds }
              : {}),
            ...(sandboxCheck.extraRoBinds.length > 0
              ? { extraRoBinds: sandboxCheck.extraRoBinds }
              : {}),
            name: "git",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new VcsProcessSpawnError({
                  ...baseError,
                  cause,
                }),
            ),
          );
        launchCommand = wrapped.command;
        launchArgs = wrapped.args;
        finalEnv = wrapped.hostEnv ?? {};
        // Prevent ProcessRunner from re-merging raw process.env (LD_*, GIT_DIR) onto host bwrap.
        extendEnvOption = false;
      }
    }

    const execution = processRunner
      .run({
        command: launchCommand,
        args: launchArgs,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
        ...(input.onSpawn !== undefined ? { onSpawn: input.onSpawn } : {}),
        env: finalEnv,
        ...(extendEnvOption === undefined ? {} : { extendEnv: extendEnvOption }),
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: input.outputMode ?? "truncate",
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.tap((result) => {
          failedExit = result.code === null || (!input.allowNonZeroExit && result.code !== 0);
          return Effect.void;
        }),
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) =>
              VcsProcessSpawnError.fromProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              new VcsProcessOutputLimitError({
                ...baseError,
                stream: error.stream,
                maxBytes: error.maxBytes,
                observedBytes: error.observedBytes,
              }),
            ProcessTimeoutError: (error) =>
              VcsProcessTimeoutError.fromProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              new VcsProcessStdinWriteError({
                ...baseError,
                stdinBytes: error.stdinBytes,
                cause: error.cause,
              }),
            ProcessReadError: (error) =>
              new VcsProcessOutputReadError({
                ...baseError,
                stream: error.stream,
                cause: error.cause,
              }),
          }),
        ),
      );

    return yield* input.command === "git"
      ? execution.pipe(
          withMetrics({
            counter: gitCommandsTotal,
            timer: gitCommandDuration,
            attributes: {
              operation: gitMetricOperations.has(input.operation) ? input.operation : "other",
            },
            outcomeAttributes: (outcome) => ({
              outcome: outcome === "success" && failedExit ? "failure" : outcome,
            }),
          }),
        )
      : execution;
  });

  const runUnbounded = Effect.fn("VcsProcess.runUnbounded")(function* (input: VcsProcessInput) {
    const baseError = {
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
    };

    let result = yield* spawn(input, baseError);

    if (
      hostPlatform === "darwin" &&
      input.operation === CHECKPOINT_CAPTURE_OPERATION &&
      !input.allowNonZeroExit &&
      result.code !== null &&
      result.code !== 0 &&
      input.command === "git" &&
      (input.args.includes(FULL_FSYNC_ARG) || input.args.includes(BATCH_FSYNC_ARG)) &&
      canRetryFullFsync(result.stderr)
    ) {
      result = yield* spawn(
        {
          ...input,
          args: input.args.map((arg) =>
            arg === FULL_FSYNC_ARG || arg === BATCH_FSYNC_ARG ? WRITEOUT_ONLY_FSYNC_ARG : arg,
          ),
        },
        baseError,
      );
    }

    if (result.code === null) {
      return yield* new VcsProcessMissingExitCodeError(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      const failureKind = classifyNonZeroExit(result.stderr, input.classifyFailure);
      const error = VcsProcessExitError.fromProcessExit(
        baseError,
        {
          exitCode: result.code,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        },
        failureKind,
        {
          retryable:
            input.command === "git" &&
            failureKind === "command-failed" &&
            isTransientGitExit(result.stderr),
          ...(input.notFoundDetail === undefined ? {} : { notFoundDetail: input.notFoundDetail }),
        },
      );
      if (
        input.command === "git" &&
        /^fatal: unable to create ['"][^\r\n]*[/\\]index\.lock['"]: file exists\.?$/im.test(
          result.stderr,
        )
      ) {
        return yield* new VcsProcessExitError({
          ...error,
          detail: GIT_INDEX_LOCKED_DETAIL,
        });
      }
      return yield* error;
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutInvalidUtf8: result.stdoutInvalidUtf8 ?? false,
      stderrInvalidUtf8: result.stderrInvalidUtf8 ?? false,
    } satisfies VcsProcessOutput;
  });

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const bounded = vcsProcesses.withPermits(1)(runUnbounded(input));
    if (
      input.command === "git" &&
      input.operation === CHECKPOINT_CAPTURE_OPERATION &&
      input.onStdoutChunk === undefined
    ) {
      return yield* bounded.pipe(
        Effect.tapError((error) =>
          Effect.logDebug("checkpoint Git command failed", {
            operation: input.operation,
            errorTag: error._tag,
          }),
        ),
        Effect.retry({
          times: 2,
          while: (error) => error._tag === "VcsProcessExitError" && error.retryable === true,
          schedule: Schedule.spaced(Duration.millis(75)),
        }),
      );
    }
    const shared = input.command === "git" ? bounded : nonGitProcesses.withPermits(1)(bounded);
    const keyed = input.concurrency === undefined ? shared : keyedPermit(input.concurrency)(shared);
    // Taken first, so a background call still waiting holds no permit another call needs.
    return yield* input.command !== "git" && (yield* Background)
      ? backgroundProcesses.withPermits(1)(keyed)
      : keyed;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make).pipe(Layer.provide(ProcessRunner.layer));
