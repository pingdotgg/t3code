import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

export class ServerEnvironmentLabelFileError extends Schema.TaggedError<ServerEnvironmentLabelFileError>()(
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

export class ServerEnvironmentLabelCommandError extends Schema.TaggedError<ServerEnvironmentLabelCommandError>()(
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
      // Server startup waits on this; hostnamectl can block on D-Bus when hostnamed is down.
      timeout: "5 seconds",
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
      Effect.asSome,
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
  const platform = yield* HostProcess.Platform;
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

const isWsl = Effect.fn("isWsl")(function* () {
  if ((yield* HostProcess.Platform) !== "linux") {
    return false;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const kernelRelease = yield* fileSystem
    .readFileString("/proc/sys/kernel/osrelease")
    .pipe(Effect.orElseSucceed(() => ""));
  return kernelRelease.toLowerCase().includes("microsoft");
});

const NON_USER_PROFILE_DIRECTORIES = new Set([
  "all users",
  "default",
  "default user",
  "defaultuser0",
  "guest",
  "linuxbrew",
  "lost+found",
  "public",
  "shared",
]);

// Each OS user runs its own environment, so a machine-wide name cannot tell them apart.
const hasOtherUserProfiles = Effect.fn("hasOtherUserProfiles")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const profilesRoot = path.dirname(home);
  if (profilesRoot === path.dirname(profilesRoot)) {
    return false;
  }
  const ownProfile = path.basename(home).toLowerCase();
  const entries = yield* fileSystem
    .readDirectory(profilesRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const entry of entries) {
    const name = entry.toLowerCase();
    if (name === ownProfile || name.startsWith(".") || NON_USER_PROFILE_DIRECTORIES.has(name)) {
      continue;
    }
    const info = yield* fileSystem
      .stat(path.join(profilesRoot, entry))
      .pipe(Effect.orElseSucceed(() => null));
    if (info?.type === "Directory") {
      return true;
    }
  }
  return false;
});

const qualifyMachineLabel = Effect.fn("qualifyMachineLabel")(function* (machineLabel: string) {
  const username = normalizeLabel(yield* HostProcess.Username);
  return username && (yield* hasOtherUserProfiles())
    ? `${machineLabel} (${username})`
    : machineLabel;
});

// Names this environment instead of the machine, e.g. for staged demos and scenario captures.
const labelOverride = Config.String("T3CODE_ENVIRONMENT_LABEL").pipe(
  Config.option,
  Config.map(Option.flatMap((label) => Option.fromNullishOr(normalizeLabel(label)))),
);

export const resolveServerEnvironmentLabel = Effect.fn("resolveServerEnvironmentLabel")(function* (
  input: ResolveServerEnvironmentLabelInput,
) {
  const override = yield* labelOverride.pipe(Effect.orElseSucceed(() => Option.none<string>()));
  if (Option.isSome(override)) {
    return override.value;
  }

  const friendlyHostLabel = yield* resolveFriendlyHostLabel();
  if (friendlyHostLabel) {
    return yield* qualifyMachineLabel(friendlyHostLabel);
  }

  const hostname = normalizeLabel(yield* HostProcess.Hostname);
  if (hostname) {
    // WSL inherits the Windows hostname, so qualify it to tell the two environments apart.
    if (yield* isWsl()) {
      const distro = normalizeLabel((yield* HostProcess.Environment).WSL_DISTRO_NAME);
      return distro ? `${hostname} WSL (${distro})` : `${hostname} WSL`;
    }
    return yield* qualifyMachineLabel(hostname);
  }

  return normalizeLabel(input.cwdBaseName) ?? "T3 environment";
});
