import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import NotesWorker from "./src/NotesWorker.ts";

export default Alchemy.Stack(
  "DomainBetterAuth",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const notes = yield* NotesWorker;
    // The foldkit app, built with Vite. Its Worker serves the build and
    // forwards /api to the Notes Worker, so the app and the Api share one origin.
    const app = yield* Cloudflare.Website.Foldkit("NotesApp", {
      main: "src/web/worker.ts",
      env: { NOTES: notes },
      assets: { runWorkerFirst: ["/api", "/api/*"] },
    });
    return { url: app.url.as<string>() };
  }),
);
