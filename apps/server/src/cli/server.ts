import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import * as ServerShutdown from "../serverShutdown.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const shutdown = yield* ServerShutdown.make;
    const serverServices = Layer.mergeAll(
      Layer.succeed(ServerConfig, config),
      Layer.succeed(ServerShutdown.ServerShutdown, shutdown),
    );
    return yield* Effect.raceFirst(
      runServer,
      shutdown.awaitRequest.pipe(
        Effect.flatMap((exitCode) => Effect.fail(new ServerRequestedExit(exitCode))),
      ),
    ).pipe(Effect.provide(serverServices));
  });

class ServerRequestedExit extends Error {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode]: number;

  constructor(exitCode: number) {
    super(`Server requested exit ${String(exitCode)}.`);
    this[Runtime.errorExitCode] = exitCode;
  }
}

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
