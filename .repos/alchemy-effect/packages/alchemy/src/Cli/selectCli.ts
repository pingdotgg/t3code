import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isNonInteractive } from "../Util/interactive.ts";
import type { Cli } from "./Cli.ts";
import { LoggingCli } from "./LoggingCli.ts";

export { isNonInteractive } from "../Util/interactive.ts";

export const selectCli = (): Layer.Layer<Cli> =>
  isNonInteractive()
    ? LoggingCli
    : // Defer importing the Ink/React TUI (`./tui/InkCLI.tsx` pulls in `ink`)
      // until we actually need the interactive renderer. Non-interactive runs
      // (agents, CI, piped output) take the cheap `LoggingCli` branch and never
      // pay the TUI import cost.
      Layer.unwrap(
        Effect.promise(() =>
          import("./tui/InkCLI.tsx").then((m) => m.inkCLI()),
        ),
      );
