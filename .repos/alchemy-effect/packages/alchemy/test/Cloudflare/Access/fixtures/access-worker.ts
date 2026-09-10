import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The Access application this Worker enrolls into — policies authored
 * inline (application-owned), no separate Policy resource.
 */
export const App = Cloudflare.Access.Application("WorkerAccessApp", {
  type: "self_hosted",
  name: "Access for alchemy worker-enrollment test",
  policies: [
    {
      decision: "allow",
      include: [{ emailDomain: "example.com" }],
    },
  ],
});

/**
 * Worker protected by Access via the `access` prop: the provider enrolls it
 * into {@link App} (worker + preview destinations). The fetch handler
 * serves a marker body plus its `ctx.access` view, so the test can
 * distinguish "worker answered directly" from "Access intercepted".
 */
export default class AccessProtectedWorker extends Cloudflare.Worker<AccessProtectedWorker>()(
  "AccessProtectedWorker",
  {
    main: import.meta.url,
    access: App,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const access = yield* Cloudflare.Access.Context;
        const identity =
          access === undefined
            ? undefined
            : yield* access.getIdentity().pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          marker: "alchemy-access-worker-open",
          authenticated: access !== undefined,
          aud: access?.aud,
          email: identity?.email,
        });
      }),
    };
  }),
) {}
