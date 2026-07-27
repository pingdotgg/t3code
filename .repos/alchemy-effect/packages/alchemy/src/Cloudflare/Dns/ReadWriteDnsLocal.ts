import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalDnsBinding } from "./DnsLocal.ts";
import { ReadWriteDns } from "./ReadWriteDns.ts";
import { dnsReadWriteClient } from "./ReadWriteDnsHttp.ts";

/**
 * Local implementation of the {@link ReadWriteDns} binding — performs the full
 * Cloudflare DNS record CRUD surface over the HTTP API using the **current
 * credentials** instead of a scoped API token ({@link ReadWriteDnsHttp}). DNS
 * is a zone-management capability with no native Worker binding.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can manage
 * a zone's DNS records with the same read + write client you'd use inside a
 * Worker:
 *
 * @example Seeding and reading records from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const dns = yield* Cloudflare.DNS.ReadWriteDns(zone);
 *     return Effect.fn(function* () {
 *       const created = yield* dns.createDnsRecord({
 *         type: "TXT",
 *         name: "_seed.example.com",
 *         content: '"hello"',
 *         ttl: 60,
 *       });
 *       const record = yield* dns.getDnsRecord(created.id);
 *       yield* dns.deleteDnsRecord(created.id);
 *       return record;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.DNS.ReadWriteDnsLocal)),
 * );
 * ```
 *
 * The zone id is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `ReadWriteDns(zone)` works even though the zone
 * may be created/adopted in the same deploy.
 */
export const ReadWriteDnsLocal = Layer.effect(
  ReadWriteDns,
  Effect.suspend(() => makeLocalDnsBinding({ makeClient: dnsReadWriteClient })),
);
