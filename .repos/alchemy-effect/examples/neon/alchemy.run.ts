import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { features } from "./src/features.ts";
import { website } from "./src/website.ts";

export default Alchemy.Stack(
  "NeonUploadTutorial",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    return { ...(yield* website(yield* Api)), ...(yield* features) };
  }),
);
