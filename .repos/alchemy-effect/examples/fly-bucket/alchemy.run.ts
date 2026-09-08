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
import { Data, PublicIp, Site } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyBucket",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const bucket = yield* Data;
    const ip = yield* PublicIp;
    const api = yield* Api;

    return {
      appName: site.appName,
      appUrl: site.url,
      bucketName: bucket.name,
      addOnId: bucket.addOnId,
      ip: ip.ip,
      apiUrl: api.url,
    };
  }),
);
