import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";

// Desktop enables this cache before loading the backend. Windows force-kills
// the backend on quit, so persist it after startup instead of waiting for exit.
// This is a no-op when caching is disabled, including normal dev launches.
export const flushCompileCache = Effect.try(() => NodeModule.flushCompileCache()).pipe(
  Effect.ignore,
);
