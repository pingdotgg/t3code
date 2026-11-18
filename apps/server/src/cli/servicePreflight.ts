import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import { bootServiceUnitProgram } from "../cloud/bootService.ts";
import { runServicePreflight } from "../cloud/servicePreflight.ts";
import {
  decodeServiceLauncherContext,
  SERVICE_LAUNCHER_CONTEXT_ENV,
} from "../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../processRunner.ts";

// Only a server under a protocol-3 launcher hands the target to it; that launcher never
// repoints its unit, so the unit names the running launcher.
const launcherRuntimeVersion = Effect.fn("cli.service_preflight.launcher_runtime_version")(
  function* (launcherProtocol: number) {
    const context = (yield* HostProcess.Environment)[SERVICE_LAUNCHER_CONTEXT_ENV];
    if (
      launcherProtocol !== 3 ||
      context === undefined ||
      decodeServiceLauncherContext(context)?.protocol !== 3
    ) {
      return undefined;
    }
    const path = yield* Path.Path;
    const program = yield* bootServiceUnitProgram().pipe(Effect.provide(ProcessRunner.layer));
    return Option.getOrUndefined(
      Option.map(program, (entry) => path.basename(path.dirname(entry))),
    );
  },
);

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.String("database-path"),
  launcherProtocol: Flag.Int("launcher-protocol"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    launcherRuntimeVersion(launcherProtocol).pipe(
      Effect.flatMap((launcherVersion) =>
        Console.log(
          JSON.stringify(runServicePreflight({ databasePath, launcherProtocol, launcherVersion })),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);
