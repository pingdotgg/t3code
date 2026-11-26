// @effect-diagnostics nodeBuiltinImport:off -- Uses git config --includes --list via execFileSync to inspect local repo configs without hand-rolling INI parsing.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
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
  ["core.alternateRefsCommand", ""],
  ["uploadpack.packObjectsHook", ""],
  ["gpg.program", "false"],
  ["gpg.openpgp.program", "false"],
  ["gpg.ssh.program", "false"],
  ["gpg.x509.program", "false"],
  ["gpg.ssh.defaultKeyCommand", ""],
] as const;

function extractGitLocationArgs(args: ReadonlyArray<string> | undefined): {
  readonly gitDirArg?: string | undefined;
  readonly chdirArgs: ReadonlyArray<string>;
} {
  if (args === undefined || args.length === 0) {
    return { chdirArgs: [] };
  }
  const chdirArgs: Array<string> = [];
  let gitDirArg: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-C" && i + 1 < args.length) {
      chdirArgs.push("-C", args[i + 1]!);
      i += 1;
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      chdirArgs.push(arg);
      continue;
    }
    if (arg === "--git-dir" && i + 1 < args.length) {
      gitDirArg = args[i + 1]!;
      i += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=")) {
      gitDirArg = arg.slice("--git-dir=".length);
      continue;
    }
    // Stop scanning global git options once the subcommand token is reached.
    if (!arg.startsWith("-")) break;
  }
  return { gitDirArg, chdirArgs };
}

function hasEnclosingGitMarker(cwd: string): boolean {
  let cursor = NodePath.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (NodeFS.existsSync(NodePath.join(cursor, ".git"))) return true;
    const parent = NodePath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

/**
 * Queries Git's own config parser (`git config --includes --name-only --null --list` with system
 * and global configs disabled) so comment padding, line continuations, single-line `[sec] k=v`,
 * `config.worktree`, and arbitrary `[include]`/`[includeIf]` chains cannot bypass neutralization.
 */
function discoverUntrustedRepoGitOverrides(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  args: ReadonlyArray<string> | undefined,
): ReadonlyArray<readonly [string, string]> {
  const { gitDirArg, chdirArgs } = extractGitLocationArgs(args);
  const envGitDir = env.GIT_DIR?.trim();
  const effectiveGitDir =
    gitDirArg !== undefined && gitDirArg.length > 0
      ? gitDirArg
      : envGitDir !== undefined && envGitDir.length > 0
        ? envGitDir
        : undefined;

  if (effectiveGitDir === undefined && chdirArgs.length === 0) {
    if (cwd === undefined || cwd.trim().length === 0 || !hasEnclosingGitMarker(cwd)) {
      return [];
    }
  }

  const probeArgs = [
    ...chdirArgs,
    ...(effectiveGitDir !== undefined ? [`--git-dir=${effectiveGitDir}`] : []),
    "config",
    "--includes",
    "--name-only",
    "--null",
    "--list",
  ];

  const probeEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? process.env.PATH,
    HOME: env.HOME ?? process.env.HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };

  let stdout: string;
  try {
    stdout = NodeChildProcess.execFileSync("git", probeArgs, {
      ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
      env: probeEnv,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  const filters = new Set<string>();
  const diffs = new Set<string>();
  const merges = new Set<string>();
  const credentialKeys = new Set<string>();
  const remoteUploadPacks = new Set<string>();
  const remoteReceivePacks = new Set<string>();
  const remoteProxies = new Set<string>();
  const diffToolCmds = new Set<string>();
  const mergeToolCmds = new Set<string>();
  const gpgKeys = new Set<string>();
  let hasSshCommand = false;

  for (const rawKey of stdout.split("\0")) {
    if (rawKey.length === 0) continue;
    const firstDot = rawKey.indexOf(".");
    const lastDot = rawKey.lastIndexOf(".");
    if (firstDot <= 0 || lastDot <= firstDot) {
      if (rawKey === "core.sshcommand") {
        hasSshCommand = true;
      } else if (rawKey === "credential.helper") {
        credentialKeys.add("credential.helper");
      } else if (rawKey === "gpg.program") {
        gpgKeys.add("gpg.program");
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
    } else if (section === "gpg" && (variable === "program" || variable === "defaultkeycommand")) {
      gpgKeys.add(`gpg.${subsection}.${variable}`);
    }
  }

  const overrides: Array<readonly [string, string]> = [];
  for (const name of filters) {
    overrides.push(
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
    );
  }
  for (const name of diffs) {
    overrides.push([`diff.${name}.textconv`, ""], [`diff.${name}.command`, ""]);
  }
  for (const name of merges) {
    overrides.push([`merge.${name}.driver`, ""]);
  }
  for (const key of credentialKeys) {
    overrides.push([key, ""]);
  }
  for (const name of remoteUploadPacks) {
    overrides.push([`remote.${name}.uploadpack`, "git-upload-pack"]);
  }
  for (const name of remoteReceivePacks) {
    overrides.push([`remote.${name}.receivepack`, "git-receive-pack"]);
  }
  for (const name of remoteProxies) {
    overrides.push([`remote.${name}.proxy`, ""]);
  }
  for (const name of diffToolCmds) {
    overrides.push([`difftool.${name}.cmd`, ""]);
  }
  for (const name of mergeToolCmds) {
    overrides.push([`mergetool.${name}.cmd`, ""]);
  }
  for (const key of gpgKeys) {
    overrides.push([key, "false"]);
  }
  if (hasSshCommand) {
    overrides.push(["core.sshCommand", "false"]);
  }
  return overrides;
}

/**
 * Neutralizes repo-local executable Git config vectors (hooks, fsmonitor, clean/smudge/process
 * filters, diff/merge drivers, ext::, sshCommand, credential helpers, remote/gpg exec keys).
 */
export const sandboxSafeGitConfigEnv = (
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  args?: ReadonlyArray<string>,
): NodeJS.ProcessEnv => {
  const added: NodeJS.ProcessEnv = {};
  for (const [key, value] of [
    ...SANDBOX_SAFE_FIXED_GIT_CONFIG,
    ...discoverUntrustedRepoGitOverrides(cwd, env, args),
  ]) {
    Object.assign(added, gitConfigEnv({ ...env, ...added }, key, value, platform));
  }
  return added;
};

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
  const serverConfigOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const teamBwrapSandbox =
    Option.isSome(serverConfigOption) && serverConfigOption.value.teamBwrapSandbox === true;
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
    const execution = processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
        ...(input.onSpawn !== undefined ? { onSpawn: input.onSpawn } : {}),
        env: (() => {
          const baseEnv: NodeJS.ProcessEnv = {
            ...(input.command === "git"
              ? unsetInheritedRepositoryEnv(process.env, hostPlatform)
              : {}),
            // Failures are read by English patterns; without LANG, macOS Git follows the system language.
            // LANGUAGE leaves LC_CTYPE, which hooks inherit, alone.
            ...(input.command === "git" ? { LANGUAGE: "C" } : {}),
            ...input.env,
          };
          const withServerGitConfig: NodeJS.ProcessEnv = {
            ...baseEnv,
            ...serverGitConfigEnv({ ...process.env, ...baseEnv }, hostPlatform),
          };
          return input.command === "git" && teamBwrapSandbox
            ? {
                ...withServerGitConfig,
                ...sandboxSafeGitConfigEnv(
                  input.cwd,
                  { ...process.env, ...withServerGitConfig },
                  hostPlatform,
                  input.args,
                ),
              }
            : withServerGitConfig;
        })(),
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
