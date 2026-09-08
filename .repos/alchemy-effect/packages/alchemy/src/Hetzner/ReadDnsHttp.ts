import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type DnsAuth, makeHttpDnsBinding } from "./DnsHttp.ts";
import { ReadDns, type ReadDnsClient } from "./ReadDns.ts";

/** Runtime layer for {@link ReadDns}. */
export const ReadDnsHttp = Layer.effect(
  ReadDns,
  Effect.suspend(() =>
    makeHttpDnsBinding({
      makeClient: dnsReadClient,
    }),
  ),
);

/** Build the read-only client over an injectable auth and zone id. */
export const dnsReadClient = (
  auth: DnsAuth,
  zoneId: Effect.Effect<number>,
): ReadDnsClient => {
  const authorize = auth.authorize;
  return {
    getRecordSet: Effect.fn("Hetzner.DNS.getRecordSet")(function* (name, type) {
      return yield* authorize(
        zoneRrsets.getZoneRrset({
          id_or_name: String(yield* zoneId),
          rr_name: name,
          rr_type: type,
        }),
      );
    }),
    listRecordSets: Effect.fn("Hetzner.DNS.listRecordSets")(
      function* (request) {
        return yield* authorize(
          zoneRrsets.listZoneRrsets({
            id_or_name: String(yield* zoneId),
            ...request,
          }),
        );
      },
    ),
  };
};
