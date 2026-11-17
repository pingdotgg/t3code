import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Queues, R2 } from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  return {
    fetch: Effect.gen(function* () {
      return HttpServerResponse.text("ok");
    }),
  };
});
// #endregion show
