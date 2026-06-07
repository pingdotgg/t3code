import * as Layer from "effect/Layer";
import * as Headers from "effect/unstable/http/Headers";

export const redactedHttpHeaderNames = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "dpop",
] as const;

export const httpHeaderRedactionLayer = Layer.succeed(
  Headers.CurrentRedactedNames,
  redactedHttpHeaderNames,
);
