import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

import { runServicePreflight } from "../cloud/servicePreflight.ts";

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.String("database-path"),
  launcherProtocol: Flag.Int("launcher-protocol"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    HostProcess.Platform.pipe(
      Effect.flatMap((platform) =>
        Console.log(
          JSON.stringify(runServicePreflight({ databasePath, launcherProtocol, platform })),
        ),
      ),
    ),
  ),
);
