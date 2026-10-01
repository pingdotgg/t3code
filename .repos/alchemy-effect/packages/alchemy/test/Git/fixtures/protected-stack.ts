import * as HttpRouter from "effect/unstable/http/HttpRouter";
/**
 * A second application assembly with custom native HTTP handlers: the
 * suite's middleware, plus one branch-protection rule. This is the
 * reference for "a rule about refs": an application policy is an ordinary effect
 * over the parsed updates, it reads what the middleware put in context,
 * and it never sees a credential.
 *
 * Lives in its own module (not `stack.ts`) because a Worker's generated
 * entry imports its `main` module's DEFAULT export — one Worker class
 * per entry module.
 */
import * as Cloudflare from "@/Cloudflare";
import * as GitHttp from "@/Git/Http.ts";
import * as Git from "@/Git/index.ts";
import {
  ApiHandlersLive,
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  HasherInline,
  RegistryDurableObject,
  ReposDurableObject,
} from "@/Git/index.ts";
import * as Http from "@/Http/index.ts";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { GitHubLive } from "./http.ts";
import { TestAuthLive, TestCaller } from "./test-auth.ts";

/** Ordinary request effects: policies retain the middleware's typed caller. */
const protectMain = (
  repo: Git.RepoMetaData,
  updates: ReadonlyArray<Git.RefUpdate>,
) =>
  Effect.gen(function* () {
    const { user } = yield* TestCaller;
    for (const update of updates) {
      if (update.ref === "refs/heads/main" && user?.id !== repo.owner) {
        return yield* new Git.PushDenied({
          ref: update.ref,
          reason: "not permitted: only the owner moves main",
        });
      }
    }
  });

const ProtocolLive = HttpApiBuilder.group(Git.Api, "protocol", (h) =>
  Effect.gen(function* () {
    const handlers = yield* Git.Handlers;
    const git = yield* Git.Engine;
    return h
      .handleRaw("infoRefs", handlers.protocol.infoRefs)
      .handleRaw("uploadPack", handlers.protocol.uploadPack)
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
              yield* protectMain(repo, push.updates);
              const prepared = yield* git.preparePush(repo, push.input);
              for (const update of prepared.updates) {
                if (/^0+$/.test(update.newOid)) continue;
                const object = yield* prepared.readObject(update.newOid);
                if (object?.type === 1) {
                  const commit = yield* Git.parseCommit(object.content).pipe(
                    Effect.orDie,
                  );
                  if (commit.message.includes("[reject-content]"))
                    return yield* new Git.PushDenied({
                      ref: update.ref,
                      reason: "commit rejected by content policy",
                    });
                }
              }
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

const RefsLive = HttpApiBuilder.group(Git.Api, "refs", (h) =>
  Effect.gen(function* () {
    const handlers = yield* Git.Handlers;
    const git = yield* Git.Engine;
    return h.handleAll({
      ...handlers.refs,
      update: (input) =>
        Effect.gen(function* () {
          const repo = yield* git.repositories
            .get(input.params)
            .pipe(Effect.catchTag("StoreError", Effect.die));
          const current = yield* git.refs.get(repo, input.query.name).pipe(
            Effect.map((ref) => ref.oid),
            Effect.catchTag("RefNotFound", () =>
              Effect.succeed("0".repeat(40)),
            ),
            Effect.catchTag("StoreError", Effect.die),
          );
          yield* protectMain(repo, [
            {
              ref: input.query.name,
              oldOid: current,
              newOid: input.payload.newOid,
            },
          ]);
          return yield* handlers.refs.update({
            ...input,
            payload: {
              ...input.payload,
              expectedOid:
                input.payload.expectedOid !== undefined
                  ? input.payload.expectedOid
                  : current === "0".repeat(40)
                    ? null
                    : (current as Git.Oid),
            },
          });
        }),
      remove: (input) =>
        Effect.gen(function* () {
          const repo = yield* git.repositories
            .get(input.params)
            .pipe(Effect.catchTag("StoreError", Effect.die));
          const current = yield* git.refs
            .get(repo, input.query.name)
            .pipe(Effect.catchTag("StoreError", Effect.die));
          yield* protectMain(repo, [
            {
              ref: input.query.name,
              oldOid: current.oid,
              newOid: "0".repeat(40),
            },
          ]);
          return yield* handlers.refs.remove({
            ...input,
            payload: {
              expectedOid:
                input.payload.expectedOid ?? (current.oid as Git.Oid),
            },
          });
        }),
    });
  }),
);

const PullsLive = HttpApiBuilder.group(Git.Api, "pulls", (h) =>
  Effect.gen(function* () {
    const handlers = yield* Git.Handlers;
    const git = yield* Git.Engine;
    return h.handleAll({
      ...handlers.pulls,
      merge: (input) =>
        Effect.gen(function* () {
          const repo = yield* git.repositories
            .get(input.params)
            .pipe(Effect.catchTag("StoreError", Effect.die));
          const pull = yield* git.pulls
            .get(repo, input.params.number)
            .pipe(Effect.catchTag("StoreError", Effect.die));
          yield* protectMain(repo, [
            {
              ref: pull.baseRef,
              oldOid: pull.baseOid ?? "0".repeat(40),
              newOid: pull.headOid ?? "0".repeat(40),
            },
          ]);
          return yield* handlers.pulls.merge(input);
        }),
    });
  }),
);

const ProtectedRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(Git.Api).pipe(
    Layer.provide(
      Layer.mergeAll(
        Git.GroupsLive,
        GitHubLive,
        ProtocolLive,
        RefsLive,
        PullsLive,
      ),
    ),
    Layer.provide(TestAuthLive),
  ),
  Git.InternalApiLive,
).pipe(Layer.provide(Http.Platform));

/** This assembly's bucket (its own stack, so no clash with `stack.ts`). */
const GitObjects = Cloudflare.R2.Bucket("GitObjects");

const ProtectedGitLive = ProtectedRoutes.pipe(
  Layer.provide(ApiHandlersLive),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreR2(GitObjects)),
);

/** Identical to the shared fixture's host except for the policy. */
export default class ProtectedGitHost extends Cloudflare.Worker<ProtectedGitHost>()(
  "GitProtectedWorker",
  {
    main: import.meta.url,
    ...GIT_WORKER_OPTIONS,
  },
  Effect.gen(function* () {
    const fetch = yield* HttpRouter.toHttpEffect(ProtectedGitLive);
    return { fetch };
  }),
) {}

/** Deployable stack for the protected-branch test. */
export const makeProtectedStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const host = yield* ProtectedGitHost;
      return { url: host.url.as<string>() };
    }),
  );
