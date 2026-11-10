import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalDnsBinding } from "./DnsLocal.ts";
import { ReadDns } from "./ReadDns.ts";
import { dnsReadClient } from "./ReadDnsHttp.ts";

/**
 * Local implementation of the {@link ReadDns} binding — reads Cloudflare DNS
 * records over the HTTP API using the **current credentials** instead of a
 * scoped API token ({@link ReadDnsHttp}). DNS is a zone-management capability
 * with no native Worker binding.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can read a
 * zone's DNS records with the same `getDnsRecord`/`listDnsRecords` client you'd
 * use inside a Worker:
 *
 * @example Reading records from an Action
 * ```typescript
 * const Check = Alchemy.Action(
 *   "Check",
 *   Effect.gen(function* () {
 *     const dns = yield* Cloudflare.DNS.ReadDns(zone);
 *     return Effect.fn(function* () {
 *       return yield* dns.listDnsRecords({ type: "TXT" });
 *     });
 *   }).pipe(Effect.provide(Cloudflare.DNS.ReadDnsLocal)),
 * );
 * ```
 *
 * The zone id is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `ReadDns(zone)` works even though the zone may
 * be created/adopted in the same deploy.
 */
export const ReadDnsLocal = Layer.effect(
  ReadDns,
  Effect.suspend(() => makeLocalDnsBinding({ makeClient: dnsReadClient })),
);
