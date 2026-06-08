import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/unstable/http/Headers";

export const httpHeaderRedactionLayer = Layer.effect(
  Headers.CurrentRedactedNames,
  Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop"]),
);
