import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { runWorkerProcess } from "@t3tools/extension-runtime/worker-process";

/**
 * Hosts the extension worker inside the CLI executable. The npm bundle forks
 * the sibling `extension-worker.mjs` under the host Node; the single-executable
 * has no Node to fork a script with, so `EnvironmentExtensions` has the runtime
 * spawn this hidden subcommand of its own executable instead.
 *
 * Inside the executable `import()` resolves only built-ins, so extension
 * entries load through `require`, which reads the real filesystem and accepts
 * ES modules.
 */
export const extensionWorkerCommand = Command.make("__extension-worker", {}).pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.sync(() =>
      runWorkerProcess({
        loadEntry: async (entryPath) => NodeModule.createRequire(entryPath)(entryPath),
      }),
    ),
  ),
);
