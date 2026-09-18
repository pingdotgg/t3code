/** Authorization and commit stay in the request effect, across every write transport. */
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { AppApi } from "./api.ts";
import { checkRefChanges } from "./branch-policy.ts";

export const RefsLive = HttpApiBuilder.group(AppApi, "refs", (h) =>
  Effect.gen(function* () {
    const git = yield* Git.Engine;
    const defaults = yield* Git.Handlers;
    return h.handleAll({
      ...defaults.refs,
      update: ({ params, query, payload }) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (/^0+$/.test(payload.newOid))
              return yield* new Git.PushDenied({
                ref: query.name,
                reason: "use the DELETE endpoint to remove a ref",
              });
            const repo = yield* git.repositories.get(params);
            const prepared = yield* git.prepareRefUpdate(repo, {
              ref: query.name,
              ...payload,
            });
            yield* checkRefChanges(repo, prepared.updates);
            const result = yield* prepared.commit;
            if (result === undefined)
              return yield* new Git.PushDenied({
                ref: query.name,
                reason: "use the DELETE endpoint to remove a ref",
              });
            return new Git.Ref({
              name: result.name,
              oid: result.oid as Git.Oid,
            });
          }),
        ).pipe(Effect.catchTag("StoreError", Effect.die)),
      remove: ({ params, query, payload }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* git.repositories.get(params);
            const prepared = yield* git.prepareRefRemoval(repo, {
              ref: query.name,
              ...payload,
            });
            yield* checkRefChanges(repo, prepared.updates);
            yield* prepared.commit;
          }),
        ).pipe(Effect.catchTag("StoreError", Effect.die)),
    });
  }),
);

/** Used by both the typed REST endpoint and the GitHub facade. */
export const mergePull = (
  git: Effect.Success<typeof Git.Engine>,
  params: { owner: string; repo: string; number: number },
  input: { message?: string; expectedHeadOid?: string },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const repo = yield* git.repositories.get(params);
      const prepared = yield* git.prepareMerge(repo, {
        number: params.number,
        ...input,
      });
      yield* checkRefChanges(repo, prepared.updates);
      return yield* prepared.commit;
    }),
  ).pipe(Effect.catchTag("StoreError", Effect.die));

export const PullsLive = HttpApiBuilder.group(AppApi, "pulls", (h) =>
  Effect.gen(function* () {
    const defaults = yield* Git.Handlers;
    const git = yield* Git.Engine;
    return h.handleAll({
      ...defaults.pulls,
      merge: ({ params, payload }) =>
        mergePull(git, params, payload).pipe(
          Effect.map(
            (result) =>
              new Git.MergeResult({
                ...result,
                oid: result.oid as Git.Oid,
                pull: new Git.Pull({
                  ...result.pull,
                  mergeCommit: result.pull.mergeCommit as Git.Oid | null,
                }),
              }),
          ),
        ),
    });
  }),
);
