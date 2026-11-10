import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalDnsBinding } from "./DnsLocal.ts";
import { WriteDns } from "./WriteDns.ts";
import { dnsWriteClient } from "./WriteDnsHttp.ts";

/**
 * Local implementation of the {@link WriteDns} binding — creates, updates, and
 * deletes Cloudflare DNS records over the HTTP API using the **current
 * credentials** instead of a scoped API token ({@link WriteDnsHttp}). DNS is a
 * zone-management capability with no native Worker binding.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can mutate
 * a zone's DNS records with the same
 * `createDnsRecord`/`updateDnsRecord`/`deleteDnsRecord`/`batchDnsRecords`
 * client you'd use inside a Worker:
 *
 * @example Creating a record from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const dns = yield* Cloudflare.DNS.WriteDns(zone);
 *     return Effect.fn(function* () {
 *       return yield* dns.createDnsRecord({
 *         type: "TXT",
 *         name: "_seed.example.com",
 *         content: '"hello"',
 *         ttl: 60,
 *       });
 *     });
 *   }).pipe(Effect.provide(Cloudflare.DNS.WriteDnsLocal)),
 * );
 * ```
 *
 * The zone id is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `WriteDns(zone)` works even though the zone may
 * be created/adopted in the same deploy.
 */
export const WriteDnsLocal = Layer.effect(
  WriteDns,
  Effect.suspend(() => makeLocalDnsBinding({ makeClient: dnsWriteClient })),
);
