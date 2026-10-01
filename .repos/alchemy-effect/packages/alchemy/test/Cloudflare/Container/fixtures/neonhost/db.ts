import { Project } from "@/Neon/Project.ts";
import * as Effect from "effect/Effect";

/**
 * Real Neon Postgres used as the container's DATABASE_URL. Neon has no
 * local emulator — even under `alchemy dev` this is a cloud host, so the
 * loopback rewrite must leave the URL alone and the container needs
 * `enableInternet`.
 */
export const NeonHostProject = Effect.gen(function* () {
  return yield* Project("NeonHostProject");
});
