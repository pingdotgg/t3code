import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import Api from "./ApiWorker.ts";

// #region show
export const Web = Effect.gen(function* () {
  const api = yield* Api;

  return yield* Railway.Website.Astro("Web", {
    rootDir: "./apps/web",
    env: { API_URL: api.url.as<string>() },
  });
});
// #endregion show
