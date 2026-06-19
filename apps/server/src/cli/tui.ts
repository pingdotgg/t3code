import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { buildTuiRuntime, makeTuiClient } from "../tui/runtime.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const tuiCommand = Command.make("tui", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Open a terminal UI for the running local T3 Code server (no port forwarding required).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);

      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        yield* Console.error(
          "No running T3 Code server was found. Start one with `t3 serve` (or `t3 start`) first.",
        );
        return;
      }

      const runtime = buildTuiRuntime(config, runtimeState.value.origin);
      const client = makeTuiClient(runtime);

      // Lazy-load the Ink UI so that `react`/`ink` only load for `t3 tui`,
      // keeping the regular server startup path untouched.
      const { runTuiApp } = yield* Effect.promise(() => import("../tui/app.ts"));
      yield* Effect.promise(() => runTuiApp(client)).pipe(
        Effect.ensuring(Effect.promise(() => client.dispose())),
      );
    }),
  ),
);
