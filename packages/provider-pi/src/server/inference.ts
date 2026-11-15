import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseCliVersionResult,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { PiSettings } from "../settings.ts";
import { materializePiExtension } from "./extensionFile.ts";
import {
  PI_INFERENCE_EXTENSION_FILENAME,
  PI_INFERENCE_EXTENSION_SOURCE,
  PI_INFERENCE_PROVIDER,
  stripPiJsonSyntax,
  T3_INFERENCE_KEY_ENV,
  T3_PI_INFERENCE_CONFIG_ENV,
  T3_PI_INFERENCE_EXTENSION_ENV,
} from "./inferenceExtensionSource.ts";
import { PiRpcError } from "./rpc.ts";

// Pi 1.4.0 is the first release whose extension loader resolves "@earendil-works/pi-ai/models".
export const MINIMUM_PI_INFERENCE_VERSION = "1.4.0";
export const PI_VERSION_PROBE_TIMEOUT_MS = 10_000;

// Only supported versions are kept, so an upgrade from an unsupported Pi is measured again.
const supportedPiVersions = new Map<string, string>();
const piVersionKey = (config: PiSettings, environment: NodeJS.ProcessEnv) =>
  [config.binaryPath || "pi", environment.PATH ?? environment.Path ?? ""].join("\0");

/** The status check calls this on every refresh, which replaces the version sessions reuse. */
export const recordPiVersion = (
  config: PiSettings,
  environment: NodeJS.ProcessEnv,
  version: string | null,
) => {
  const key = piVersionKey(config, environment);
  if (version !== null && compareSemverVersions(version, MINIMUM_PI_INFERENCE_VERSION) >= 0) {
    supportedPiVersions.set(key, version);
  } else {
    supportedPiVersions.delete(key);
  }
  return version;
};

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      baseUrl: Schema.NonEmptyString,
      models: Schema.Array(Schema.NonEmptyString),
    }),
  ),
);
const decodeNativeModels = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ providers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
);

const inferenceError = (detail: string) => new PiRpcError({ operation: "inference", detail });

export const runPiVersionCommand = Effect.fn("PiProviderStatus.runPiVersionCommand")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const command = piSettings.binaryPath || "pi";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
});

export const materializePiInferenceExtension = Effect.fn("materializePiInferenceExtension")(
  function (cacheDir: string) {
    return materializePiExtension(
      cacheDir,
      PI_INFERENCE_EXTENSION_FILENAME,
      PI_INFERENCE_EXTENSION_SOURCE,
    );
  },
);

export const preparePiInferenceEnvironment = Effect.fn("preparePiInferenceEnvironment")(
  function* (input: {
    readonly config: PiSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly cacheDir: string;
    readonly cwd?: string | undefined;
    readonly version?: string;
  }) {
    if (input.config.inferenceEnabled !== true) {
      const environment = { ...input.environment };
      delete environment[T3_PI_INFERENCE_CONFIG_ENV];
      delete environment[T3_PI_INFERENCE_EXTENSION_ENV];
      delete environment[T3_INFERENCE_KEY_ENV];
      return environment;
    }
    const config = decodeConfig(input.environment[T3_PI_INFERENCE_CONFIG_ENV]);
    if (Option.isNone(config)) {
      return yield* inferenceError(
        "T3 inference configuration is unavailable. Reconnect the Pi inference host in T3 Code.",
      );
    }
    const validUrl = yield* Effect.try({
      try: () => {
        const url = new URL(config.value.baseUrl);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      },
      catch: () => inferenceError("T3 inference endpoint is invalid."),
    });
    if (!validUrl || config.value.models.some((id) => id.trim().length === 0)) {
      return yield* inferenceError("T3 inference configuration is invalid.");
    }
    if (!input.environment[T3_INFERENCE_KEY_ENV]?.trim()) {
      return yield* inferenceError(
        "T3 inference credentials are unavailable. Reconnect the Pi inference host in T3 Code.",
      );
    }
    const version =
      input.version ??
      supportedPiVersions.get(piVersionKey(input.config, input.environment)) ??
      (yield* runPiVersionCommand(input.config, input.environment).pipe(
        Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS),
        Effect.map((result) =>
          recordPiVersion(
            input.config,
            input.environment,
            Option.isSome(result) && result.value.code === 0
              ? parseCliVersionResult(result.value)
              : null,
          ),
        ),
        Effect.mapError(() =>
          inferenceError("Could not check the Pi version for inference routing."),
        ),
      ));
    if (version === null || compareSemverVersions(version, MINIMUM_PI_INFERENCE_VERSION) < 0) {
      return yield* inferenceError(
        `Pi ${MINIMUM_PI_INFERENCE_VERSION} or newer is required for inference routing. Update Pi or turn off inference routing.`,
      );
    }
    if (input.cacheDir.length === 0) {
      return yield* inferenceError("The Pi inference extension cache is unavailable.");
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const cwd = input.cwd ?? (yield* HostProcess.WorkingDirectory);
    const launchHome =
      (platform === "win32" ? input.environment.USERPROFILE : input.environment.HOME) || home;
    const agentDir = input.environment.PI_CODING_AGENT_DIR
      ? expandHomePath(input.environment.PI_CODING_AGENT_DIR, launchHome)
      : path.join(launchHome, ".pi", "agent");
    const nativeModels = yield* fs
      .readFileString(path.resolve(cwd, agentDir, "models.json"))
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.undefined
            : Effect.fail(inferenceError("T3 inference could not read Pi models.json.")),
        ),
      );
    if (nativeModels !== undefined) {
      const nativeConfig = decodeNativeModels(stripPiJsonSyntax(nativeModels));
      if (Option.isNone(nativeConfig)) {
        return yield* inferenceError(
          "T3 inference requires a valid Pi models.json. Your file has not been changed.",
        );
      }
      if (Object.hasOwn(nativeConfig.value.providers ?? {}, PI_INFERENCE_PROVIDER)) {
        return yield* inferenceError(
          "Pi models.json already defines t3proxy. Rename that provider before enabling T3 inference.",
        );
      }
    }
    const extensionPath = yield* materializePiInferenceExtension(input.cacheDir).pipe(
      Effect.mapError(() => inferenceError("Could not prepare the Pi inference extension.")),
    );
    return { ...input.environment, [T3_PI_INFERENCE_EXTENSION_ENV]: extensionPath };
  },
);
