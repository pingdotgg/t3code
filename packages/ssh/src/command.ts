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
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as SshAuth from "./auth.ts";
import {
  SshAuthenticationHelperError,
  type SshCommandError,
  SshCommandExecutionError,
  SshCommandExitError,
  SshCommandSpawnError,
  SshCommandTimeoutError,
  SshHostAliasRequiredError,
  type SshInvalidTargetError,
  SshTargetDestinationMissingError,
} from "./errors.ts";

const PUBLISHABLE_T3_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 60_000;

/**
 * ssh is a real executable everywhere (`ssh.exe` on Windows), so it is always
 * spawned directly — cmd.exe shell mode would re-tokenize arguments such as
 * identity-file paths containing spaces.
 */
const sshCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "ssh.exe" : "ssh";

export const resolveSshCommand = Effect.map(HostProcessPlatform, sshCommandForPlatform);

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunSshCommandOptions extends SshAuth.SshAuthOptions {
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

export function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

export function remoteStateKey(target: DesktopSshEnvironmentTarget): string {
  return NodeCrypto.createHash("sha256")
    .update(targetConnectionKey(target))
    .digest("hex")
    .slice(0, 16);
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
    catch: () =>
      new SshTargetDestinationMissingError({
        alias: target.alias,
        hostname: target.hostname,
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
  const environment = yield* SshAuth.buildSshChildEnvironment({
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshAuthenticationHelperError({
          command: "ssh",
          argumentCount: 0,
          exitCode: null,
          stderrBytes: 0,
          target: hostSpec,
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
    command: sshCommand,
    argumentCount: args.length,
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
          new SshCommandSpawnError({
            command: sshCommand,
            argumentCount: args.length,
            exitCode: null,
            stderrBytes: 0,
            target: hostSpec,
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
        new SshCommandExecutionError({
          command: sshCommand,
          argumentCount: args.length,
          exitCode: null,
          stderrBytes: 0,
          target: hostSpec,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: sshCommand,
      argumentCount: args.length,
      exitCode,
      stdoutBytes: utf8ByteLength(stdout),
      stderrBytes: utf8ByteLength(stderr),
    });
    return yield* new SshCommandExitError({
      command: sshCommand,
      argumentCount: args.length,
      exitCode,
      stdoutBytes: utf8ByteLength(stdout),
      stderrBytes: utf8ByteLength(stderr),
      target: hostSpec,
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: sshCommand,
    argumentCount: args.length,
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
              argumentCount:
                baseSshArgs(target).length +
                (input.preHostArgs?.length ?? 0) +
                1 +
                (input.remoteCommandArgs?.length ?? 0),
              hasStdin: input.stdin !== undefined,
            });
            return yield* new SshCommandTimeoutError({
              command: "ssh",
              argumentCount:
                baseSshArgs(target).length +
                (input.preHostArgs?.length ?? 0) +
                1 +
                (input.remoteCommandArgs?.length ?? 0),
              exitCode: null,
              stderrBytes: 0,
              target: target.alias || target.hostname,
              timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
            });
          }),
      }),
    ),
  );
});

export const resolveSshTarget = Effect.fn("ssh/command.resolveSshTarget")(function* (
  alias: string,
): Effect.fn.Return<
  DesktopSshEnvironmentTarget,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const trimmedAlias = alias.trim();
  if (trimmedAlias.length === 0) {
    return yield* new SshHostAliasRequiredError({ alias });
  }

  yield* Effect.logDebug("ssh.target.resolve.start", { alias: trimmedAlias });
  return yield* runSshCommand(
    {
      alias: trimmedAlias,
      hostname: trimmedAlias,
      username: null,
      port: null,
    },
    { preHostArgs: ["-G"] },
  ).pipe(
    Effect.map((result) => parseSshResolveOutput(trimmedAlias, result.stdout)),
    Effect.tap((target) =>
      Effect.logDebug("ssh.target.resolve.succeeded", sshTargetLogFields(target)),
    ),
    Effect.catch((cause) =>
      Effect.logDebug("ssh.target.resolve.fallback", {
        alias: trimmedAlias,
        failureTag: cause._tag,
      }).pipe(
        Effect.as({
          alias: trimmedAlias,
          hostname: trimmedAlias,
          username: null,
          port: null,
        }),
      ),
    ),
  );
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
