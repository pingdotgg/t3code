import * as Cloudflare from "@alchemy.run/cloudflare";
import { Queues } from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
export default Cloudflare.Worker(
  "Commits",
  { main: import.meta.url },
  Effect.gen(function* () {
    const messages = yield* Queues.WriteQueue(yield* Cloudflare.Queues.Queue("Messages"));

    yield* GitHub.consumeRepositoryEvents(
      { owner: "alchemy-run", repository: "alchemy", events: ["push"] },
      (event) =>
        messages
          .send({ room: "commits", text: event.payload.head_commit?.message ?? "" }) /*hide*/
          .pipe(Effect.orDie) /*end*/,
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(Effect.provide([Queues.WriteQueueBinding, GitHub.RepositoryEventSourceLive])),
);
// #endregion show
