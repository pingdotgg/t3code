import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Binds {@link Cloudflare.Access.GetIdentityProvider} so the deployed Worker
 * can look up an Access IdP at runtime through the scoped token the binding
 * mints and attaches.
 */
export default class IdpLookupWorker extends Cloudflare.Worker<IdpLookupWorker>()(
  "IdpLookupWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // The test's stage-derived IdP name, read at deploy time and bound into
    // the Worker as a plain-text variable.
    const name = yield* Config.String("IDP_LOOKUP_NAME");
    const findIdp = yield* Cloudflare.Access.GetIdentityProvider({ name });

    return {
      fetch: Effect.gen(function* () {
        const idp = yield* findIdp().pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          identityProviderId: idp?.identityProviderId ?? null,
          type: idp?.type ?? null,
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Access.GetIdentityProviderHttp)),
) {}
