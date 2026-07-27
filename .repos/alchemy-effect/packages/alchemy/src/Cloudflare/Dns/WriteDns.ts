import type {
  BatchRecordError,
  BatchRecordRequest,
  BatchRecordResponse,
  CreateRecordError,
  CreateRecordRequest,
  CreateRecordResponse,
  DeleteRecordError,
  DeleteRecordResponse,
  PatchRecordError,
  PatchRecordRequest,
  PatchRecordResponse,
  UpdateRecordError,
  UpdateRecordRequest,
  UpdateRecordResponse,
} from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Zone } from "../Zone/Zone.ts";

/**
 * Binding that lets a Worker create, update, and delete Cloudflare DNS records
 * at runtime.
 *
 * Creates a least-privilege {@link AccountApiToken} with only the `DNS Write`
 * permission, scoped to the single zone passed to `bind`, and binds its value
 * into the Worker so runtime code can authenticate.
 *
 * @binding
 * @product DNS
 * @category Domains & DNS
 *
 * @section Mutating DNS records at runtime
 * @example Create, update, and delete records from inside a Worker
 * Bind the client in the Worker's Init phase and provide {@link WriteDnsBinding}.
 * The zone is fixed by `WriteDnsBinding(zone)` — the provisioned token only grants
 * access to that zone, so calls take no `zoneId`. Pass the {@link Zone}
 * resource directly (it's an `Effect`), or `yield* Zone` for a resolved value.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const Zone = Cloudflare.Zone.Zone("MyZone", { name: "example.com" });
 *
 * export class WriteDnsrWorker extends Cloudflare.Worker<WriteDnsrWorker>()(
 *   "WriteDnsrWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Init phase — bind the write client scoped to the zone.
 *     const dns = yield* Cloudflare.DNS.WriteDns(Zone);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { result } = yield* dns.createDnsRecord({
 *           type: "A",
 *           name: "app.example.com",
 *           content: "192.0.2.1",
 *           ttl: 1,
 *           proxied: true,
 *         });
 *         yield* dns.updateDnsRecord(result.id, {
 *           type: "A",
 *           name: "app.example.com",
 *           content: "192.0.2.2",
 *           ttl: 1,
 *         });
 *         yield* dns.deleteDnsRecord(result.id);
 *         return yield* HttpServerResponse.json({ id: result.id });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.DNS.WriteDnsBinding)),
 * ) {}
 * ```
 *
 * @example Apply a batch of changes atomically
 * ```typescript
 * yield* dns.batchDnsRecords({
 *   posts: [{ type: "A", name: "a.example.com", content: "192.0.2.1", ttl: 1 }],
 *   deletes: [{ id: oldRecordId }],
 * });
 * ```
 */
export interface WriteDns extends Binding.Service<
  WriteDns,
  "Cloudflare.DNS.WriteDns",
  (zone: Zone) => Effect.Effect<WriteDnsClient>
> {}

export const WriteDns = Binding.Service<WriteDns>("Cloudflare.DNS.WriteDns");

/** Create-record request, minus the zone id (bound at `WriteDnsBinding(zone)` time). */
export type CreateRecordRequestInput = Omit<CreateRecordRequest, "zoneId">;

/** Update-record request, minus the zone id and record id. */
export type UpdateRecordRequestInput = Omit<
  UpdateRecordRequest,
  "zoneId" | "dnsRecordId"
>;

/** Patch-record request, minus the zone id and record id. */
export type PatchRecordRequestInput = Omit<
  PatchRecordRequest,
  "zoneId" | "dnsRecordId"
>;

/** Batch-records request, minus the zone id (bound at `WriteDnsBinding(zone)` time). */
export type BatchRecordRequestInput = Omit<BatchRecordRequest, "zoneId">;

/**
 * Mutating DNS record operations. Backed by the `DNS Write` permission group.
 * The zone is fixed when the client is bound, so no `zoneId` is passed per call.
 */
export interface WriteDnsClient {
  /** Create a DNS record. */
  createDnsRecord(
    request: CreateRecordRequestInput,
  ): Effect.Effect<CreateRecordResponse, CreateRecordError, RuntimeContext>;
  /** Overwrite (PUT) a DNS record. */
  updateDnsRecord(
    dnsRecordId: string,
    request: UpdateRecordRequestInput,
  ): Effect.Effect<UpdateRecordResponse, UpdateRecordError, RuntimeContext>;
  /** Partially update (PATCH) a DNS record. */
  patchDnsRecord(
    dnsRecordId: string,
    request: PatchRecordRequestInput,
  ): Effect.Effect<PatchRecordResponse, PatchRecordError, RuntimeContext>;
  /** Delete a DNS record by id. */
  deleteDnsRecord(
    dnsRecordId: string,
  ): Effect.Effect<DeleteRecordResponse, DeleteRecordError, RuntimeContext>;
  /** Apply a batch of create / update / patch / delete operations atomically. */
  batchDnsRecords(
    request: BatchRecordRequestInput,
  ): Effect.Effect<BatchRecordResponse, BatchRecordError, RuntimeContext>;
}
