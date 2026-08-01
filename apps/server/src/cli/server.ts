import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

/**
 * Defects thrown while building the server layer can be swallowed by headless
 * startup logging, which used to make `npx t3` exit cleanly with no output on a
 * broken install. The entrypoint owns process-exit policy, so render whatever
 * diagnosis the defect carries and make sure the exit code is non-zero.
 */
const hasDiagnostic = (defect: unknown): defect is { readonly diagnostic: string } =>
  typeof defect === "object" &&
  defect !== null &&
  typeof (defect as { diagnostic?: unknown }).diagnostic === "string";

const reportStartupDefect = (defect: unknown) =>
  Effect.sync(() => {
    process.exitCode = 1;
    if (hasDiagnostic(defect)) {
      process.stderr.write(`${defect.diagnostic}\n`);
    }
  });

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
    return yield* runServer.pipe(
      Effect.provideService(ServerConfig, config),
      Effect.tapDefect(reportStartupDefect),
    );
  });

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
