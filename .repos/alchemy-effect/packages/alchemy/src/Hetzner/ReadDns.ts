import type {
  GetZoneRrsetError,
  GetZoneRrsetResponse,
  ListZoneRrsetsError,
  ListZoneRrsetsRequest,
  ListZoneRrsetsResponse,
} from "@distilled.cloud/hetzner/zone_rrsets";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Zone } from "./Zone.ts";

/**
 * Binding that lets runtime code read Hetzner Cloud DNS RRSets.
 *
 * Authenticates with the ambient `HCLOUD_TOKEN` (a project-scoped Cloud
 * API token). The zone is fixed by `ReadDns(zone)` so calls take no
 * zone id. Provide {@link ReadDnsHttp} on the Action / Function Effect.
 *
 *
 * ### Reading RRSets at runtime
 * **Example:** List and get RRSets from an Action
 * Bind the client in the Action's Init phase and provide {@link ReadDnsHttp}.
 * Pass the {@link Zone} resource directly (it's an `Effect`), or
 * `yield* Zone` for a resolved value.
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Hetzner from "alchemy/Hetzner";
 * import * as Effect from "effect/Effect";
 *
 * const Check = Alchemy.Action(
 *   "Check",
 *   Effect.gen(function* () {
 *     const dns = yield* Hetzner.ReadDns(zone);
 *     return Effect.fn(function* () {
 *       const listed = yield* dns.listRecordSets({ type: ["A"] });
 *       const rrset = yield* dns.getRecordSet("www", "A");
 *       return { listed, rrset };
 *     });
 *   }).pipe(Effect.provide(Hetzner.ReadDnsHttp)),
 * );
 * ```
 *
 * @binding
 */
export interface ReadDns extends Binding.Service<
  ReadDns,
  "Hetzner.DNS.ReadDns",
  (zone: Zone) => Effect.Effect<ReadDnsClient>
> {}

export const ReadDns = Binding.Service<ReadDns>("Hetzner.DNS.ReadDns");

/** List-RRSets request, minus the zone id (bound at `ReadDns(zone)` time). */
export type ListRecordSetsRequestInput = Omit<
  ListZoneRrsetsRequest,
  "id_or_name"
>;

/**
 * Read-only DNS RRSet operations. The zone is fixed when the client is
 * bound, so no `id_or_name` is passed per call.
 */
export interface ReadDnsClient {
  /** Fetch a single RRSet by name and type. */
  getRecordSet(
    name: string,
    type: string,
  ): Effect.Effect<GetZoneRrsetResponse, GetZoneRrsetError, RuntimeContext>;
  /** List RRSets in the bound zone. */
  listRecordSets(
    request?: ListRecordSetsRequestInput,
  ): Effect.Effect<ListZoneRrsetsResponse, ListZoneRrsetsError, RuntimeContext>;
}
