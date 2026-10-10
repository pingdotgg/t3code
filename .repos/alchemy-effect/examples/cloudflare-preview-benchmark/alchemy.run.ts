import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Photos, Sessions } from "./src/resources.ts";

export default Alchemy.Stack(
  "my-app",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Photos;
    yield* Sessions;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
    };
  }),
);
