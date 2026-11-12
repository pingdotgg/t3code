/** @jsxRuntime automatic */
/** @jsxImportSource @alchemy.run/sigil */
import { Box } from "@alchemy.run/sigil";
import { runMain } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import { Status } from "../../../src/Cli/components/ui/Feedback";
import { makeNonInteractive } from "../../../src/Interaction";

Effect.gen(function* () {
  const service = makeNonInteractive({ colors: false, unicode: false });
  // Printing a view renders through Sigil, so the JSX runtime check below
  // covers the components the CLI actually draws with.
  yield* service.output.print(<Status variant="info">Starting deployment</Status>);
  yield* service.output.success("Deployment complete");
  yield* Effect.sync(() => {
    const element = <Box />;
    if (process.env.NODE_ENV !== "production" || "_store" in element) {
      throw new Error("The CLI must use the production JSX runtime");
    }
    console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
  });
}).pipe(runMain);
