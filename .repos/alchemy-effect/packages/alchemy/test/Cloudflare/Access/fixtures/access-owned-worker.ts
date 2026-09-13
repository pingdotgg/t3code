import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Worker protected by a **dedicated** Access application declared through
 * the `access.policies` form — no Application resource in sight. The
 * application is auto-declared in the Worker's namespace
 * (`OwnedAccessWorker/Access`).
 */
export default class OwnedAccessWorker extends Cloudflare.Worker<OwnedAccessWorker>()(
  "OwnedAccessWorker",
  {
    main: import.meta.url,
    access: {
      name: "Access for alchemy owned-app test",
      // Production traffic only — preview URLs stay open.
      previews: false,
      policies: [
        {
          decision: "allow",
          include: [{ emailDomain: "example.com" }],
        },
      ],
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const access = yield* Cloudflare.Access.Context;
        return yield* HttpServerResponse.json({
          marker: "alchemy-access-owned-open",
          authenticated: access !== undefined,
        });
      }),
    };
  }),
) {}
