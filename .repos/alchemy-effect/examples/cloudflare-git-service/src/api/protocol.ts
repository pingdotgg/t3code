/** Smart HTTP uses the same API middleware and request services as JSON endpoints. */
import * as Git from "alchemy/Git";
import * as GitHttp from "alchemy/Git/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { AppApi } from "./api.ts";
import { checkRefChanges } from "./branch-policy.ts";

export const ProtocolLive = HttpApiBuilder.group(AppApi, "protocol", (h) =>
  Effect.gen(function* () {
    const git = yield* Git.Engine;
    const defaults = yield* Git.Handlers;
    return h
      .handleRaw("infoRefs", defaults.protocol.infoRefs)
      .handleRaw("uploadPack", defaults.protocol.uploadPack)
      .handleRaw("receivePack", ({ params, request }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* git.repositories
              .get(params)
              .pipe(Effect.catchTag("StoreError", Effect.die));
            const push = yield* GitHttp.ReceivePack.decode(request);
            if (push._tag === "Probe")
              return GitHttp.ReceivePack.probeResponse();
            return yield* Effect.gen(function* () {
              yield* checkRefChanges(repo, push.updates);
              const prepared = yield* git.preparePush(repo, push.input);
              // Additional application validation can read prepared.readObject(oid) here.
              return GitHttp.ReceivePack.response(
                push,
                yield* git.commitPush(prepared),
              );
            }).pipe(
              Effect.catchTag("PushDenied", (error) =>
                Effect.succeed(GitHttp.ReceivePack.reject(push, error.reason)),
              ),
            );
          }),
        ).pipe(
          Effect.catchTag("StoreError", (error) =>
            Effect.succeed(GitHttp.ReceivePack.failure(error.reason)),
          ),
          Effect.catchTag(["WireProtocolError", "PackIngestError"], (error) =>
            Effect.succeed(GitHttp.ReceivePack.failure(error.reason)),
          ),
        ),
      );
  }),
);
