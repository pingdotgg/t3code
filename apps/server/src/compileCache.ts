import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class CompileCacheFlushError extends Schema.TaggedError<CompileCacheFlushError>()(
  "CompileCacheFlushError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not flush the module compile cache.";
  }
}

// Windows force-kills on quit; persist the cache after startup.
export const flushCompileCache = Effect.try({
  try: () => {
    if (!Reflect.get(globalThis, Symbol.for("t3code.preparedServerCache"))) {
      NodeModule.flushCompileCache();
    }
  },
  catch: (cause) => new CompileCacheFlushError({ cause }),
}).pipe(Effect.ignore);
