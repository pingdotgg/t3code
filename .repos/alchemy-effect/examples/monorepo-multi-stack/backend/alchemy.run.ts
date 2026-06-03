import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Service from "./src/Service.ts";
import { Backend } from "./src/Stack.ts";

export default Backend.make(
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Service;
    return {
      url: api.url.as<string>(),
    };
  }),
);
