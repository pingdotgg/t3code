/**
 * ClaudeRemoteControlLauncher — launches the real `claude` CLI in Remote
 * Control mode using a T3-selected Claude account/HOME.
 *
 * Context: T3 drives Claude through the Agent SDK `query()`, which CANNOT do
 * Remote Control. The official "Remote Control" feature is CLI-only:
 *   - server / background mode:  `claude remote-control [...]`
 *   - interactive mode:          `claude --remote-control [...]`  (alias `--rc`)
 *   - in-session:                `/remote-control`
 * It requires a claude.ai OAuth login (Pro/Max/Team/Enterprise) — NOT an API
 * key. The local `claude` process registers with the Anthropic API over
 * outbound HTTPS and Anthropic relays to the Claude mobile/web app. This module
 * therefore only LAUNCHES the real `claude` binary in RC mode; it builds no
 * relay (Anthropic provides it).
 *
 * HOME/account resolution is NOT reimplemented here: we reuse
 * `makeClaudeEnvironment` from `provider/Drivers/ClaudeHome.ts` so a T3 Claude
 * instance's `homePath` produces the same isolated `HOME` (separate
 * `.claude.json` / `.claude`) used everywhere else.
 *
 * Stdio is inherited so the pairing/registration output produced by `claude`
 * is visible directly to the user running `t3 remote-control`.
 *
 * @module remoteControl/ClaudeRemoteControlLauncher
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import {
  type ClaudeRemoteControlError,
  ClaudeRemoteControlExitError,
  ClaudeRemoteControlLaunchError,
} from "./Errors.ts";

export type { ClaudeRemoteControlError } from "./Errors.ts";

/**
 * Remote Control launch mode.
 *
 * - `server`: background/server registration (`claude remote-control`).
 * - `interactive`: attached interactive session (`claude --remote-control`).
 */
export type RemoteControlMode = "server" | "interactive";

export const DEFAULT_REMOTE_CONTROL_MODE: RemoteControlMode = "server";

/**
 * Structural subset of `ClaudeSettings` the launcher needs. A full
 * `ClaudeSettings` satisfies this, so callers can pass an instance's config
 * directly while keeping the launcher decoupled from the full schema.
 */
export type ClaudeRemoteControlSettings = Pick<ClaudeSettings, "binaryPath" | "homePath">;

export interface RemoteControlArgsInput {
  readonly mode: RemoteControlMode;
  readonly name?: string | undefined;
  readonly passthrough?: ReadonlyArray<string> | undefined;
}

export interface RemoteControlLaunchOptions {
  readonly mode: RemoteControlMode;
  readonly name?: string | undefined;
  readonly passthrough?: ReadonlyArray<string> | undefined;
  readonly cwd?: string | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
}

export interface ResolvedRemoteControlLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

/**
 * Build the argv passed to the `claude` binary for Remote Control.
 *
 * Pure and exported for unit testing:
 *   server      → `["remote-control", ...]`
 *   interactive → `["--remote-control", ...]`
 *
 * `--name <title>` (when provided) precedes any caller passthrough so an
 * explicit name is not shadowed by passthrough ordering.
 */
export function buildRemoteControlArgs(input: RemoteControlArgsInput): ReadonlyArray<string> {
  const modeToken = input.mode === "server" ? "remote-control" : "--remote-control";
  const nameArgs =
    input.name !== undefined && input.name.trim().length > 0
      ? ["--name", input.name.trim()]
      : [];
  const passthrough = input.passthrough ?? [];
  return [modeToken, ...nameArgs, ...passthrough];
}

/**
 * Resolve the full launch descriptor (command + args + spawn options) for a
 * Remote Control session. Reuses `makeClaudeEnvironment` for HOME/account
 * resolution. Pure resolution (no spawn) and exported so tests can assert the
 * binary, the mode flag, and the resolved HOME env without running `claude`.
 *
 * Stdio is inherited so pairing/registration output reaches the user.
 */
export const resolveRemoteControlLaunch = Effect.fn("resolveRemoteControlLaunch")(function* (
  settings: ClaudeRemoteControlSettings,
  options: RemoteControlLaunchOptions,
): Effect.fn.Return<ResolvedRemoteControlLaunch, never, Path.Path> {
  const env = yield* makeClaudeEnvironment(settings, options.baseEnv ?? process.env);
  const args = buildRemoteControlArgs({
    mode: options.mode,
    name: options.name,
    passthrough: options.passthrough,
  });
  const commandOptions: ChildProcess.CommandOptions = {
    env,
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  return {
    command: settings.binaryPath,
    args,
    options: commandOptions,
  };
});

/**
 * Launch the real `claude` CLI in Remote Control mode and wait for it to exit.
 *
 * Spawns through the canonical `ChildProcessSpawner` service (same mechanism as
 * `providerMaintenanceRunner` / `externalLauncher`). The child inherits stdio,
 * so the user sees and can interact with the pairing/registration flow. A
 * spawn failure surfaces as `ClaudeRemoteControlLaunchError`; a non-zero exit
 * surfaces as `ClaudeRemoteControlExitError`. Returns the (zero) exit code.
 */
export const launchClaudeRemoteControl = Effect.fn("launchClaudeRemoteControl")(function* (
  settings: ClaudeRemoteControlSettings,
  options: RemoteControlLaunchOptions,
): Effect.fn.Return<
  number,
  ClaudeRemoteControlError,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const launch = yield* resolveRemoteControlLaunch(settings, options);

  return yield* Effect.gen(function* () {
    const child = yield* spawner
      .spawn(ChildProcess.make(launch.command, [...launch.args], launch.options))
      .pipe(
        Effect.mapError(
          (cause) =>
            new ClaudeRemoteControlLaunchError({
              binaryPath: settings.binaryPath,
              mode: options.mode,
              detail: cause.message,
              cause,
            }),
        ),
      );

    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeRemoteControlLaunchError({
            binaryPath: settings.binaryPath,
            mode: options.mode,
            detail: cause.message,
            cause,
          }),
      ),
    );

    const numericExitCode = Number(exitCode);
    if (numericExitCode !== 0) {
      return yield* new ClaudeRemoteControlExitError({
        binaryPath: settings.binaryPath,
        mode: options.mode,
        exitCode: numericExitCode,
      });
    }
    return numericExitCode;
  }).pipe(Effect.scoped);
});

/**
 * Build the `{ command, args }` for an in-app interactive Remote Control launch
 * hosted inside the terminal subsystem (mode forced to `interactive` so the
 * session is attached/visible in the embedded terminal). Pure — no spawn, no
 * stdio config — so a future terminal host (see the SPEC in swarm/BEACON.md)
 * can adapt it to its PTY spawn API. HOME/env for the PTY must still be derived
 * via `makeClaudeEnvironment(settings)` by the host (see SPEC).
 */
export function buildRemoteControlInteractiveCommandLine(
  settings: ClaudeRemoteControlSettings,
  options?: { readonly name?: string | undefined; readonly passthrough?: ReadonlyArray<string> | undefined },
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: settings.binaryPath,
    args: buildRemoteControlArgs({
      mode: "interactive",
      name: options?.name,
      passthrough: options?.passthrough,
    }),
  };
}
