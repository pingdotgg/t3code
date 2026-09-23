import { Credentials } from "@distilled.cloud/hetzner";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Zone } from "./Zone.ts";

/**
 * Shared scaffolding for the HTTP-backed Hetzner DNS bindings.
 *
 * Hetzner Cloud tokens are project-scoped (`HCLOUD_TOKEN`) and issued
 * read-write or read-only — there is no per-permission token API. This
 * layer captures the ambient credentials available during stack-eval and
 * builds a {@link DnsAuth} that provides them to distilled RRSet ops. The
 * zone is fixed at `bind(zone)` time so callers never pass `id_or_name`.
 *
 * NOT exported from `index.ts`.
 */
export const makeHttpDnsBinding = <Client>(options: {
  makeClient: (auth: DnsAuth, zoneId: Effect.Effect<number>) => Client;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (zone: Zone) {
      const zoneId = yield* zone.zoneId;
      const auth: DnsAuth = {
        authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      };
      return options.makeClient(auth, zoneId);
    });
  });

/**
 * Injectable auth for the DNS HTTP client builders. Supplies an `authorize`
 * that provides `Credentials` + `HttpClient` to a raw SDK op.
 */
export interface DnsAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}
