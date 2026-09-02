import * as NodeCrypto from "node:crypto";

import type { DesktopSshEnvironmentTarget, DesktopUpdateChannel } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";

const PUBLISHABLE_T3_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 60_000;
const MAX_SSH_ERROR_OUTPUT_LENGTH = 4_000;

/**
 * ssh is a real executable everywhere (`ssh.exe` on Windows), so it is always
 * spawned directly — cmd.exe shell mode would re-tokenize arguments such as
 * identity-file paths containing spaces.
 */
const sshCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "ssh.exe" : "ssh";

export const resolveSshCommand = Effect.map(HostProcessPlatform, sshCommandForPlatform);

const encoder = new TextEncoder();

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunSshCommandOptions extends SshAuthOptions {
  readonly preHostArgs?: ReadonlyArray<string>;
  readonly remoteCommandArgs?: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export function parseSshResolveOutput(alias: string, stdout: string): DesktopSshEnvironmentTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/u);
    if (!key || rest.length === 0 || values.has(key)) {
      continue;
    }
    values.set(key, rest.join(" ").trim());
  }

  const hostname = values.get("hostname")?.trim() || alias;
  const username = values.get("user")?.trim() || null;
  const rawPort = values.get("port")?.trim() ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    alias,
    hostname,
    username,
    port: Number.isInteger(parsedPort) ? parsedPort : null,
  };
}

export function parseSshSendEnvironmentPatterns(stdout: string): ReadonlyArray<string> {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("sendenv ")) {
      return [];
    }
    return trimmed.slice("sendenv ".length).trim().split(/\s+/u).filter(Boolean);
  });
}

function sshEnvironmentNameMatchesPattern(name: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, "u").test(name);
}

export function isSshEnvironmentNameConfiguredForSend(
  name: string,
  patterns: ReadonlyArray<string>,
): boolean {
  let configured = false;
  for (const rawPattern of patterns) {
    const removesPattern = rawPattern.startsWith("-");
    const pattern = removesPattern ? rawPattern.slice(1) : rawPattern;
    if (pattern.length > 0 && sshEnvironmentNameMatchesPattern(name, pattern)) {
      configured = !removesPattern;
    }
  }
  return configured;
}

function unsupportedSshEnvironmentNames(
  environmentVariables: NonNullable<DesktopSshEnvironmentTarget["environmentVariables"]>,
  resolvedConfigOutput: string,
): ReadonlyArray<string> {
  const patterns = parseSshSendEnvironmentPatterns(resolvedConfigOutput);
  return Object.keys(environmentVariables).filter(
    (name) => !isSshEnvironmentNameConfiguredForSend(name, patterns),
  );
}

export function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

export function sshEnvironmentVariablesEqual(
  left: DesktopSshEnvironmentTarget["environmentVariables"],
  right: DesktopSshEnvironmentTarget["environmentVariables"],
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEnvironment = right ?? {};
  return (
    leftEntries.length === Object.keys(rightEnvironment).length &&
    leftEntries.every(
      ([name, value]) => Object.hasOwn(rightEnvironment, name) && rightEnvironment[name] === value,
    )
  );
}

export function remoteStateKey(target: DesktopSshEnvironmentTarget): string {
  return NodeCrypto.createHash("sha256")
    .update(targetConnectionKey(target))
    .digest("hex")
    .slice(0, 16);
}

export function managedRemoteLaunchCommandArgs(
  target: DesktopSshEnvironmentTarget,
): ReadonlyArray<string> {
  return ["sh", "-l", "-s", "--", remoteStateKey(target)];
}

export function buildSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  if (destination.length === 0) {
    throw new Error("SSH target is missing its alias/hostname.");
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

export const buildSshHostSpecEffect = (
  target: DesktopSshEnvironmentTarget,
): Effect.Effect<string, SshInvalidTargetError> =>
  Effect.try({
    try: () => buildSshHostSpec(target),
    catch: (cause) =>
      new SshInvalidTargetError({
        message: cause instanceof Error ? cause.message : "SSH target is invalid.",
      }),
  });

export function baseSshArgs(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly batchMode?: "yes" | "no" },
): string[] {
  return [
    "-o",
    `BatchMode=${input?.batchMode ?? "no"}`,
    "-o",
    "ConnectTimeout=10",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
  ];
}

export function getLastNonEmptyOutputLine(stdout: string): string | null {
  return (
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .findLast((entry) => entry.length > 0) ?? null
  );
}

export const collectProcessOutput = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

export function redactSshOutput(
  output: string,
  environmentVariables?: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = output.replace(
    /("(?:access_token|bearerToken|credential|pairingToken|token)"\s*:\s*")[^"]+(")/giu,
    "$1[redacted]$2",
  );
  const environmentValues = [
    ...new Set(
      Object.values(environmentVariables ?? {}).filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
    ),
  ].sort((left, right) => right.length - left.length);
  for (const value of environmentValues) {
    redacted = redacted.replaceAll(value, "[redacted]");
  }
  return redacted.length > MAX_SSH_ERROR_OUTPUT_LENGTH
    ? `${redacted.slice(0, MAX_SSH_ERROR_OUTPUT_LENGTH)}\n[truncated]`
    : redacted;
}

function normalizeSshErrorMessage(input: {
  readonly stdout?: string;
  readonly stderr: string;
  readonly fallbackMessage: string;
}): string {
  const cleanedStderr = input.stderr.trim();
  if (cleanedStderr.length > 0) {
    return cleanedStderr;
  }

  const cleanedStdout = input.stdout?.trim() ?? "";
  return cleanedStdout.length > 0 ? cleanedStdout : input.fallbackMessage;
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function stdinStream(input: string | undefined) {
  return input === undefined ? Stream.empty : Stream.make(encoder.encode(input));
}

const runSshCommandInScope = Effect.fn("ssh/command.runSshCommand.inScope")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions,
  commandScope: Scope.Scope,
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const hostSpec = yield* buildSshHostSpecEffect(target);
  const environment = yield* buildSshChildEnvironment({
    ...(target.environmentVariables === undefined ? {} : { baseEnv: target.environmentVariables }),
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(target, {
      batchMode: input.batchMode ?? (input.interactiveAuth ? "no" : "yes"),
    }),
    ...(input.preHostArgs ?? []),
    hostSpec,
    ...(input.remoteCommandArgs ?? []),
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sshCommand = yield* resolveSshCommand;
  yield* Effect.logDebug("ssh.command.start", {
    ...sshTargetLogFields(target),
    command: [sshCommand, ...args],
    hasStdin: input.stdin !== undefined,
    timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: environment,
        extendEnv: true,
        stdin: {
          stream: stdinStream(input.stdin),
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, commandScope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: [sshCommand, ...args],
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH command for ${hostSpec}.`,
            cause,
          }),
      ),
    );

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectProcessOutput(child.stdout),
      collectProcessOutput(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error ? cause.message : `Failed to run SSH command for ${hostSpec}.`,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    const diagnosticStdout = redactSshOutput(stdout, target.environmentVariables);
    const diagnosticStderr = redactSshOutput(stderr, target.environmentVariables);
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
    });
    return yield* new SshCommandError({
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
      message: normalizeSshErrorMessage({
        stdout: diagnosticStdout,
        stderr: diagnosticStderr,
        fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,
      }),
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: ["ssh", ...args],
  });
  return { stdout, stderr };
});

export const runSshCommand = Effect.fn("ssh/command.runSshCommand")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions = {},
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return yield* Effect.scopedWith((commandScope) =>
    runSshCommandInScope(target, input, commandScope),
  ).pipe(
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS)),
    Effect.flatMap((result) =>
      Option.match(result, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ssh.command.timedOut", {
              ...sshTargetLogFields(target),
              timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
              remoteCommandArgs: input.remoteCommandArgs ?? [],
              preHostArgs: input.preHostArgs ?? [],
              hasStdin: input.stdin !== undefined,
            });
            return yield* new SshCommandError({
              command: ["ssh"],
              exitCode: null,
              stderr: "",
              message: `SSH command timed out after ${input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS}ms.`,
            });
          }),
      }),
    ),
  );
});

export const resolveSshTarget = Effect.fn("ssh/command.resolveSshTarget")(function* (
  alias: string,
  environmentVariables?: DesktopSshEnvironmentTarget["environmentVariables"],
  overrides?: Pick<DesktopSshEnvironmentTarget, "username" | "port">,
): Effect.fn.Return<
  DesktopSshEnvironmentTarget,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const trimmedAlias = alias.trim();
  if (trimmedAlias.length === 0) {
    return yield* new SshInvalidTargetError({ message: "SSH host alias is required." });
  }

  yield* Effect.logDebug("ssh.target.resolve.start", { alias: trimmedAlias });
  const unresolvedTarget: DesktopSshEnvironmentTarget = {
    alias: trimmedAlias,
    hostname: trimmedAlias,
    username: overrides?.username ?? null,
    port: overrides?.port ?? null,
  };
  const identityResult = yield* runSshCommand(unresolvedTarget, { preHostArgs: ["-G"] }).pipe(
    Effect.catch((cause) =>
      environmentVariables === undefined
        ? Effect.logDebug("ssh.target.resolve.fallback", { alias: trimmedAlias, cause }).pipe(
            Effect.as(null),
          )
        : Effect.fail(cause),
    ),
  );
  if (identityResult === null) {
    return unresolvedTarget;
  }

  const identityTarget = parseSshResolveOutput(trimmedAlias, identityResult.stdout);
  const managedRemoteCommand = managedRemoteLaunchCommandArgs(identityTarget);
  const resolvedResult =
    environmentVariables === undefined
      ? identityResult
      : yield* Effect.gen(function* () {
          const baselineResult = yield* runSshCommand(unresolvedTarget, {
            preHostArgs: ["-G"],
            remoteCommandArgs: managedRemoteCommand,
          });
          const unsupportedBaselineNames = unsupportedSshEnvironmentNames(
            environmentVariables,
            baselineResult.stdout,
          );
          if (unsupportedBaselineNames.length > 0) {
            return yield* new SshInvalidTargetError({
              message: `Add ${unsupportedBaselineNames.join(", ")} to SendEnv for ${trimmedAlias} in your SSH config before forwarding ${unsupportedBaselineNames.length === 1 ? "it" : "them"}.`,
            });
          }

          return yield* runSshCommand(
            { ...unresolvedTarget, environmentVariables },
            { preHostArgs: ["-G"], remoteCommandArgs: managedRemoteCommand },
          );
        });

  if (environmentVariables !== undefined) {
    const unsupportedNames = unsupportedSshEnvironmentNames(
      environmentVariables,
      resolvedResult.stdout,
    );
    if (unsupportedNames.length > 0) {
      return yield* new SshInvalidTargetError({
        message: `SendEnv for ${trimmedAlias} no longer selects ${unsupportedNames.join(", ")} after applying the saved local SSH environment.`,
      });
    }
  }
  const resolvedTarget = {
    ...parseSshResolveOutput(trimmedAlias, resolvedResult.stdout),
    ...(environmentVariables === undefined ? {} : { environmentVariables }),
  };
  yield* Effect.logDebug("ssh.target.resolve.succeeded", sshTargetLogFields(resolvedTarget));
  return resolvedTarget;
});

export function resolveRemoteT3CliPackageSpec(input: {
  readonly appVersion: string;
  readonly updateChannel: DesktopUpdateChannel;
  readonly isDevelopment?: boolean;
}): string {
  const appVersion = input.appVersion.trim();
  if (!input.isDevelopment && PUBLISHABLE_T3_VERSION_PATTERN.test(appVersion)) {
    return `t3@${appVersion}`;
  }

  if (input.isDevelopment) {
    return "t3@nightly";
  }

  return input.updateChannel === "nightly" ? "t3@nightly" : "t3@latest";
}
