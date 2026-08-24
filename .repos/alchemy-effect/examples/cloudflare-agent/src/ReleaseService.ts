import * as Cloudflare from "alchemy/Cloudflare";
import * as Github from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ReleaseVersion } from "./ReleaseVersion.ts";

export default Cloudflare.Worker(
  "ReleaseService",
  { main: import.meta.url },
  Effect.gen(function* () {
    const versions = yield* ReleaseVersion;

    yield* Github.consumeRepositoryEvents(
      {
        owner: "alchemy-run",
        repository: "alchemy",
        events: ["push"],
      },
      (event) => {
        const title = event.payload.head_commit?.message.split("\n")[0] ?? "";
        const isRelease =
          event.payload.ref === "refs/heads/main" &&
          title.startsWith("chore(release):");

        return isRelease
          ? versions.getByName(event.payload.head_commit!.id).generateBlog({
              input: event.payload,
            })
          : Effect.log(
              `Skipping commit "${event.payload.head_commit?.message}" (hash: ${event.payload.head_commit!.id})`,
            );
      },
    );

    return {
      fetch: Effect.gen(function* () {
        yield* versions.getByName("TEST").generateBlog({
          input: "TEST",
        });
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive)),
);
