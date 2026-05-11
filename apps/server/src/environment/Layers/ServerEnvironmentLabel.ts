import * as OS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

interface ResolveServerEnvironmentLabelInput {
  readonly cwdBaseName: string;
  readonly platform?: NodeJS.Platform;
  readonly hostname?: string | null;
}

interface ServerEnvironmentLabelCommandResult {
  readonly stdout: string;
  readonly exitCode: number;
}

interface ServerEnvironmentLabelCommandRunnerShape {
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Effect.Effect<ServerEnvironmentLabelCommandResult, ServerEnvironmentLabelCommandError>;
}

export class ServerEnvironmentLabelCommandError extends Schema.TaggedErrorClass<ServerEnvironmentLabelCommandError>()(
  "ServerEnvironmentLabelCommandError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ServerEnvironmentLabelCommandRunner extends Context.Service<
  ServerEnvironmentLabelCommandRunner,
  ServerEnvironmentLabelCommandRunnerShape
>()("t3/environment/Layers/ServerEnvironmentLabel/CommandRunner") {}

export const ServerEnvironmentLabelCommandRunnerLive = Layer.effect(
  ServerEnvironmentLabelCommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return ServerEnvironmentLabelCommandRunner.of({
      run: (command, args) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                shell: process.platform === "win32",
              }),
            );
            const [stdout, , exitCode] = yield* Effect.all(
              [
                collectUint8StreamText({ stream: child.stdout }),
                collectUint8StreamText({ stream: child.stderr }),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );

            return {
              stdout: stdout.text,
              exitCode: Number(exitCode),
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ServerEnvironmentLabelCommandError({
                  command,
                  args: [...args],
                  message: `Failed to run friendly host label command: ${command}.`,
                  cause,
                }),
            ),
          ),
        ),
    });
  }),
);

function normalizeLabel(value: string | null | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

function parseMachineInfoValue(raw: string, key: string): Option.Option<string> {
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || !trimmed.startsWith(`${key}=`)) {
      continue;
    }
    const value = trimmed.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return normalizeLabel(value.slice(1, -1));
    }
    return normalizeLabel(value);
  }
  return Option.none();
}

const readLinuxMachineInfo = Effect.fn("readLinuxMachineInfo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem
    .exists("/etc/machine-info")
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Option.none();
  }

  const raw = yield* fileSystem.readFileString("/etc/machine-info").pipe(Effect.option);

  return Option.flatMap(raw, normalizeLabel);
});

const runFriendlyLabelCommand = Effect.fn("runFriendlyLabelCommand")(function* (
  command: string,
  args: readonly string[],
) {
  const commandRunner = yield* ServerEnvironmentLabelCommandRunner;
  const result = yield* commandRunner.run(command, args).pipe(Effect.option);

  if (Option.isNone(result) || result.value.exitCode !== 0) {
    return Option.none();
  }

  return normalizeLabel(result.value.stdout);
});

const resolveFriendlyHostLabel = Effect.fn("resolveFriendlyHostLabel")(function* (
  platform: NodeJS.Platform,
) {
  if (platform === "darwin") {
    return yield* runFriendlyLabelCommand("scutil", ["--get", "ComputerName"]);
  }

  if (platform === "linux") {
    const machineInfo = yield* readLinuxMachineInfo();
    if (Option.isSome(machineInfo)) {
      const prettyHostname = parseMachineInfoValue(machineInfo.value, "PRETTY_HOSTNAME");
      if (Option.isSome(prettyHostname)) {
        return prettyHostname;
      }
    }

    return yield* runFriendlyLabelCommand("hostnamectl", ["--pretty"]);
  }

  return Option.none();
});

export const resolveServerEnvironmentLabel = Effect.fn("resolveServerEnvironmentLabel")(function* (
  input: ResolveServerEnvironmentLabelInput,
) {
  const platform = input.platform ?? process.platform;
  const friendlyHostLabel = yield* resolveFriendlyHostLabel(platform);
  if (Option.isSome(friendlyHostLabel)) {
    return friendlyHostLabel.value;
  }

  const hostname = normalizeLabel(input.hostname ?? OS.hostname());
  if (Option.isSome(hostname)) {
    return hostname.value;
  }

  return Option.getOrElse(normalizeLabel(input.cwdBaseName), () => "T3 environment");
});
