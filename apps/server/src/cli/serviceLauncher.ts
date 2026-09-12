import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { main as runServiceLauncher } from "../serviceLauncher.ts";

/**
 * Hosts the service launcher inside the CLI executable. Archive-distributed
 * runtimes have no Node on the machine to run `service-launcher.mjs`, so the
 * service manager runs `t3 __service-launcher` and the launcher spawns the
 * server from the same executable.
 *
 * The launcher owns SIGTERM handling and the process lifetime: it must finish
 * stopping its child before the process exits, so it runs detached from the
 * CLI's fiber rather than under `runMain`, whose signal handler would
 * interrupt the fiber and exit while the child is still being terminated.
 */
export const serviceLauncherCommand = Command.make("__service-launcher").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.sync(() => {
      runServiceLauncher().catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        process.stderr.write(`[service-launcher] ${error.message}\n`);
        process.exitCode = 1;
      });
    }),
  ),
);
