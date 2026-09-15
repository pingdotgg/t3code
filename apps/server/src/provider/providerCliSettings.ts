import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import type { CliInstallDriver } from "./providerCliRelease.ts";

const decodeInstalled = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ executable: Schema.String })),
);

/** Custom executables and external OpenCode servers keep their existing installation owner. */
export const providerCliSetup = Effect.fn("providerCliSetup")(function* (
  driver: CliInstallDriver,
  config: { readonly binaryPath: string; readonly serverUrl?: string },
) {
  const { baseDir } = yield* ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const directory = path.join(baseDir, "tools", "provider-clis", driver);
  const defaultCommand = driver === "claudeAgent" ? "claude" : driver;
  let binary = config.binaryPath.trim();
  if (!config.serverUrl?.trim() && (!binary || binary === defaultCommand)) {
    const installed = yield* fs
      .readFileString(path.join(directory, "installed.json"))
      .pipe(Effect.flatMap(decodeInstalled), Effect.option);
    if (
      installed._tag === "Some" &&
      path
        .resolve(installed.value.executable)
        .startsWith(`${path.resolve(directory)}${path.sep}`) &&
      (yield* fs.exists(installed.value.executable).pipe(Effect.catch(() => Effect.succeed(false))))
    )
      binary = installed.value.executable;
  }
  const relative = path.relative(directory, binary);
  const managed =
    path.isAbsolute(binary) &&
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  const canInstall =
    ["darwin", "linux", "win32"].includes(platform) &&
    ["x64", "arm64"].includes(arch) &&
    !config.serverUrl?.trim() &&
    (!binary || binary === defaultCommand || managed);
  return {
    managed,
    binaryPath: binary,
    available:
      managed && (yield* fs.exists(binary).pipe(Effect.catch(() => Effect.succeed(false)))),
    capabilities: { canInstall, canAuthenticate: false },
  };
});
