import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Headers from "effect/http/Headers";

export const layer = Layer.effect(
  Headers.CurrentRedactedNames,
  // `expo-session` carries the `eas login` session secret on Expo API requests.
  Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop", "expo-session"]),
);

/** Query parameters that carry credentials: socket tickets and proofs, pairing tokens, OAuth codes. */
const REDACTED_URL_PARAMS = /(^|[?&])(wsTicket|dpop|token|pairingUrl|code|state|challenge)=[^&#]*/g;

const redactUrlAttribute = (key: string, value: unknown): unknown =>
  (key === "url.full" || key === "url.query") && typeof value === "string"
    ? value.replace(REDACTED_URL_PARAMS, "$1$2=REDACTED")
    : value;

/** Effect's HTTP client and server spans record `url.full` and `url.query` verbatim. */
export const redactUrlAttributes = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => attribute(key, redactUrlAttribute(key, value));
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
