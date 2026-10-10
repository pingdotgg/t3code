import * as zoneRrsetActions from "@distilled.cloud/hetzner/zone_rrset_actions";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type DnsAuth, makeHttpDnsBinding } from "./DnsHttp.ts";
import { WriteDns, type WriteDnsClient } from "./WriteDns.ts";

/** Runtime layer for {@link WriteDns}. */
export const WriteDnsHttp = Layer.effect(
  WriteDns,
  Effect.suspend(() =>
    makeHttpDnsBinding({
      makeClient: dnsWriteClient,
    }),
  ),
);

/** Build the write client over an injectable auth and zone id. */
export const dnsWriteClient = (
  auth: DnsAuth,
  zoneId: Effect.Effect<number>,
): WriteDnsClient => {
  const authorize = auth.authorize;
  return {
    createRecordSet: Effect.fn("Hetzner.DNS.createRecordSet")(
      function* (request) {
        return yield* authorize(
          zoneRrsets.createZoneRrset({
            id_or_name: String(yield* zoneId),
            ...request,
          }),
        );
      },
    ),
    updateRecordSet: Effect.fn("Hetzner.DNS.updateRecordSet")(
      function* (name, type, request) {
        return yield* authorize(
          zoneRrsets.updateZoneRrset({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
            ...request,
          }),
        );
      },
    ),
    deleteRecordSet: Effect.fn("Hetzner.DNS.deleteRecordSet")(
      function* (name, type) {
        return yield* authorize(
          zoneRrsets.deleteZoneRrset({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
          }),
        );
      },
    ),
    addRecordSetRecords: Effect.fn("Hetzner.DNS.addRecordSetRecords")(
      function* (name, type, request) {
        return yield* authorize(
          zoneRrsetActions.addZoneRrsetRecords({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
            ...request,
          }),
        );
      },
    ),
    removeRecordSetRecords: Effect.fn("Hetzner.DNS.removeRecordSetRecords")(
      function* (name, type, request) {
        return yield* authorize(
          zoneRrsetActions.removeZoneRrsetRecords({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
            ...request,
          }),
        );
      },
    ),
    setRecordSetRecords: Effect.fn("Hetzner.DNS.setRecordSetRecords")(
      function* (name, type, request) {
        return yield* authorize(
          zoneRrsetActions.setZoneRrsetRecords({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
            ...request,
          }),
        );
      },
    ),
    updateRecordSetRecords: Effect.fn("Hetzner.DNS.updateRecordSetRecords")(
      function* (name, type, request) {
        return yield* authorize(
          zoneRrsetActions.updateZoneRrsetRecords({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
            ...request,
          }),
        );
      },
    ),
    changeRecordSetTtl: Effect.fn("Hetzner.DNS.changeRecordSetTtl")(
      function* (name, type, ttl) {
        return yield* authorize(
          zoneRrsetActions.changeZoneRrsetTtl({
            id_or_name: String(yield* zoneId),
            rr_name: name,
            rr_type: type,
            ttl,
          }),
        );
      },
    ),
    changeRecordSetProtection: Effect.fn(
      "Hetzner.DNS.changeRecordSetProtection",
    )(function* (name, type, change) {
      return yield* authorize(
        zoneRrsetActions.changeZoneRrsetProtection({
          id_or_name: String(yield* zoneId),
          rr_name: name,
          rr_type: type,
          change,
        }),
      );
    }),
  };
};
