import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Queues, R2 } from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* R2.Bucket("Uploads");
    const uploads = yield* R2.ReadBucket(bucket);
    const queue = yield* Queues.Queue("Jobs");
    const jobs = yield* Queues.WriteQueue(queue);
    yield* uploads
      .get("hello.txt") /*hide*/
      .pipe(Effect.orDie); /*end*/
    return {
      fetch: Effect.gen(function* () {
        const file = yield* uploads.get("hello.txt");
        yield* jobs.send({ size: file?.size });
        return HttpServerResponse.text("ok");
      }) /*hide*/
        .pipe(Effect.orDie) /*end*/,
    };
  }).pipe(
    Effect.provide([
      R2.ReadBucketBinding,
      Queues.WriteQueueBinding,
      Alchemy.RuntimeContext.phantom,
    ]),
  ),
);
// #endregion show
