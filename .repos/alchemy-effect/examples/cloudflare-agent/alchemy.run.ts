import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import DevBoxLive from "./src/DevBox.ts";
import ReleaseService from "./src/ReleaseService.ts";

export default Alchemy.Stack(
  "Stack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const releaseService = yield* ReleaseService;

    return {
      releaseService: releaseService.url.as<string>(),
    };
  }).pipe(Effect.provide(DevBoxLive)),
);
