import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { runServicePreflight } from "../cloud/servicePreflight.ts";

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.string("database-path"),
  launcherProtocol: Flag.integer("launcher-protocol"),
}).pipe(
  Command.withHidden,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    Console.log(JSON.stringify(runServicePreflight({ databasePath, launcherProtocol }))).pipe(
      Effect.asVoid,
    ),
  ),
);
