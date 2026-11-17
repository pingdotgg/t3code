import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareFlueExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Vite("Website", {
      // Flue's generated Worker entry (`flue()` serves it as a virtual module).
      main: "virtual:flue/worker",
      // Flue requires `nodejs_compat` and a date of 2026-04-01 or later.
      compatibility: {
        date: "2026-06-01",
        flags: ["nodejs_compat"],
      },
      memo: {
        include: ["src/**", "package.json", "vite.config.ts"],
      },
      env: {
        // Workers AI, for the agent's `cloudflare/...` model.
        AI: Cloudflare.Workers.AI(),
        // One Durable Object per `'use agent'` agent: the `Assistant` agent
        // is the class `FlueAssistantAgent`, bound as `FLUE_ASSISTANT_AGENT`.
        FLUE_ASSISTANT_AGENT: Cloudflare.DurableObject("FlueAssistantAgent", {
          className: "FlueAssistantAgent",
        }),
      },
    });

    return {
      url: site.url,
    };
  }),
);
