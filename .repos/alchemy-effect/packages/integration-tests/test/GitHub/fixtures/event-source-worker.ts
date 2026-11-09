import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const owner = "alchemy-run-test";
export const repository = "alchemy-pr-1932-event-source";

// Consumes the repository's events without passing a `secret`, so the
// event source has to generate one for the webhook and the Worker.
export default class GitHubEventSourceWorker extends Cloudflare.Worker<GitHubEventSourceWorker>()(
  "GitHubEventSourceWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    yield* GitHub.consumeRepositoryEvents({ owner, repository }, (event) =>
      Effect.log(`received ${event.name} (${event.id})`),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(Effect.provide(GitHub.RepositoryEventSourceLive)),
) {}
