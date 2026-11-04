import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stripe from "@alchemy.run/stripe";
import BankWorker from "@bank/server/BankWorker";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "CloudflareDomainExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers(), Axiom.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bank = yield* BankWorker;
    // The foldkit app, built with Vite. Its Worker serves the build and
    // forwards /api to the bank, so the app and the Api share one origin.
    const app = yield* Cloudflare.Website.Foldkit("BankApp", {
      rootDir: "packages/web",
      main: "src/worker.ts",
      env: { BANK: bank },
      assets: { runWorkerFirst: ["/api", "/api/*"] },
    });
    return { url: bank.url.as<string>(), app: app.url.as<string>() };
  }),
);
