import * as Cloudflare from "@/Cloudflare";
import type { Tag } from "@/Named";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

class A extends Cloudflare.Worker<A, { work: () => Effect.Effect<string> }>()(
  "A",
) {}

class B extends Cloudflare.Worker<B, { work: () => Effect.Effect<string> }>()(
  "B",
) {}

const ALive = A.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const b = yield* Cloudflare.Workers.bindWorker(B);
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(yield* b.work());
      }),
      work: () => Effect.succeed("A handled its half"),
    };
  }),
);

const BLive = B.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const a = yield* Cloudflare.Workers.bindWorker(A);
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(yield* a.work());
      }),
      work: () => Effect.succeed("B handled its half"),
    };
  }),
);

const program = Effect.gen(function* () {
  const a = yield* A;
  const b = yield* B;
  return { aUrl: a.url, bUrl: b.url };
}).pipe(Effect.provide(Layer.mergeAll(ALive, BLive)));

type RequirementsOf<T> =
  T extends Effect.Effect<unknown, unknown, infer Req> ? Req : never;
type LayerRequirementsOf<T> =
  T extends Layer.Layer<infer _A, infer _E, infer Req> ? Req : never;
type Assert<T extends true> = T;

type _CircularWorkersAreProvided = Assert<
  Extract<RequirementsOf<typeof program>, A | B> extends never ? true : false
>;

class UserService extends Context.Service<UserService, {}>()(
  "test/UserService",
) {}

class OtherResource
  extends Context.Service<OtherResource, {}>()("test/OtherResource")
  implements Tag<"Test.Resource">
{
  declare readonly "~alchemy/Tag": "Test.Resource";
}

const RequirementsLive = A.make(
  Effect.gen(function* () {
    yield* UserService;
    yield* OtherResource;
    return { main: import.meta.url };
  }),
  Effect.succeed({
    work: () => Effect.succeed("done"),
  }),
);

type _PreservesNonWorkerRequirements = Assert<
  UserService | OtherResource extends LayerRequirementsOf<
    typeof RequirementsLive
  >
    ? true
    : false
>;
