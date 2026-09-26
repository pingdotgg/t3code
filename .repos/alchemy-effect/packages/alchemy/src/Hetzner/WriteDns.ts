import type {
  AddZoneRrsetRecordsError,
  AddZoneRrsetRecordsRequest,
  AddZoneRrsetRecordsResponse,
  ChangeZoneRrsetProtectionError,
  ChangeZoneRrsetProtectionResponse,
  ChangeZoneRrsetTtlError,
  ChangeZoneRrsetTtlResponse,
  RemoveZoneRrsetRecordsError,
  RemoveZoneRrsetRecordsRequest,
  RemoveZoneRrsetRecordsResponse,
  SetZoneRrsetRecordsError,
  SetZoneRrsetRecordsRequest,
  SetZoneRrsetRecordsResponse,
  UpdateZoneRrsetRecordsError,
  UpdateZoneRrsetRecordsRequest,
  UpdateZoneRrsetRecordsResponse,
} from "@distilled.cloud/hetzner/zone_rrset_actions";
import type {
  CreateZoneRrsetError,
  CreateZoneRrsetRequest,
  CreateZoneRrsetResponse,
  DeleteZoneRrsetError,
  DeleteZoneRrsetResponse,
  UpdateZoneRrsetError,
  UpdateZoneRrsetRequest,
  UpdateZoneRrsetResponse,
} from "@distilled.cloud/hetzner/zone_rrsets";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Zone } from "./Zone.ts";

/**
 * Binding that lets runtime code create, update, and delete Hetzner Cloud
 * DNS RRSets.
 *
 * Authenticates with the ambient `HCLOUD_TOKEN`. A read-only token is
 * rejected on these methods as `Forbidden`. The zone is fixed by
 * `WriteDns(zone)` so calls take no zone id. Provide {@link WriteDnsHttp}
 * on the Action / Function Effect.
 *
 * Mutating RRSet endpoints are asynchronous — they return an `action`
 * that must reach `success` before a subsequent read is guaranteed to
 * see the change. Poll with {@link waitForZoneAction}.
 *
 *
 * ### Mutating RRSets at runtime
 * **Example:** Create, replace records, and delete from an Action
 * Bind the client in the Action's Init phase and provide {@link WriteDnsHttp}.
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Hetzner from "alchemy/Hetzner";
 * import * as Effect from "effect/Effect";
 *
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const dns = yield* Hetzner.WriteDns(zone);
 *     return Effect.fn(function* () {
 *       const created = yield* dns.createRecordSet({
 *         name: "app",
 *         type: "A",
 *         records: [{ value: "192.0.2.1" }],
 *         ttl: 300,
 *       });
 *       yield* Hetzner.waitForZoneAction(created.action);
 *       yield* dns.setRecordSetRecords("app", "A", {
 *         records: [{ value: "192.0.2.2" }],
 *       });
 *       yield* dns.deleteRecordSet("app", "A");
 *       return created.rrset.id;
 *     });
 *   }).pipe(Effect.provide(Hetzner.WriteDnsHttp)),
 * );
 * ```
 *
 * @binding
 */
export interface WriteDns extends Binding.Service<
  WriteDns,
  "Hetzner.DNS.WriteDns",
  (zone: Zone) => Effect.Effect<WriteDnsClient>
> {}

export const WriteDns = Binding.Service<WriteDns>("Hetzner.DNS.WriteDns");

/** Create-RRSet request, minus the zone id (bound at `WriteDns(zone)` time). */
export type CreateRecordSetRequestInput = Omit<
  CreateZoneRrsetRequest,
  "id_or_name"
>;

/** Update-RRSet (labels) request, minus the zone id and RRSet identity. */
export type UpdateRecordSetRequestInput = Omit<
  UpdateZoneRrsetRequest,
  "id_or_name" | "rr_name" | "rr_type"
>;

/** Add-records request, minus the zone id and RRSet identity. */
export type AddRecordSetRecordsRequestInput = Omit<
  AddZoneRrsetRecordsRequest,
  "id_or_name" | "rr_name" | "rr_type"
>;

/** Remove-records request, minus the zone id and RRSet identity. */
export type RemoveRecordSetRecordsRequestInput = Omit<
  RemoveZoneRrsetRecordsRequest,
  "id_or_name" | "rr_name" | "rr_type"
>;

/** Set-records request, minus the zone id and RRSet identity. */
export type SetRecordSetRecordsRequestInput = Omit<
  SetZoneRrsetRecordsRequest,
  "id_or_name" | "rr_name" | "rr_type"
>;

/** Update-record-comments request, minus the zone id and RRSet identity. */
export type UpdateRecordSetRecordsRequestInput = Omit<
  UpdateZoneRrsetRecordsRequest,
  "id_or_name" | "rr_name" | "rr_type"
>;

/**
 * Mutating DNS RRSet operations. The zone is fixed when the client is
 * bound, so no `id_or_name` is passed per call.
 */
export interface WriteDnsClient {
  /** Create an RRSet. */
  createRecordSet(
    request: CreateRecordSetRequestInput,
  ): Effect.Effect<
    CreateZoneRrsetResponse,
    CreateZoneRrsetError,
    RuntimeContext
  >;
  /** Overwrite the RRSet's labels (PUT). */
  updateRecordSet(
    name: string,
    type: string,
    request?: UpdateRecordSetRequestInput,
  ): Effect.Effect<
    UpdateZoneRrsetResponse,
    UpdateZoneRrsetError,
    RuntimeContext
  >;
  /** Delete an RRSet by name and type. */
  deleteRecordSet(
    name: string,
    type: string,
  ): Effect.Effect<
    DeleteZoneRrsetResponse,
    DeleteZoneRrsetError,
    RuntimeContext
  >;
  /** Append records to an RRSet (creates the RRSet if it is missing). */
  addRecordSetRecords(
    name: string,
    type: string,
    request: AddRecordSetRecordsRequestInput,
  ): Effect.Effect<
    AddZoneRrsetRecordsResponse,
    AddZoneRrsetRecordsError,
    RuntimeContext
  >;
  /** Remove records from an RRSet (deletes it if it becomes empty). */
  removeRecordSetRecords(
    name: string,
    type: string,
    request: RemoveRecordSetRecordsRequestInput,
  ): Effect.Effect<
    RemoveZoneRrsetRecordsResponse,
    RemoveZoneRrsetRecordsError,
    RuntimeContext
  >;
  /** Replace every record in an existing RRSet. */
  setRecordSetRecords(
    name: string,
    type: string,
    request: SetRecordSetRecordsRequestInput,
  ): Effect.Effect<
    SetZoneRrsetRecordsResponse,
    SetZoneRrsetRecordsError,
    RuntimeContext
  >;
  /** Update comments on existing records. */
  updateRecordSetRecords(
    name: string,
    type: string,
    request: UpdateRecordSetRecordsRequestInput,
  ): Effect.Effect<
    UpdateZoneRrsetRecordsResponse,
    UpdateZoneRrsetRecordsError,
    RuntimeContext
  >;
  /** Change the RRSet TTL. Pass `null` to inherit the zone default. */
  changeRecordSetTtl(
    name: string,
    type: string,
    ttl: number | null,
  ): Effect.Effect<
    ChangeZoneRrsetTtlResponse,
    ChangeZoneRrsetTtlError,
    RuntimeContext
  >;
  /** Enable or disable change protection on the RRSet. */
  changeRecordSetProtection(
    name: string,
    type: string,
    change: boolean,
  ): Effect.Effect<
    ChangeZoneRrsetProtectionResponse,
    ChangeZoneRrsetProtectionError,
    RuntimeContext
  >;
}
