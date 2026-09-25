/**
 * The Repository block's seams, as the docs show them: a route of your
 * own over `Git.GitRepo`, and a decorated namespace that logs commits.
 * Compile-checked against the real types; run against a fake stub.
 */
import * as Git from "@/Git/index.ts";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeContext } from "@/RuntimeContext.ts";

// ── a route of your own ──────────────────────────────────────────────────────

export const Tip = HttpApiEndpoint.get(
  "tip",
  "/api/v1/repos/:owner/:repo/tip",
  {
    params: Git.RepoPath,
    success: Git.Ref,
    error: [Git.RepoNotFound, Git.RefNotFound],
  },
);

class TipApi extends HttpApi.make("tip").add(
  HttpApiGroup.make("tip").add(Tip),
) {}

export const TipLive = HttpApiBuilder.group(TipApi, "tip", (h) =>
  Effect.gen(function* () {
    const registry = yield* Git.RegistryStore;
    const repos = yield* Git.RepoStore;
    return h.handle(
      "tip",
      Effect.fn(function* ({ params }) {
        const entry = yield* registry
          .resolve(params.owner, params.repo)
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        if (entry === undefined) return yield* new Git.RepoNotFound(params);
        const repo = repos.getByName(entry.repoId);
        const meta = yield* repo
          .getRepoMeta()
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        const ref = yield* repo
          .getRef(`refs/heads/${meta.defaultBranch}`)
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        return new Git.Ref({
          name: ref.name,
          oid: ref.oid as Git.Oid,
          ...(ref.peeled === null ? {} : { peeled: ref.peeled as Git.Oid }),
        });
      }),
    );
  }),
);

// ── wrap it ──────────────────────────────────────────────────────────────────

const seen: Array<{ repoId: string; refs: ReadonlyArray<string> }> = [];

const afterPush = (repoId: string, result: Git.CommitPushResult) =>
  Effect.sync(() => {
    seen.push({ repoId, refs: result.results.map((r) => r.ref) });
  });

export const ReposWithLogging = Layer.effect(
  Git.RepoStore,
  Effect.map(Git.RepoStore, (repos) => ({
    getByName: (repoId) => {
      const stub = repos.getByName(repoId);
      return new Proxy(stub, {
        get: (target, key, receiver) =>
          key === "commitPush"
            ? (input: Git.CommitPushInput) =>
                target
                  .commitPush(input)
                  .pipe(Effect.tap((result) => afterPush(repoId, result)))
            : Reflect.get(target, key, receiver),
      });
    },
  })),
);

describe("Repository seams", () => {
  it.effect("a decorated namespace observes every commitPush", () =>
    Effect.gen(function* () {
      const fakeStub = {
        commitPush: () =>
          Effect.succeed({
            unpack: "ok",
            results: [{ ref: "refs/heads/main", status: "ok" }],
          }),
        readMeta: () => Effect.succeed(undefined),
      };
      const FakeRepos = Layer.succeed(Git.RepoStore, {
        getByName: () => fakeStub as never,
      });

      const repos = yield* Git.RepoStore.pipe(
        Effect.provide(ReposWithLogging.pipe(Layer.provide(FakeRepos))),
      );
      const stub = repos.getByName("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const result = yield* stub.commitPush({} as Git.CommitPushInput);
      expect(result.unpack).toBe("ok");
      // other methods pass through the proxy untouched
      expect(yield* stub.readMeta()).toBeUndefined();
      expect(seen).toEqual([
        { repoId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", refs: ["refs/heads/main"] },
      ]);
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );
});
