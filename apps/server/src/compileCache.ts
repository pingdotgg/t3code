import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";

// Windows force-kills the backend on quit, so persist it after startup instead
// of waiting for exit.
export const flushCompileCache = Effect.try(() => NodeModule.flushCompileCache()).pipe(
  Effect.ignore,
);
