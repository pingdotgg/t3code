import * as Effect from "effect/Effect";
import { FrameworkServerError } from "./Server.ts";

/**
 * Loads `@alchemy.run/frontend-frameworks/core` when a website is built or
 * served. The package is an optional peer dependency, so provider entrypoints
 * that re-export their `Website` namespace (e.g. `alchemy/Prisma`) must not
 * import it statically — that would break every consumer that never deploys a
 * website and so never installed it.
 */
export const loadFrontendCore = Effect.tryPromise({
  try: () => import("@alchemy.run/frontend-frameworks/core"),
  catch: (cause) =>
    new FrameworkServerError({
      framework: "@alchemy.run/frontend-frameworks/core",
      message:
        'Failed to import "@alchemy.run/frontend-frameworks/core". ' +
        "Install @alchemy.run/frontend-frameworks in your project to deploy a website.",
      cause,
    }),
}).pipe(Effect.orDie);
