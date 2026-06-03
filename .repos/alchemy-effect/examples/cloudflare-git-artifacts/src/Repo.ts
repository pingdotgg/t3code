import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export type Metadata = {
  description: string;
  topics: string[];
  stars: number;
  createdAt: number;
};

export default class Repo extends Cloudflare.DurableObjectNamespace<Repo>()(
  "Repo",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let meta = (yield* state.storage.get<Metadata>("meta")) ?? null;

      const ensure = Effect.gen(function* () {
        if (meta === null) {
          return yield* Effect.fail(new Error("repo not initialized"));
        }
        return meta;
      });

      return {
        init: (description: string) =>
          Effect.gen(function* () {
            if (meta !== null) return meta;
            meta = {
              description,
              topics: [],
              stars: 0,
              createdAt: Date.now(),
            };
            yield* state.storage.put("meta", meta);
            return meta;
          }),
        get: () => ensure,
        update: (patch: Partial<Pick<Metadata, "description" | "topics">>) =>
          Effect.gen(function* () {
            const current = yield* ensure;
            meta = { ...current, ...patch };
            yield* state.storage.put("meta", meta);
            return meta;
          }),
        star: () =>
          Effect.gen(function* () {
            const current = yield* ensure;
            meta = { ...current, stars: current.stars + 1 };
            yield* state.storage.put("meta", meta);
            return meta;
          }),
      };
    });
  }),
) {}
