import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class EnvironmentQueryStore extends Context.Reference<{
  readonly load: (
    environmentId: EnvironmentId,
    key: string,
  ) => Effect.Effect<Option.Option<string>>;
  readonly save: (
    environmentId: EnvironmentId,
    key: string,
    payload: string,
  ) => Effect.Effect<void>;
} | null>("@t3tools/client-runtime/EnvironmentQueryStore", {
  defaultValue: () => null,
}) {}

export interface QueryPersistence<A> {
  readonly load: (environmentId: EnvironmentId, key: string) => Effect.Effect<Option.Option<A>>;
  readonly save: (environmentId: EnvironmentId, key: string, value: A) => Effect.Effect<void>;
}

export function persistQuery<A, I>(schema: Schema.Codec<A, I>): QueryPersistence<A> {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  return {
    load: (environmentId, key) =>
      Effect.gen(function* () {
        const store = yield* EnvironmentQueryStore;
        if (store === null) return Option.none<A>();
        const stored = yield* store.load(environmentId, key);
        if (Option.isNone(stored)) return Option.none<A>();
        return yield* Schema.decodeUnknownEffect(codec)(stored.value).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeedNone),
        );
      }),
    save: (environmentId, key, value) =>
      Effect.gen(function* () {
        const store = yield* EnvironmentQueryStore;
        if (store === null) return;
        const payload = yield* Schema.encodeEffect(codec)(value);
        yield* store.save(environmentId, key, payload);
      }).pipe(Effect.catch(() => Effect.logWarning("Offline query cache save failed"))),
  };
}
