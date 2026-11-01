/**
 * Fly.io Tigris bucket attached to an HTTP Service.
 *
 * The Service binds Fly.PutObject / Fly.GetObject and talks to Tigris
 * over the S3 API.
 */
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Data } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyBucket",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bucket = yield* Data;
    const api = yield* Api;

    return {
      appName: api.appName,
      bucketName: bucket.name,
      addOnId: bucket.addOnId,
      apiUrl: api.url,
    };
  }),
);
