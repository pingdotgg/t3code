import { Service } from "@opencode/client/effect/service";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { probeOpenCodeBinary } from "../versionProbe.ts";

const decodeServiceConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
);

function isRegisteredService(registeredUrl: string, serverUrl: string): boolean {
  const registered = URL.parse(registeredUrl);
  const configured = URL.parse(serverUrl);
  if (registered === null || configured === null || registered.port !== configured.port) {
    return false;
  }
  // A wildcard listener covers only its own address family's loopback; `localhost` could be either.
  return (
    registered.hostname === configured.hostname ||
    (registered.hostname === "0.0.0.0" && configured.hostname === "127.0.0.1") ||
    (registered.hostname === "[::]" && configured.hostname === "[::1]")
  );
}

/**
 * Replaces the way the TUI does on a version mismatch, which hands persistent terminals to the new
 * process. `opencode service restart` shuts them down instead.
 */
export const replaceOutdatedService = Effect.fn("OpenCode2Service.replaceOutdatedService")(
  function* (input: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const { generation, version } = yield* probeOpenCodeBinary(input.binaryPath, input.environment);
    if (generation !== "v2") return;

    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const home = input.environment.HOME ?? (yield* HostProcess.HomeDirectory);
    const file = path.join(
      input.environment.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
      "opencode",
      "service.json",
    );
    // `Service.incumbent` would send the local service's password to the configured URL, which may
    // be another machine. `discover` only contacts the address in the local registration.
    const service = yield* Service.discover({ file });
    if (service === undefined || !isRegisteredService(service.url, input.serverUrl)) return;

    // Configured variables below can change PATH, which a bare name would then resolve against.
    const executable = yield* resolveCommandPath(input.binaryPath, { env: input.environment });
    if (executable === null) return;
    const command = yield* resolveSpawnCommand(executable, ["serve", "--service"], {
      env: input.environment,
      extendEnv: true,
      bypassNpmShim: true,
    });
    // The service spawns without a shell; stopping it first would leave nothing running.
    if (command.shell) {
      return yield* Effect.logWarning("OpenCode service cannot be replaced through a shell shim");
    }

    const config = yield* fileSystem
      .readFileString(
        path.join(
          input.environment.OPENCODE_CONFIG_DIR ??
            path.join(input.environment.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode"),
          "service.json",
        ),
      )
      .pipe(Effect.option, Effect.map(Option.flatMap(decodeServiceConfig)));
    // The CLI passes configured variables but never lets them move the registration file.
    const { XDG_STATE_HOME: _state, ...configured } = Option.getOrUndefined(config)?.env ?? {};
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...input.environment, ...configured })) {
      if (value !== undefined) env[name] = value;
    }

    yield* Service.ensure({
      file,
      version,
      command: [command.command, ...command.args],
      env,
    });
  },
);
