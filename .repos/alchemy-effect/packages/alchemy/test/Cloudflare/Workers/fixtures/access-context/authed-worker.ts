import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Worker with a simulated Cloudflare Access identity (`dev.access`): under
 * `alchemy dev`, `ctx.access` is defined and `getIdentity()` resolves the
 * configured identity.
 */
export default class AuthedAccessWorker extends Cloudflare.Worker<AuthedAccessWorker>()(
  "AuthedAccessWorker",
  {
    main: import.meta.url,
    dev: {
      access: {
        aud: "test-aud",
        identity: {
          email: "dev@alchemy.test",
          groups: [{ id: "g1", name: "devs" }],
        },
      },
    },
  },
  Effect.gen(function* () {
    const exec = yield* Cloudflare.WorkerExecutionContext;
    return {
      fetch: Effect.gen(function* () {
        const access = yield* exec.access;
        if (access === undefined) {
          return yield* HttpServerResponse.json({ authenticated: false });
        }
        const identity = yield* access.getIdentity().pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          authenticated: true,
          aud: access.aud,
          email: identity?.email,
          groups: identity?.groups,
        });
      }),
    };
  }),
) {}
