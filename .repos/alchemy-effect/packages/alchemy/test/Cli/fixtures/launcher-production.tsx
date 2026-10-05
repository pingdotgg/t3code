/** @jsxImportSource @alchemy.run/sigil */
import { Box } from "@alchemy.run/sigil";
import { makeRuntime } from "../../../src/Cli/components/view/Runtime";
import { runMain } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";

Effect.gen(function* () {
  const { service } = makeRuntime(
    { input: false, captureConsole: false },
    {
      input: false,
      columns: 80,
      rows: 24,
      colors: false,
      unicode: false,
      alternateScreen: false,
    },
  );
  const progress = yield* service.live.progress({
    label: "Starting deployment",
  });
  yield* progress.succeed("Deployment complete");
  yield* Effect.sync(() => {
    const element = <Box />;
    if (process.env.NODE_ENV !== "production" || "_store" in element) {
      throw new Error("The CLI must use the production JSX runtime");
    }
    console.log(
      JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }),
    );
  });
}).pipe(Effect.scoped, runMain);
