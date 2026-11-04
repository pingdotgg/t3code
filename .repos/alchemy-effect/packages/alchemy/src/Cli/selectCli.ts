import * as CliOutput from "effect/cli/CliOutput";
import type * as Prompt from "effect/cli/Prompt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Interaction } from "../Interaction.ts";
import type { Cli } from "../Report.ts";
import { LoggingCli } from "./LoggingCli.ts";
import { plainCliFormatter } from "./PlainCliFormatter.ts";

type SelectedCli = Layer.Layer<Cli, never, Interaction | Prompt.Environment>;

/** Select the interactive or append-only root renderer. */
export const selectCliServices = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cli = yield* Interaction;
      if (!cli.terminal.input) {
        const plain: SelectedCli = Layer.mergeAll(
          LoggingCli,
          CliOutput.layer(plainCliFormatter({ columns: cli.terminal.columns })),
        );
        return plain;
      }

      return yield* Effect.promise<SelectedCli>(async () => {
        const { sigilCli } = await import("./components/view/SigilCli.tsx");
        const { brandedCliFormatter } = await import("./components/view/Help.tsx");
        return Layer.mergeAll(sigilCli(), CliOutput.layer(brandedCliFormatter(cli)));
      });
    }),
  );
