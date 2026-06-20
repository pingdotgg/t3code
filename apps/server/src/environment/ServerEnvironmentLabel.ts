import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

interface ResolveServerEnvironmentLabelInput {
  readonly cwdBaseName: string;
}

const ServerEnvironmentLabelCommandProbe = Schema.Literals([
  "macos-computer-name",
  "linux-pretty-hostname",
]);
type ServerEnvironmentLabelCommandProbe = typeof ServerEnvironmentLabelCommandProbe.Type;

export class ServerEnvironmentLabelFileError extends Schema.TaggedErrorClass<ServerEnvironmentLabelFileError>()(
  "ServerEnvironmentLabelFileError",
  {
    operation: Schema.Literals(["inspect", "read"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} environment-label file at ${this.path}.`;
  }
}

export class ServerEnvironmentLabelCommandError extends Schema.TaggedErrorClass<ServerEnvironmentLabelCommandError>()(
  "ServerEnvironmentLabelCommandError",
  {
    probe: ServerEnvironmentLabelCommandProbe,
    executable: Schema.String,
    argumentCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to run environment-label probe '${this.probe}' with ${this.executable}.`;
  }
}

function normalizeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseMachineInfoValue(raw: string, key: string): string | null {
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
  return null;
}

const readLinuxMachineInfo = Effect.fn("readLinuxMachineInfo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const machineInfoPath = "/etc/machine-info";
  return yield* fileSystem.exists(machineInfoPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerEnvironmentLabelFileError({
          operation: "inspect",
          path: machineInfoPath,
          cause,
        }),
    ),
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(machineInfoPath).pipe(
            Effect.mapError(
              (cause) =>
                new ServerEnvironmentLabelFileError({
                  operation: "read",
                  path: machineInfoPath,
                  cause,
                }),
            ),
          )
        : Effect.succeed(null),
    ),
    Effect.catchTags({
      ServerEnvironmentLabelFileError: (error) =>
        Effect.logDebug(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            path: error.path,
            cause: error,
          }),
          Effect.as(null),
        ),
    }),
  );
});

const runFriendlyLabelCommand = Effect.fn("runFriendlyLabelCommand")(function* (input: {
  readonly probe: ServerEnvironmentLabelCommandProbe;
  readonly command: string;
  readonly args: readonly string[];
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentLabelCommandError({
            probe: input.probe,
            executable: input.command,
            argumentCount: input.args.length,
            cause,
          }),
      ),
      Effect.map(Option.some),
      Effect.catchTags({
        ServerEnvironmentLabelCommandError: (error) =>
          Effect.logDebug(error.message).pipe(
            Effect.annotateLogs({
              probe: error.probe,
              executable: error.executable,
              argumentCount: error.argumentCount,
              cause: error,
            }),
            Effect.as(Option.none()),
          ),
      }),
    );

  if (Option.isNone(result) || result.value.code !== 0) {
    return null;
  }

  return normalizeLabel(result.value.stdout);
});

const resolveFriendlyHostLabel = Effect.fn("resolveFriendlyHostLabel")(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform === "darwin") {
    return yield* runFriendlyLabelCommand({
      probe: "macos-computer-name",
      command: "scutil",
      args: ["--get", "ComputerName"],
    });
  }

  if (platform === "linux") {
    const machineInfo = normalizeLabel(yield* readLinuxMachineInfo());
    if (machineInfo) {
      const prettyHostname = parseMachineInfoValue(machineInfo, "PRETTY_HOSTNAME");
      if (prettyHostname) {
        return prettyHostname;
      }
    }

    return yield* runFriendlyLabelCommand({
      probe: "linux-pretty-hostname",
      command: "hostnamectl",
      args: ["--pretty"],
    });
  }

  return null;
});

export const resolveServerEnvironmentLabel = Effect.fn("resolveServerEnvironmentLabel")(function* (
  input: ResolveServerEnvironmentLabelInput,
) {
  const friendlyHostLabel = yield* resolveFriendlyHostLabel();
  if (friendlyHostLabel) {
    return friendlyHostLabel;
  }

  const hostname = normalizeLabel(yield* HostProcessHostname);
  if (hostname) {
    return hostname;
  }

  return normalizeLabel(input.cwdBaseName) ?? "T3 environment";
});
