// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { spawnAndCollect } from "./providerSnapshot.ts";

const MISE_CONFIG_NAMES = [
  "mise.toml",
  ".mise.toml",
  "mise.local.toml",
  ".mise.local.toml",
] as const;
const ENVIRONMENT_START_MARKER = "__T3CODE_MISE_ENV_START__";
const ENVIRONMENT_END_MARKER = "__T3CODE_MISE_ENV_END__";
const decodeEnvironment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

export class ProjectEnvironmentActivationError extends Schema.TaggedError<ProjectEnvironmentActivationError>()(
  "ProjectEnvironmentActivationError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to activate the Mise environment in '${this.cwd}'.`;
  }
}

function hasMiseConfig(cwd: string): boolean {
  let directory = NodePath.resolve(cwd);

  while (true) {
    for (const name of MISE_CONFIG_NAMES) {
      if (NodeFS.existsSync(NodePath.join(directory, name))) return true;
    }

    if (NodeFS.existsSync(NodePath.join(directory, ".git"))) return false;
    const parent = NodePath.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function extractMarkedOutput(output: string): string {
  const start = output.indexOf(ENVIRONMENT_START_MARKER);
  const end = output.indexOf(ENVIRONMENT_END_MARKER, start + ENVIRONMENT_START_MARKER.length);
  if (start === -1 || end === -1) {
    throw new Error("Mise activation did not emit a complete environment capture.");
  }
  return output
    .slice(start + ENVIRONMENT_START_MARKER.length, end)
    .replace(/^\r?\n/u, "")
    .replace(/\r?\n$/u, "");
}

function decodePosixEnvironment(output: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of extractMarkedOutput(output).split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function decodeWindowsEnvironment(output: string): NodeJS.ProcessEnv {
  const parsed: unknown = JSON.parse(extractMarkedOutput(output));
  return decodeEnvironment(parsed);
}

const POSIX_ACTIVATION_COMMAND = [
  'eval "$(mise activate sh)"',
  `printf '%s\\n' '${ENVIRONMENT_START_MARKER}'`,
  "env -0",
  `printf '%s\\n' '${ENVIRONMENT_END_MARKER}'`,
].join("; ");

const WINDOWS_ACTIVATION_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "(& mise activate pwsh) | Out-String | Invoke-Expression",
  "$environment = [ordered]@{}",
  "Get-ChildItem Env: | ForEach-Object { $environment[$_.Name] = $_.Value }",
  `Write-Output '${ENVIRONMENT_START_MARKER}'`,
  "$environment | ConvertTo-Json -Compress",
  `Write-Output '${ENVIRONMENT_END_MARKER}'`,
].join("; ");

export const resolveProjectEnvironment = Effect.fn("resolveProjectEnvironment")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  NodeJS.ProcessEnv,
  ProjectEnvironmentActivationError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  if (!hasMiseConfig(input.cwd)) return input.environment;

  const platform = yield* HostProcessPlatform;
  const windowsRoot = input.environment.SystemRoot ?? input.environment.WINDIR;
  const command =
    platform === "win32"
      ? windowsRoot
        ? `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : "powershell.exe"
      : "/bin/sh";
  const args =
    platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACTIVATION_COMMAND]
      : ["-c", POSIX_ACTIVATION_COMMAND];

  const result = yield* spawnAndCollect(
    command,
    ChildProcess.make(command, args, {
      cwd: input.cwd,
      env: input.environment,
      extendEnv: false,
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(
      (cause) =>
        new ProjectEnvironmentActivationError({
          cwd: input.cwd,
          cause,
        }),
    ),
  );
  if (result.code !== 0) {
    return yield* new ProjectEnvironmentActivationError({
      cwd: input.cwd,
      cause: new Error(`mise activate exited with code ${result.code}`),
    });
  }

  return yield* Effect.try({
    try: () =>
      platform === "win32"
        ? decodeWindowsEnvironment(result.stdout)
        : decodePosixEnvironment(result.stdout),
    catch: (cause) => new ProjectEnvironmentActivationError({ cwd: input.cwd, cause }),
  });
});
