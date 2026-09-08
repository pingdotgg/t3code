import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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
    const findIdp = yield* Cloudflare.Access.GetIdentityProvider({
      name: "alchemy-zt-idp-worker-lookup",
    });

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
