import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import type * as Prompt from "effect/unstable/cli/Prompt";
import type { Cli } from "../Report.ts";
import { CliKit } from "./CliKit/CliKit.ts";
import { LoggingCli } from "./LoggingCli.ts";
import { plainCliFormatter } from "./PlainCliFormatter.ts";

type SelectedCli = Layer.Layer<Cli, never, CliKit | Prompt.Environment>;

/** Select the interactive or append-only root renderer. */
export const selectCliServices = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cli = yield* CliKit;
      if (!cli.terminal.input) {
        const plain: SelectedCli = Layer.mergeAll(
          LoggingCli,
          CliOutput.layer(plainCliFormatter({ columns: cli.terminal.columns })),
        );
        return plain;
      }

      return yield* Effect.promise<SelectedCli>(async () => {
        const { sigilCli } = await import("./components/view/SigilCli.tsx");
        const { brandedCliFormatter } =
          await import("./components/view/Help.tsx");
        return Layer.mergeAll(
          sigilCli(),
          CliOutput.layer(brandedCliFormatter(cli)),
        );
      });
    }),
  );
