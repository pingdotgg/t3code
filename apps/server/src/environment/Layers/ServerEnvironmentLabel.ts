import * as OS from "node:os";

import { Effect, FileSystem } from "effect";

import { runProcess } from "../../processRunner.ts";

interface ResolveServerEnvironmentLabelInput {
  readonly cwdBaseName: string;
  readonly platform?: NodeJS.Platform;
  readonly hostname?: string | null;
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
  const exists = yield* fileSystem
    .exists("/etc/machine-info")
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return null;
  }

  return yield* fileSystem
    .readFileString("/etc/machine-info")
    .pipe(Effect.orElseSucceed(() => null));
});

const runFriendlyLabelCommand = Effect.fn("runFriendlyLabelCommand")(function* (
  command: string,
  args: readonly string[],
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      runProcess(command, args, {
        allowNonZeroExit: true,
      }),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

  if (!result || result.code !== 0) {
    return null;
  }

  return normalizeLabel(result.stdout);
});

const resolveFriendlyHostLabel = Effect.fn("resolveFriendlyHostLabel")(function* (
  platform: NodeJS.Platform,
) {
  if (platform === "darwin") {
    return yield* runFriendlyLabelCommand("scutil", ["--get", "ComputerName"]);
  }

  if (platform === "linux") {
    const machineInfo = normalizeLabel(yield* readLinuxMachineInfo());
    if (machineInfo) {
      const prettyHostname = parseMachineInfoValue(machineInfo, "PRETTY_HOSTNAME");
      if (prettyHostname) {
        return prettyHostname;
      }
    }

    return yield* runFriendlyLabelCommand("hostnamectl", ["--pretty"]);
  }

  return null;
});

export const resolveServerEnvironmentLabel = Effect.fn("resolveServerEnvironmentLabel")(function* (
  input: ResolveServerEnvironmentLabelInput,
) {
  const platform = input.platform ?? process.platform;
  const friendlyHostLabel = yield* resolveFriendlyHostLabel(platform);
  if (friendlyHostLabel) {
    return friendlyHostLabel;
  }

  const hostname = normalizeLabel(input.hostname ?? OS.hostname());
  if (hostname) {
    return hostname;
  }

  return normalizeLabel(input.cwdBaseName) ?? "T3 environment";
});
