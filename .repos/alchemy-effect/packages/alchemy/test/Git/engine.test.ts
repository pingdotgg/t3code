import { describe, expect, it } from "alchemy-test";
import * as Git from "@/Git/index.ts";
import * as GitHttp from "@/Git/Http.ts";
import * as Http from "@/Http/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { gzipSync } from "node:zlib";
import * as Result from "effect/Result";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { concatBytes } from "@/Git/Protocol/ObjectCodec.ts";
import { pktText, flushPkt } from "@/Git/Protocol/Pkt.ts";
import { makeMemoryBlobStore } from "./harness/store.ts";

const oid = "a".repeat(40);
const zero = "0".repeat(40);
const meta: Git.RepoMetaData = {
  repoId: "repo",
  owner: "alice",
  name: "demo",
  defaultBranch: "main",
  description: null,
  readOnly: false,
  public: false,
  forkOf: null,
  status: "ready",
  createdAt: 0,
  lastPush: null,
  objects: { loose: 0, resident: 0, packed: 0, r2: 0, bytes: 0 },
};
const request = () =>
  HttpServerRequest.fromWeb(
    new Request("http://test/alice/demo.git/git-receive-pack", {
      method: "POST",
      body: Buffer.from(
        concatBytes([
          pktText(`${zero} ${oid} refs/heads/main\0report-status atomic`),
          flushPkt,
        ]),
      ),
    }),
  );

const fixture = Effect.gen(function* () {
  const calls = {
    begin: 0,
    abort: 0,
    commit: 0,
    update: undefined as unknown,
    merge: undefined as unknown,
  };
  const stub = {
    getRepoMeta: () => Effect.succeed(meta),
    beginPush: () =>
      Effect.sync(() => {
        calls.begin++;
        return { _tag: "ok" as const, pushId: "push" };
      }),
    abortPush: () =>
      Effect.sync(() => {
        calls.abort++;
        return true;
      }),
    validatePush: () => Effect.void,
    readPreparedObject: () =>
      Effect.succeed({
        type: 1 as const,
        content: new TextEncoder().encode("commit"),
      }),
    commitPush: (input: Git.CommitPushInput) =>
      Effect.sync(() => {
        calls.commit++;
        return {
          unpack: "ok",
          results: input.commands.map((c) => ({ ref: c.ref, ok: true })),
        };
      }),
    getRef: () => Effect.fail(new Git.RefNotFound({ ref: "refs/heads/main" })),
    updateRef: (input: unknown) =>
      Effect.sync(() => {
        calls.update = input;
        return { name: "refs/heads/main", oid };
      }),
    getPull: () =>
      Effect.succeed({
        baseRef: "refs/heads/main",
        headRef: "refs/heads/feature",
        baseOid: oid,
        headOid: "b".repeat(40),
      }),
    mergePull: (input: unknown) =>
      Effect.sync(() => {
        calls.merge = input;
        return {};
      }),
  };
  const engineLayer = Git.EngineLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Git.RepoStore, { getByName: () => stub as never }),
        Layer.succeed(Git.RegistryStore, {
          resolve: () => Effect.succeed({ repoId: "repo", deletedAt: null }),
        } as never),
        Git.HasherInline,
      ),
    ),
    Layer.provide(Layer.succeed(Git.BlobStore, makeMemoryBlobStore())),
  );
  const engine = yield* Git.Engine.pipe(Effect.provide(engineLayer));
  return { engine, engineLayer, calls };
});

describe("Git operations and native HTTP middleware", () => {
  it.effect("accepts raw pack streams without an HTTP request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, calls } = yield* fixture;
        const pack = new Uint8Array(
          yield* Effect.promise(() =>
            Bun.file(
              new URL("./fixtures/packs/empty.pack", import.meta.url),
            ).arrayBuffer(),
          ),
        );
        const input = yield* Git.Push.fromStream(
          [{ ref: "refs/heads/main", oldOid: zero, newOid: oid }],
          Stream.make(pack),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* engine.preparePush(meta, input);
            yield* engine.commitPush(prepared);
          }),
        );
        expect(calls.commit).toBe(1);
        const invalid = yield* Effect.result(
          Git.Push.fromStream(
            [{ ref: "bad ref", oldOid: zero, newOid: oid }],
            Stream.empty,
          ),
        );
        expect(Result.isFailure(invalid)).toBe(true);
        const truncated = yield* Git.Push.fromStream(
          [{ ref: "refs/heads/main", oldOid: zero, newOid: oid }],
          Stream.make(new Uint8Array([0x50, 0x41, 0x43, 0x4b])),
        );
        const failure = yield* Effect.result(
          engine.preparePush(meta, truncated),
        );
        expect(failure).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "StoreError", reason: "truncated pack header" },
        });
        expect(calls.commit).toBe(1);
      }),
    ).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect("decodes gzip incrementally and recognizes Git's empty probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const compressed = HttpServerRequest.fromWeb(
          new Request("http://test/push", {
            method: "POST",
            headers: { "content-encoding": "gzip" },
            body: gzipSync(
              Buffer.from(
                concatBytes([
                  pktText(`${zero} ${oid} refs/heads/main\0report-status`),
                  flushPkt,
                ]),
              ),
            ),
          }),
        );
        const decoded = yield* GitHttp.ReceivePack.decode(compressed);
        expect(decoded._tag).toBe("Push");
        const probe = yield* GitHttp.ReceivePack.decode(
          HttpServerRequest.fromWeb(
            new Request("http://test/push", { method: "POST", body: "0000" }),
          ),
        );
        expect(probe._tag).toBe("Probe");
        const malformed = yield* Effect.result(
          GitHttp.ReceivePack.decode(
            HttpServerRequest.fromWeb(
              new Request("http://test/push", { method: "POST", body: "xxxx" }),
            ),
          ),
        );
        expect(Result.isFailure(malformed)).toBe(true);
      }),
    ),
  );

  it.effect("rejects before staging and encodes a Git report", () =>
    Effect.gen(function* () {
      const { calls } = yield* fixture;
      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const push = yield* GitHttp.ReceivePack.decode(request());
          if (push._tag !== "Push") return yield* Effect.die("expected push");
          return GitHttp.ReceivePack.reject(
            push,
            "database branch is protected",
          );
        }),
      );
      const text = yield* Effect.promise(() =>
        HttpServerResponse.toWeb(response).text(),
      );
      expect(text).toContain("ng refs/heads/main database branch is protected");
      expect(calls.begin).toBe(0);
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "stages, reads objects, aborts on exit, and rejects an escaped transaction",
    () =>
      Effect.gen(function* () {
        const { engine, calls } = yield* fixture;
        const prepared = yield* Effect.scoped(
          Effect.gen(function* () {
            const push = yield* GitHttp.ReceivePack.decode(request());
            if (push._tag !== "Push") return yield* Effect.die("expected push");
            const prepared = yield* engine.preparePush(meta, push.input);
            expect((yield* prepared.readObject(oid))?.type).toBe(1);
            expect(calls.commit).toBe(0);
            return prepared;
          }),
        );
        expect(calls.abort).toBe(1);
        expect(
          Result.isFailure(yield* Effect.result(engine.commitPush(prepared))),
        ).toBe(true);
        expect(
          Result.isFailure(yield* Effect.result(prepared.readObject(oid))),
        ).toBe(true);
        expect(calls.commit).toBe(0);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "commits once, retains committed data, and rejects a second prepare",
    () =>
      Effect.gen(function* () {
        const { engine, calls } = yield* fixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const push = yield* GitHttp.ReceivePack.decode(request());
            if (push._tag !== "Push") return yield* Effect.die("expected push");
            const prepared = yield* engine.preparePush(meta, push.input);
            expect(
              Result.isFailure(
                yield* Effect.result(engine.preparePush(meta, push.input)),
              ),
            ).toBe(true);
            yield* engine.commitPush(prepared);
            expect(
              Result.isFailure(
                yield* Effect.result(engine.commitPush(prepared)),
              ),
            ).toBe(true);
          }),
        );
        expect(calls.commit).toBe(1);
        expect(calls.abort).toBe(0);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "pins ref creation and both merge tips to the inspected state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine, calls } = yield* fixture;
          const ref = yield* engine.prepareRefUpdate(meta, {
            ref: "refs/heads/main",
            newOid: oid,
            expectedOid: null,
          });
          expect(ref.updates[0]?.oldOid).toBe(zero);
          yield* ref.commit;
          expect(calls.update).toEqual({
            name: "refs/heads/main",
            newOid: oid,
            expectedOid: null,
          });
          expect(Result.isFailure(yield* Effect.result(ref.commit))).toBe(true);
          const merge = yield* engine.prepareMerge(meta, { number: 1 });
          yield* merge.commit;
          expect(calls.merge).toMatchObject({
            expectedBaseOid: oid,
            expectedHeadOid: "b".repeat(40),
          });
        }),
      ).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.effect(
    "raw API handlers retain middleware user and database dependencies",
    () =>
      Effect.gen(function* () {
        class User extends Context.Service<User, { id: string }>()(
          "test/push/User",
        ) {}
        class Database extends Context.Service<
          Database,
          { mayWrite: (user: string, ref: string) => Effect.Effect<boolean> }
        >()("test/push/Database") {}
        class Authentication extends HttpApiMiddleware.Service<
          Authentication,
          { provides: User }
        >()("test/push/Auth") {}
        class Api extends HttpApi.make("custom")
          .add(HttpApiGroup.make("git").add(GitHttp.ReceivePack.endpoint))
          .middleware(Authentication) {}
        const seen: Array<string> = [];
        const routes = HttpApiBuilder.layer(Api).pipe(
          Layer.provide(
            HttpApiBuilder.group(Api, "git", (h) =>
              Effect.gen(function* () {
                const db = yield* Database;
                return h.handleRaw("receivePack", ({ request }) =>
                  Effect.scoped(
                    Effect.gen(function* () {
                      const user = yield* User;
                      const push = yield* GitHttp.ReceivePack.decode(
                        request,
                      ).pipe(Effect.orDie);
                      if (push._tag === "Probe")
                        return GitHttp.ReceivePack.probeResponse();
                      yield* db.mayWrite(user.id, push.updates[0]!.ref);
                      return GitHttp.ReceivePack.reject(
                        push,
                        "denied by database",
                      );
                    }),
                  ),
                );
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(Authentication, (effect) =>
              Effect.provideService(effect, User, { id: "alice" }),
            ),
          ),
          Layer.provide(
            Layer.succeed(Database, {
              mayWrite: (user, ref) =>
                Effect.sync(() => {
                  seen.push(`${user}:${ref}`);
                  return false;
                }),
            }),
          ),
          Layer.provide(Http.Platform),
        );
        const fetch = yield* HttpRouter.toHttpEffect(routes);
        const response = yield* fetch.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
        );
        expect(response.status).toBe(200);
        expect(seen).toEqual(["alice:refs/heads/main"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
  );
});
