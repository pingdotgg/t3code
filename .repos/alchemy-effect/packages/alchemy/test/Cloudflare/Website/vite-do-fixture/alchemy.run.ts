import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { Counter } from "./src/worker.ts";

export default Alchemy.Stack(
  "CloudflareViteDoFixture",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Vite("ViteDoFixture", {
      assets: {
        runWorkerFirst: ["/api/*"],
      },
      env: {
        Counter: Cloudflare.DurableObject<Counter>("Counter", {
          className: "Counter",
        }),
      },
      memo: {
        include: ["index.html", "src/**", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: worker.url,
    };
  }),
);
