import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";
import Service from "./backend/src/Service.ts";

export default Alchemy.Stack(
  "Monorepo",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backend = yield* Service;
    const path = yield* Path;

    const website = yield* Cloudflare.Vite("Website", {
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      env: {
        VITE_API_URL: backend.url.as<string>(),
      },
    });
    return {
      backendUrl: backend.url.as<string>(),
      websiteUrl: website.url.as<string>(),
    };
  }),
);
