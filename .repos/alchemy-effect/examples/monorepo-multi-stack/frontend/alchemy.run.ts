import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Backend } from "@monorepo-multi-stack/backend";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Frontend",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // reference the prod stage of the backend
    const backend = yield* Backend;

    const website = yield* Cloudflare.Vite("Website", {
      env: {
        VITE_API_URL: backend.url,
      },
    });

    return {
      url: website.url.as<string>(),
    };
  }),
);
