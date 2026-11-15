import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const SAME_ORIGIN_FRAME_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
};

// The whiteboard frames the app from its own origin; every other site stays refused.
export const spaFrameHeaders = Effect.fn("sameOriginFrame.spaFrameHeaders")(function* (
  upstream: Record<string, string>,
) {
  const environment = yield* HostProcess.Environment;
  return environment.T3CODE_ALLOW_SAME_ORIGIN_FRAME === "1" ? SAME_ORIGIN_FRAME_HEADERS : upstream;
});
