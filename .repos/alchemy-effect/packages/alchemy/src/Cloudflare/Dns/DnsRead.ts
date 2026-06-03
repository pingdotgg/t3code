import type {
  GetRecordError,
  GetRecordResponse,
  ListRecordsError,
  ListRecordsRequest,
  ListRecordsResponse,
} from "@distilled.cloud/cloudflare/dns";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { Zone } from "../Zone/Zone.ts";
import {
  authorizeDns,
  type DnsToken,
  makeDnsClient,
  makeDnsPolicyLive,
} from "./DnsBinding.ts";

/** List-records request, minus the zone id (bound at `.bind(zone)` time). */
export type ListRecordsRequestInput = Omit<ListRecordsRequest, "zoneId">;

/**
 * Read-only DNS record operations. Backed by the `DNS Read` permission group.
 * The zone is fixed when the client is bound, so no `zoneId` is passed per call.
 */
export interface DnsReadClient {
  /** Fetch a single DNS record by id. */
  getDnsRecord(
    dnsRecordId: string,
  ): Effect.Effect<GetRecordResponse, GetRecordError, RuntimeContext>;
  /** List the DNS records in the bound zone. */
  listDnsRecords(
    request?: ListRecordsRequestInput,
  ): Effect.Effect<ListRecordsResponse, ListRecordsError, RuntimeContext>;
}

/** Build the read-only client over a bound token and zone id. */
export const dnsReadClient = (
  token: DnsToken,
  zoneId: Effect.Effect<string>,
): DnsReadClient => {
  const authorize = authorizeDns(token);
  return {
    getDnsRecord: Effect.fn("Cloudflare.Dns.getDnsRecord")(
      function* (dnsRecordId) {
        return yield* authorize(
          dns.getRecord({ zoneId: yield* zoneId, dnsRecordId }),
        );
      },
    ),
    listDnsRecords: Effect.fn("Cloudflare.Dns.listDnsRecords")(
      function* (request) {
        return yield* authorize(
          dns.listRecords({ zoneId: yield* zoneId, ...request }),
        );
      },
    ),
  };
};

/**
 * Binding that lets a Worker read Cloudflare DNS records at runtime.
 *
 * Creates a least-privilege {@link AccountApiToken} with only the `DNS Read`
 * permission, scoped to the single zone passed to `bind`, and binds its value
 * into the Worker so runtime code can authenticate.
 *
 * @binding
 *
 * @section Reading DNS records at runtime
 * @example Read records from inside a Worker
 * Bind the client in the Worker's Init phase and provide {@link DnsReadLive}.
 * The zone is fixed by `.bind(zone)` — the provisioned token only grants
 * access to that zone, so calls take no `zoneId`. Pass the {@link Zone}
 * resource directly (it's an `Effect`), or `yield* Zone` for a resolved value.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const Zone = Cloudflare.Zone("MyZone", { name: "example.com" });
 *
 * export class DnsReaderWorker extends Cloudflare.Worker<DnsReaderWorker>()(
 *   "DnsReaderWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Init phase — bind the read client scoped to the zone.
 *     const dns = yield* Cloudflare.DnsRead.bind(Zone);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { result } = yield* dns.listDnsRecords({ type: "A" });
 *         const record = yield* dns.getDnsRecord(result[0].id);
 *         return yield* HttpServerResponse.json({ id: record.id });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.DnsReadLive)),
 * ) {}
 * ```
 */
export class DnsRead extends Binding.Service<
  DnsRead,
  (zone: Zone) => Effect.Effect<DnsReadClient>
>()("Cloudflare.DnsRead") {}

/**
 * Deploy-time policy for {@link DnsRead}. Attaches the `DNS Read` permission to
 * the token via its binding contract.
 */
export class DnsReadPolicy extends Binding.Policy<
  DnsReadPolicy,
  (token: AccountApiToken, zone: Zone) => Effect.Effect<void>
>()("Cloudflare.DnsRead") {}

/** Runtime layer for {@link DnsRead}. */
export const DnsReadLive = Layer.effect(
  DnsRead,
  makeDnsClient(DnsReadPolicy, "DnsReadToken", dnsReadClient),
);

/** Live deploy-time policy layer for {@link DnsReadPolicy}. */
export const DnsReadPolicyLive = makeDnsPolicyLive(
  DnsReadPolicy,
  "Cloudflare.DnsRead",
  ["DNS Read"],
);
