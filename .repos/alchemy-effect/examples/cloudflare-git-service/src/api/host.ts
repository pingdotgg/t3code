import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Git from "@alchemy.run/git";
import * as Effect from "effect/Effect";
/**
 * The Worker that serves the API: Better Auth's routes under `/api/auth`,
 * the git server for everything else. `src/worker.ts` fronts it on the
 * website's origin.
 */
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { Auth, AuthDb } from "./auth.ts";
import { HttpLive } from "./git.ts";

export default class GitHost extends Cloudflare.Worker<GitHost>()(
  "GitHost",
  {
    main: import.meta.url,
    ...Git.GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const auth = yield* Auth;
    const fetch = yield* HttpRouter.toHttpEffect(HttpLive);
    return {
      fetch: Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          if (request.url.startsWith("/api/auth")) return yield* auth.fetch;
          return yield* fetch;
        }),
      ),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(CloudflareD1(AuthDb), Cloudflare.R2.ReadWriteBucketBinding)),
  ),
) {}
