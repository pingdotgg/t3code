import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The in-VM program for the local MicroVM content-diff test. The test
 * rewrites `MARKER` in a CLONE of this file between two deploys of an
 * otherwise-identical image declaration, so the only thing that changed is
 * the bundled content — which the image's diff must detect.
 */
export const MARKER = "microvm-marker-v1";

export default {
  fetch: Effect.succeed(HttpServerResponse.text(MARKER)),
};
