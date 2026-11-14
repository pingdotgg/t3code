import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Queues, R2 } from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  const uploads = yield* R2.ReadBucket(bucket);
  return {
    fetch: Effect.gen(function* () {
      const file = yield* uploads.get("hello.txt");
      return HttpServerResponse.text("ok");
    }) /*hide*/
      .pipe(Effect.orDie) /*end*/,
  };
});
// #endregion show
