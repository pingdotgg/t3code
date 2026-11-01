import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";

// Windows force-kills on quit; persist the cache after startup.
export const flushCompileCache = Effect.try(() => {
  if (!Reflect.get(globalThis, Symbol.for("t3code.preparedServerCache"))) {
    NodeModule.flushCompileCache();
  }
}).pipe(Effect.ignore);
