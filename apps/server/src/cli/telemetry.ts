import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";

import { baseDirFlag } from "./config.ts";
import { readSettingsObject, resolveCliServerPaths, updateSettingsObject } from "./settingsFile.ts";

const envTelemetryEnabled = Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.option);

/** The variable overrides the setting for a server that sees it, so say when this shell sets it. */
const noteEnvironmentOverride = Effect.gen(function* () {
  const fromEnvironment = yield* envTelemetryEnabled;
  if (Option.isSome(fromEnvironment)) {
    yield* Console.log(
      `T3CODE_TELEMETRY_ENABLED=${fromEnvironment.value} is set in this shell. A server started with it ignores this setting.\n`,
    );
  }
});

const writeTelemetrySetting = (settingsPath: string, enabled: boolean) =>
  updateSettingsObject(settingsPath, (settings) =>
    Effect.succeed(
      enabled
        ? // On is the default, and settings.json keeps only what differs from defaults.
          Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "telemetryEnabled"))
        : { ...settings, telemetryEnabled: false },
    ),
  );

const telemetrySetCommand = (enabled: boolean) =>
  Command.make(enabled ? "on" : "off", { baseDir: baseDirFlag }).pipe(
    Command.withDescription(
      enabled
        ? "Send product usage events and T3 Connect connection traces."
        : "Stop sending product usage events and T3 Connect connection traces.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const paths = yield* resolveCliServerPaths(flags.baseDir);
        yield* writeTelemetrySetting(paths.settingsPath, enabled);
        yield* Console.log(
          `Telemetry turned ${enabled ? "on" : "off"} in ${paths.settingsPath}. A running server applies it to usage events now and to connection traces after it restarts.\n`,
        );
        yield* noteEnvironmentOverride;
      }),
    ),
  );

const telemetryStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show whether the environment's telemetry setting is on."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliServerPaths(flags.baseDir);
      const { settings } = yield* readSettingsObject(paths.settingsPath);
      yield* Console.log(
        `Telemetry setting: ${settings.telemetryEnabled === false ? "off" : "on"} (${paths.settingsPath}).\n`,
      );
      yield* noteEnvironmentOverride;
    }),
  ),
);

export const telemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription(
    "Turn product usage events and T3 Connect connection traces on or off for this environment.",
  ),
  Command.withSubcommands([
    telemetrySetCommand(true),
    telemetrySetCommand(false),
    telemetryStatusCommand,
  ]),
);
