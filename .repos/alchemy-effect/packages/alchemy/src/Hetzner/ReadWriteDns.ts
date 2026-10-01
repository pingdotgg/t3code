import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Zone } from "./Zone.ts";
import { type ReadDnsClient } from "./ReadDns.ts";
import { type WriteDnsClient } from "./WriteDns.ts";

/**
 * Binding that lets runtime code perform the full Hetzner Cloud DNS RRSet
 * surface (read + write).
 *
 * Authenticates with the ambient `HCLOUD_TOKEN`. The zone is fixed by
 * `ReadWriteDns(zone)` so calls take no zone id. Provide
 * {@link ReadWriteDnsHttp} on the Action / Function Effect.
 *
 *
 * ### Managing RRSets at runtime
 * **Example:** Full CRUD from an Action
 * Bind the client in the Action's Init phase and provide
 * {@link ReadWriteDnsHttp}.
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Hetzner from "alchemy/Hetzner";
 * import * as Effect from "effect/Effect";
 *
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const dns = yield* Hetzner.ReadWriteDns(zone);
 *     return Effect.fn(function* () {
 *       const created = yield* dns.createRecordSet({
 *         name: "app",
 *         type: "A",
 *         records: [{ value: "192.0.2.1" }],
 *         ttl: 300,
 *       });
 *       yield* Hetzner.waitForZoneAction(created.action);
 *       const rrset = yield* dns.getRecordSet("app", "A");
 *       yield* dns.deleteRecordSet("app", "A");
 *       return rrset.rrset.id;
 *     });
 *   }).pipe(Effect.provide(Hetzner.ReadWriteDnsHttp)),
 * );
 * ```
 *
 * @binding
 */
export interface ReadWriteDns extends Binding.Service<
  ReadWriteDns,
  "Hetzner.DNS.ReadWriteDns",
  (zone: Zone) => Effect.Effect<ReadWriteDnsClient>
> {}

export const ReadWriteDns = Binding.Service<ReadWriteDns>(
  "Hetzner.DNS.ReadWriteDns",
);

/** Combined read + write DNS RRSet operations. */
export interface ReadWriteDnsClient extends ReadDnsClient, WriteDnsClient {}
