import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";

export const layer = Layer.effect(
  Headers.CurrentRedactedNames,
  // `expo-session` carries the `eas login` session secret on Expo API requests.
  Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop", "expo-session"]),
);
