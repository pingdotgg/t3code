import * as Effect from "effect/Effect";
import { Stack } from "@/Stack.ts";
import * as State from "@/State/index.ts";
import { TestLayers } from "../../test.resources.ts";

export default Stack(
  "import-stack-fixture",
  {
    providers: TestLayers(),
    state: State.inMemoryState(),
  },
  Effect.succeed("import-stack-fixture"),
);
